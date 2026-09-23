import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import McpExplorer from '@renderer/components/McpExplorer'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore, type McpServerInfo } from '@renderer/store/sessions'
import { useRunningStore } from '@renderer/store/running'
import type { McpEntry, McpInspection } from '@renderer/lib/api-types'

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const SID = 'chat-1'
const CWD = '/repo'

/** The bridge, as the test's own object — setup.ts has no inspect/setEnabled. */
type Bridge = {
  list: (cwd: string) => Promise<McpEntry[]>
  inspect: (cwd: string, name: string) => Promise<McpInspection>
  setEnabled: (cwd: string, name: string, enabled: boolean) => Promise<unknown>
}

let bridge: Record<keyof Bridge, ReturnType<typeof vi.fn>>

function seed(servers: McpServerInfo[] = []): void {
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [
      { id: SID, cwd: CWD, messages: [], mcpServers: servers, claudeSessionId: 'claude-9' }
    ],
    projects: []
  } as never)
}

const connected = (name: string, tools: string[] = []): McpServerInfo => ({
  name,
  status: 'connected',
  tools,
  scope: 'global'
})

const entry = (over: Partial<McpEntry> & { name: string }): McpEntry => ({
  transport: 'stdio',
  scope: 'global',
  source: '~/.claude.json',
  envKeys: [],
  headerKeys: [],
  disabled: false,
  ...over
})

beforeEach(() => {
  useRunningStore.setState({ running: {}, thinkingSince: {} })
  seed()
  bridge = {
    list: vi.fn(async () => [entry({ name: 'github', command: 'npx', source: '~/.claude.json' })]),
    inspect: vi.fn(async () => ({
      ok: true as const,
      tools: [
        {
          name: 'create_pull_request',
          description: 'Open a PR.',
          parameters: [{ name: 'title', type: 'string', required: true }],
          inputSchema: null
        }
      ]
    })),
    setEnabled: vi.fn(async () => ({ ok: true, name: 'github', enabled: true }))
  }
  Object.assign(window.api.mcp, bridge)
  vi.restoreAllMocks()
})

describe('the MCP explorer', () => {
  it('lists the servers this project can reach', async () => {
    seed([connected('github', ['a', 'b'])])
    render(<McpExplorer />)
    expect(await screen.findByText('github')).toBeInTheDocument()
    expect(screen.getByText('~/.claude.json')).toBeInTheDocument()
  })

  // The list is config ∪ session. A plugin's server, a connector, or one of
  // Nyra's own has no config file behind it and is still a server this chat is
  // using — dropping it hid exactly the rows somebody opened this to find.
  it('shows a server the session has even when no config names it', async () => {
    seed([connected('nyra-browser', ['browser_navigate', 'browser_snapshot'])])
    render(<McpExplorer />)

    expect(await screen.findByText('nyra-browser')).toBeInTheDocument()
    // And its tool count, which is the only inventory it has.
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('opens one server, and the back arrow returns to the list', async () => {
    seed([connected('github')])
    render(<McpExplorer />)
    await userEvent.click(await screen.findByText('github'))

    expect(screen.getByText('Command')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to servers' }))
    expect(screen.getByText('MCP servers')).toBeInTheDocument()
  })

  // Asking a server for its tools starts it. That is a side effect, not a
  // render, so it must not happen until somebody asks for it.
  it('does not inspect anything until View tools is pressed', async () => {
    seed([connected('github')])
    render(<McpExplorer />)
    await userEvent.click(await screen.findByText('github'))

    expect(bridge.inspect).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /View tools/ }))

    expect(await screen.findByText('create_pull_request')).toBeInTheDocument()
    expect(bridge.inspect).toHaveBeenCalledWith(CWD, 'github')
  })

  it('opens a tool to its description and parameters, required marked', async () => {
    seed([connected('github')])
    render(<McpExplorer />)
    await userEvent.click(await screen.findByText('github'))
    await userEvent.click(screen.getByRole('button', { name: /View tools/ }))

    await userEvent.click(await screen.findByRole('button', { name: /create_pull_request/ }))
    expect(screen.getByText('Open a PR.')).toBeInTheDocument()
    // Required reads as `title:string`; optional would carry the `?`.
    expect(screen.getByTitle('title: string (required)')).toBeInTheDocument()
  })

  it('offers a retry when a server cannot be inspected', async () => {
    bridge.inspect = vi.fn(async () => ({ ok: false as const, error: 'spawn npx ENOENT' }))
    Object.assign(window.api.mcp, bridge)
    seed([connected('github')])
    render(<McpExplorer />)
    await userEvent.click(await screen.findByText('github'))
    await userEvent.click(screen.getByRole('button', { name: /View tools/ }))

    expect(await screen.findByText('spawn npx ENOENT')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(bridge.inspect).toHaveBeenCalledTimes(2)
  })

  // Claude Code only asks a project to decide about `.mcp.json`, so only a
  // project-scoped server has something to disable.
  it('offers disable only for a project-scoped server, and writes the choice', async () => {
    bridge.list = vi.fn(async () => [
      entry({ name: 'github', scope: 'global' }),
      entry({ name: 'sentry', scope: 'project', source: '.mcp.json' })
    ])
    Object.assign(window.api.mcp, bridge)
    seed()
    render(<McpExplorer />)

    await userEvent.click(await screen.findByText('github'))
    expect(screen.queryByRole('button', { name: 'Disable here' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to servers' }))

    await userEvent.click(await screen.findByText('sentry'))
    await userEvent.click(screen.getByRole('button', { name: 'Disable here' }))
    await waitFor(() => expect(bridge.setEnabled).toHaveBeenCalledWith(CWD, 'sentry', false))
  })
})

describe('reconnecting', () => {
  it('restarts the chat and says when the servers come back', async () => {
    bridge.list = vi.fn(async () => [
      entry({ name: 'github' }),
      entry({ name: 'sentry', scope: 'project' })
    ])
    Object.assign(window.api.mcp, bridge)
    seed([
      { ...connected('github'), status: 'connected' },
      { ...connected('sentry'), status: 'failed' }
    ])
    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)

    render(<McpExplorer />)
    await userEvent.click(await screen.findByRole('button', { name: /Reconnect/ }))

    await waitFor(() => expect(dispose).toHaveBeenCalledWith(SID))
    expect(await screen.findByText(/reconnect on your next message/)).toBeInTheDocument()
    // The conversation is kept: clearing the Claude session id is what
    // `restartSession` does, and it is not what a reconnect is.
    expect(useSessionsStore.getState().sessions[0].claudeSessionId).toBe('claude-9')
  })

  // Killing a running agent to refresh a status dot would be a bad trade.
  it('refuses to interrupt a turn in progress', async () => {
    seed([{ ...connected('github'), status: 'failed' }])
    useRunningStore.setState({ running: { [SID]: true }, thinkingSince: {} })
    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)

    render(<McpExplorer />)
    const button = await screen.findByRole('button', { name: /Reconnect/ })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(dispose).not.toHaveBeenCalled()
  })
})
