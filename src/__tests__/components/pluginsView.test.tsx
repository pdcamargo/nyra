import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PluginsView from '@renderer/components/views/PluginsView'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore } from '@renderer/store/sessions'
import { useRunningStore } from '@renderer/store/running'
import type {
  AvailablePlugin,
  InstalledPlugin,
  PluginActionRequest,
  PluginActionResult,
  PluginCatalog
} from '@renderer/lib/api-types'

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const CWD = '/repo'

const titleCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1)

function plugin(over: Partial<AvailablePlugin> & { id: string }): AvailablePlugin {
  return {
    name: over.id.split('@')[0],
    displayName: titleCase(over.id.split('@')[0]),
    description: 'Does a thing.',
    marketplace: 'claude-plugins-official',
    category: 'development',
    author: 'Someone',
    homepage: null,
    keywords: [],
    tags: [],
    installCount: 100,
    version: '1.0.0',
    kind: 'plugin',
    verified: true,
    source: './plugins/x',
    components: { skills: 3, commands: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
    tokens: [{ model: 'claude-opus-4-7', alwaysOn: 400, onInvoke: 900 }],
    installed: false,
    enabled: false,
    installedVersion: null,
    installedScope: null,
    ...over
  }
}

const installedPlugin = (over: Partial<InstalledPlugin> & { id: string }): InstalledPlugin => ({
  name: over.id.split('@')[0],
  marketplace: 'claude-plugins-official',
  version: '1.0.0',
  scope: 'user',
  enabled: true,
  installPath: '/Users/x/.claude/plugins/cache/x',
  installedAt: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  description: 'A skill pack.',
  category: 'development',
  author: 'Someone',
  components: { skills: 3, commands: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
  ...over
})

/**
 * A recording bridge.
 *
 * Plain functions rather than `vi.fn` mocks: the call log is what these tests
 * assert on, and a typed array of the requests themselves reads better than
 * `mock.calls[1][0]` — which is also how one test previously read the details
 * request and mistook it for the install.
 */
let catalogResult: PluginCatalog
let actionImpl: (request: PluginActionRequest) => Promise<PluginActionResult>
let catalogCalls: (string | undefined)[]
let actionCalls: PluginActionRequest[]

/** Only the installs. Opening a plugin also asks for its details, through the
 *  same bridge method, and counting those as installs proves nothing. */
const installs = (): PluginActionRequest[] =>
  actionCalls.filter((request) => request.action === 'install')

beforeEach(() => {
  useRunningStore.setState({ running: {}, thinkingSince: {} })
  useSessionsStore.setState({
    activeSessionId: 'chat-1',
    sessions: [{ id: 'chat-1', cwd: CWD, messages: [] }],
    projects: [{ id: 'p1', name: 'nyra', path: CWD, order: 0 }]
  } as never)

  catalogResult = {
    ok: true,
    binary: '/usr/local/bin/claude',
    installed: [installedPlugin({ id: 'review@claude-plugins-official' })],
    available: [
      plugin({ id: 'asana@claude-plugins-official', kind: 'integration', installCount: 11540 }),
      plugin({ id: 'linear@claude-plugins-official', kind: 'integration', installCount: 52620 }),
      plugin({ id: 'review@claude-plugins-official', installCount: 69928, installed: true, enabled: true, installedVersion: '1.0.0', installedScope: 'user' }),
      plugin({ id: 'tiny@mv', category: 'security', installCount: 3, verified: false, marketplace: 'mv' })
    ],
    marketplaces: [
      {
        name: 'claude-plugins-official',
        source: 'GitHub · anthropics/claude-plugins-official',
        location: '/Users/x/.claude/plugins/marketplaces/claude-plugins-official',
        official: true,
        pluginCount: 309
      }
    ],
    categories: [
      { id: 'development', label: 'Development', count: 3 },
      { id: 'security', label: 'Security', count: 1 }
    ]
  }
  actionImpl = async () => ({ ok: true, result: null, output: 'installed' })
  catalogCalls = []
  actionCalls = []
  Object.assign(window.api, {
    plugins: {
      publicLogos: async () => ({}),
      catalog: async (cwd?: string) => {
        catalogCalls.push(cwd)
        return catalogResult
      },
      action: async (request: PluginActionRequest) => {
        actionCalls.push(request)
        return actionImpl(request)
      }
    }
  })
  vi.restoreAllMocks()
})

describe('the Plugins page', () => {
  it('shows the catalog as two rows, integrations first, with categories beside it', async () => {
    render(<PluginsView />)

    expect(await screen.findByText('Top integrations')).toBeInTheDocument()
    expect(screen.getByText('Top plugins')).toBeInTheDocument()
    expect(await screen.findByText('Asana')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()

    // The rail is the catalog's own categories, with its counts.
    expect(screen.getByText('Development')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install Asana' })).toBeInTheDocument()
  })

  it('filters by search and by category, and sorts by installs by default', async () => {
    render(<PluginsView />)
    await screen.findByText('Top integrations')

    await userEvent.type(screen.getByLabelText('Search plugins'), 'linear')
    expect(screen.getByText('Linear')).toBeInTheDocument()
    expect(screen.queryByText('Asana')).not.toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText('Search plugins'))
    await userEvent.click(screen.getByRole('checkbox', { name: /Security/ }))
    expect(screen.getByText('Tiny')).toBeInTheDocument()
    expect(screen.queryByText('Linear')).not.toBeInTheDocument()
  })

  it('opens a plugin, asks where to install it, and installs to the user scope by default', async () => {
    render(<PluginsView />)
    await userEvent.click(await screen.findByText('Asana'))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveFocus())
    const footer = within(dialog).getByText('Install to').closest('footer')
    expect(footer).not.toBeNull()
    expect(within(footer!).getByRole('button', { name: 'User' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(footer!).getByRole('button', { name: 'Project' })).toBeInTheDocument()
    expect(within(footer!).getByRole('button', { name: 'Local' })).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))
    await waitFor(() =>
      expect(installs()).toEqual([
        { action: 'install', id: 'asana@claude-plugins-official', scope: 'user' }
      ])
    )
  })

  // Claude loads plugins at session start, so an install that says nothing
  // about restarting reads as broken.
  it('says a restart is needed after an install, and offers it', async () => {
    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)
    render(<PluginsView />)
    await userEvent.click(await screen.findByText('Asana'))
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect(await screen.findByText(/Restart this chat/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restart Claude' }))
    await waitFor(() => expect(dispose).toHaveBeenCalledWith('chat-1'))
  })

  it('lists what is installed and can disable it', async () => {
    render(<PluginsView />)
    await screen.findByText('Top integrations')
    await userEvent.click(screen.getByRole('button', { name: /Installed/ }))

    expect(await screen.findByText('review')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }))

    await waitFor(() =>
      expect(actionCalls).toContainEqual({
        action: 'disable',
        id: 'review@claude-plugins-official'
      })
    )
  })

  it('shows where the catalogs come from and adds one', async () => {
    render(<PluginsView />)
    await screen.findByText('Top integrations')
    await userEvent.click(screen.getByRole('button', { name: /Marketplaces/ }))

    expect(await screen.findByText('claude-plugins-official')).toBeInTheDocument()
    expect(screen.getByText('Official')).toBeInTheDocument()

    await userEvent.type(
      screen.getByPlaceholderText(/owner\/repo/),
      'MediaValet/mv-claude-code-plugins'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(actionCalls).toContainEqual({
        action: 'marketplace.add',
        source: 'MediaValet/mv-claude-code-plugins',
        scope: 'user'
      })
    )
  })

  it('shows the failure with a retry rather than an empty catalog', async () => {
    catalogResult = { ok: false, error: 'claude plugin list failed' }
    render(<PluginsView />)

    expect(await screen.findByText('claude plugin list failed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(catalogCalls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('a marketplace that installs by running its own command', () => {
  const shown = {
    ok: false as const,
    needsConfirmation: true as const,
    command: 'curl -sL https://example.com/install.sh | sh',
    sha256: 'deadbeef',
    message: 'This marketplace installs by running a command of its own.'
  }

  /** The bridge, answering by action — opening a plugin asks for details
   *  through the same method, and a mock that ignores that answers the wrong
   *  question. */
  const confirming = (): void => {
    actionImpl = async (request: PluginActionRequest) => {
      if (request.action === 'details') {
        return {
          ok: true as const,
          id: request.id ?? '',
          version: '1.0.0',
          source: './external_plugins/asana',
          components: {
            skills: [],
            commands: [],
            agents: [],
            hooks: [],
            mcpServers: ['asana'],
            lspServers: []
          },
          tokens: [],
          resolved: true
        }
      }
      return request.acceptCommand ? { ok: true as const, result: null, output: 'installed' } : shown
    }
  }

  it('shows the command and its hash, and runs nothing until it is confirmed', async () => {
    confirming()
    render(<PluginsView />)
    await userEvent.click(await screen.findByText('Asana'))
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect(
      await screen.findByText('curl -sL https://example.com/install.sh | sh')
    ).toBeInTheDocument()
    expect(screen.getByText(/sha256 deadbeef/)).toBeInTheDocument()
    // Only the attempt that produced the question has run so far.
    expect(installs()).toHaveLength(1)
  })

  it('passes the hash back on confirmation, and never a blanket yes', async () => {
    confirming()
    render(<PluginsView />)
    await userEvent.click(await screen.findByText('Asana'))
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await screen.findByText(/sha256 deadbeef/)
    await userEvent.click(screen.getByRole('button', { name: /Run it and install/ }))

    await waitFor(() => expect(installs()).toHaveLength(2))
    const second = installs()[1]
    expect(second.acceptCommand).toBe('deadbeef')
    expect(second.action).toBe('install')
    // There is no field for a blanket yes; the hash is the only consent.
    expect(Object.keys(second).sort()).toEqual(['acceptCommand', 'action', 'id', 'scope'])
  })
})
