import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import McpExplorer from '@renderer/components/McpExplorer'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore, type McpServerInfo } from '@renderer/store/sessions'
import { useRunningStore } from '@renderer/store/running'
import { useMcpHealthStore } from '@renderer/store/mcpHealth'
import type { McpEntry, McpHealthResult, McpInspection } from '@renderer/lib/api-types'

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const SID = 'chat-1'
const CWD = '/repo'

/** The bridge, as the test's own object — setup.ts has no inspect/setEnabled. */
type Bridge = {
  list: (cwd: string) => Promise<McpEntry[]>
  inspect: (cwd: string, name: string) => Promise<McpInspection>
  setEnabled: (cwd: string, name: string, enabled: boolean) => Promise<unknown>
  health: (cwd: string) => Promise<McpHealthResult>
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
  useMcpHealthStore.setState({ byCwd: {} })
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
    setEnabled: vi.fn(async () => ({ ok: true, name: 'github', enabled: true })),
    health: vi.fn(async () => ({ ok: true as const, servers: [] }))
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

// Before a chat has sent anything its servers have no status of their own, and
// every row read "not started". `claude mcp list`, run ahead of time, fills in
// until the chat reports.
describe('the ahead-of-time check', () => {
  it('shows checked statuses, and connectors no config names, before any chat started', async () => {
    bridge.health = vi.fn(async () => ({
      ok: true as const,
      servers: [
        { name: 'github', status: 'connected' as const },
        { name: 'claude.ai Slack', status: 'needs-auth' as const, detail: 'Needs authentication' }
      ]
    }))
    Object.assign(window.api.mcp, bridge)
    seed()
    render(<McpExplorer />)

    expect(await screen.findByText('claude.ai Slack')).toBeInTheDocument()
    expect(screen.getByText('Needs authentication')).toBeInTheDocument()
    expect(screen.getByText('1 connected')).toBeInTheDocument()
    expect(screen.queryByText(/Not started/)).not.toBeInTheDocument()
    expect(bridge.health).toHaveBeenCalledWith(CWD)
  })

  it("lets the chat's own report win over the check", async () => {
    bridge.health = vi.fn(async () => ({
      ok: true as const,
      servers: [{ name: 'github', status: 'failed' as const, detail: 'Connection closed' }]
    }))
    Object.assign(window.api.mcp, bridge)
    seed([connected('github', ['a'])])
    render(<McpExplorer />)

    expect(await screen.findByText('1 connected')).toBeInTheDocument()
    await waitFor(() => expect(bridge.health).toHaveBeenCalled())
    expect(screen.queryByText('Connection closed')).not.toBeInTheDocument()
  })

  it('says it is checking once, in the header, rather than on every row', async () => {
    let finish: (value: McpHealthResult) => void = () => {}
    bridge.health = vi.fn(() => new Promise<McpHealthResult>((resolve) => (finish = resolve)))
    Object.assign(window.api.mcp, bridge)
    seed()
    render(<McpExplorer />)

    expect(await screen.findByText('github')).toBeInTheDocument()
    expect(screen.getAllByText(/checking…/i)).toHaveLength(1)
    // The row says where it comes from, as it would at any other time.
    expect(screen.getByText('~/.claude.json')).toBeInTheDocument()
    expect(screen.queryByText(/Not started/)).not.toBeInTheDocument()
    finish({ ok: true, servers: [{ name: 'github', status: 'connected' }] })
    expect(await screen.findByText('1 connected')).toBeInTheDocument()
  })

  // Last launch's answer is on screen while this launch's check runs, so the
  // list does not open short and then grow by every connector.
  it('shows the last check while the new one runs', async () => {
    bridge.health = vi.fn(() => new Promise<McpHealthResult>(() => {}))
    Object.assign(window.api.mcp, bridge)
    useMcpHealthStore.setState({
      byCwd: {
        [CWD]: {
          servers: [{ name: 'claude.ai Slack', status: 'connected' }],
          checkedAt: null,
          loading: false
        }
      }
    })
    seed()
    render(<McpExplorer />)

    expect(await screen.findByText('claude.ai Slack')).toBeInTheDocument()
    expect(screen.getByText(/checking…/)).toBeInTheDocument()
    // Remembered, not trusted: the launch still asks.
    expect(bridge.health).toHaveBeenCalledWith(CWD)
  })

  // No chat has started these servers, so there is no process to restart. The
  // button asks the CLI again instead of telling you to open a chat.
  it('checks again instead of reconnecting when no chat has started', async () => {
    seed()
    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)
    render(<McpExplorer />)
    await waitFor(() => expect(useMcpHealthStore.getState().byCwd[CWD]?.loading).toBe(false))

    await userEvent.click(await screen.findByRole('button', { name: /Check again/ }))
    await waitFor(() => expect(bridge.health).toHaveBeenCalledTimes(2))
    expect(dispose).not.toHaveBeenCalled()
    expect(screen.queryByText(/Open a chat first/)).not.toBeInTheDocument()
  })

  it('does not ask again while a fresh check is cached', async () => {
    seed()
    const first = render(<McpExplorer />)
    await waitFor(() => expect(bridge.health).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useMcpHealthStore.getState().byCwd[CWD]?.loading).toBe(false))
    first.unmount()
    render(<McpExplorer />)
    expect(await screen.findByText('github')).toBeInTheDocument()
    expect(bridge.health).toHaveBeenCalledTimes(1)
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
