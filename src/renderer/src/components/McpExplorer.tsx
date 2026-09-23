import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  KeyRound,
  Plug,
  RefreshCw,
  RotateCw,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import { useSessionsStore, type McpServerInfo } from '../store/sessions'
import { isSessionRunning, useRunningStore } from '../store/running'
import { useMcpHealthStore } from '../store/mcpHealth'
import { homedir } from '../lib/homedir'
import type { McpEntry, McpHealthEntry, McpInspection, McpToggleResult } from '../lib/api-types'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * The MCP servers this project can reach, and what each one exposes.
 *
 * One component with two homes: the composer's dock, where it is part of the
 * composer rather than a panel next to it, and Settings, where it is the only
 * thing on the page. Both read the same list and the same detail, so a server
 * cannot look connected in one place and failed in the other.
 *
 * The shape is a list and then the thing you picked, one column the whole way —
 * not a rail with a pane beside it. A server's own information is four short
 * rows and a tool list; giving it half a narrow panel would leave the other
 * half empty on every server, and the composer dock has no width to spare.
 */

/** Stable empty array — a fresh one per call re-renders forever. */
const EMPTY_MCP: McpServerInfo[] = []
const EMPTY_HEALTH: McpHealthEntry[] = []

type McpToolInfo = Extract<McpInspection, { ok: true }>['tools'][number]

export type McpExplorerProps = {
  /**
   * `composer` draws no frame of its own — the composer's own border is the
   * frame. `settings` is the same content with no card around it either, which
   * is what the pane wants.
   */
  variant?: 'composer' | 'settings'
  /** Defaults to the active chat's project directory. */
  cwd?: string
  /** Renders a close button when the dock opened this. */
  onClose?: () => void
  className?: string
}

type Row = McpEntry & {
  status: McpServerInfo['status']
  tools: string[]
  /** A status from Claude's init event, rather than an unopened config row. */
  liveStatus?: boolean
  /** A status from `claude mcp list` instead — what a chat here would get,
   *  asked before any chat started one. The chat's own report replaces it. */
  checked?: boolean
  /** Why a checked server is not connected, in the CLI's words. */
  detail?: string
  /**
   * True for a server the session has that no config file names — a server a
   * plugin ships, a claude.ai connector, or Nyra's own browser and app tools.
   * It is real and running, so it belongs on the list; it has no config to
   * inspect, so it does not get the controls that read one.
   */
  sessionOnly?: boolean
}

export default function McpExplorer({
  variant = 'settings',
  cwd,
  onClose,
  className = ''
}: McpExplorerProps): React.JSX.Element {
  const activeCwd = useSessionsStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId)?.cwd ?? ''
  )
  const liveServers = useSessionsStore((state) => {
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId)
    return session?.mcpServers ?? EMPTY_MCP
  })
  // Outside a chat, the global scope: what a chat in no project would reach.
  const configuredAt = cwd ?? (activeCwd || homedir())
  const health = useMcpHealthStore((state) => state.byCwd[configuredAt])
  const checkedServers = health?.servers ?? EMPTY_HEALTH
  const checking = health?.loading === true

  // Opening the list is the moment a stale check is worth redoing.
  useEffect(() => {
    useMcpHealthStore.getState().warm(configuredAt)
  }, [configuredAt])

  const [entries, setEntries] = useState<McpEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!configuredAt) {
      setEntries([])
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    void window.api.mcp
      .list(configuredAt)
      .then((result) => {
        if (live) setEntries(result ?? [])
      })
      .catch(() => {
        if (live) setEntries([])
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [configuredAt])

  useEffect(() => reload(), [reload])

  /**
   * Config tells us what exists; the session tells us what is actually running.
   * Neither is the whole list. A configured server that this chat has not
   * started is a pending row, and a running server with no config behind it —
   * a plugin's, a connector's, one of Nyra's own — is a row too. Dropping the
   * second kind would hide exactly the servers a person is looking for.
   */
  const rows: Row[] = useMemo(() => {
    const statusByName = new Map(liveServers.map((server) => [server.name, server]))
    const checkedByName = new Map(checkedServers.map((server) => [server.name, server]))
    const out: Row[] = entries.map((entry) => {
      const live = statusByName.get(entry.name)
      const checked = live ? undefined : checkedByName.get(entry.name)
      return {
        ...entry,
        status: entry.disabled ? 'pending' : (live?.status ?? checked?.status ?? 'pending'),
        tools: live?.tools ?? [],
        liveStatus: Boolean(live),
        checked: Boolean(checked),
        detail: checked?.detail
      }
    })
    const known = new Set(out.map((row) => row.name))
    for (const live of liveServers) {
      if (known.has(live.name)) continue
      out.push({
        name: live.name,
        transport: live.url ? 'http' : 'stdio',
        scope: 'global',
        command: live.command,
        args: live.args,
        url: live.url,
        status: live.status,
        tools: live.tools ?? [],
        liveStatus: true,
        sessionOnly: true
      })
      known.add(live.name)
    }
    // Servers the check found that no config file here names: claude.ai
    // connectors and plugin servers. Once a chat reports, it names them itself.
    for (const checked of checkedServers) {
      if (known.has(checked.name)) continue
      out.push({
        name: checked.name,
        scope: 'global',
        source: checked.name.startsWith('claude.ai ')
          ? 'claude.ai connector'
          : checked.name.startsWith('plugin:')
            ? 'Plugin'
            : undefined,
        status: checked.status,
        tools: [],
        checked: true,
        detail: checked.detail,
        sessionOnly: true
      })
    }
    return out
  }, [entries, liveServers, checkedServers])

  const connected = rows.filter((row) => row.status === 'connected').length
  const failed = rows.filter((row) => row.status === 'failed').length
  const selectedRow = rows.find((row) => row.name === selected) ?? null

  // The dock sits inside the composer's own padded box, so it asks for less of
  // its own room; Settings is a full pane and can breathe.
  const compact = variant === 'composer'
  const frame = 'flex min-h-0 flex-col'

  if (selectedRow) {
    return (
      <div className={`${frame} ${className}`}>
        <ServerDetail
          server={selectedRow}
          cwd={configuredAt}
          compact={compact}
          onBack={() => setSelected(null)}
          onChanged={reload}
          summary={{ connected, failed }}
        />
      </div>
    )
  }

  return (
    <div className={`${frame} ${className}`}>
      <div className={`flex items-center gap-2 ${compact ? 'px-2 pb-1 pt-1' : 'px-3 pb-1.5 pt-2.5'}`}>
        <Plug className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-c-md font-medium text-foreground">MCP servers</span>
        <span className="text-c-sm text-muted-foreground">
          {connected > 0 && <span className="text-success">{connected} connected</span>}
          {connected > 0 && failed > 0 && <span> · </span>}
          {failed > 0 && <span className="text-danger">{failed} failed</span>}
          {connected === 0 && failed === 0 && !checking && <span>not connected yet</span>}
          {checking && <span>{connected > 0 || failed > 0 ? ' · checking…' : 'checking…'}</span>}
        </span>
        <span className="flex-1" />
        <ReconnectButton
          notify={setNote}
          scope="every server in this chat"
          hasStarted={liveServers.length > 0}
          cwd={configuredAt}
        />
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close MCP servers"
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto ${compact ? 'px-1.5 pb-1.5' : 'px-2 pb-2'}`}>
        {note && <p className="px-1 pb-1 text-c-sm text-muted-foreground">{note}</p>}
        {(loading || checking) && rows.length === 0 ? (
          <p className="px-1 py-2 text-c-sm text-muted-foreground">
            {loading ? 'Reading configuration…' : 'Checking servers…'}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-2 text-c-sm text-muted-foreground">
            No MCP servers are configured for this project.
          </p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.name}>
                <ServerRow
                  row={row}
                  checking={checking}
                  onSelect={() => setSelected(row.name)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Restart the chat's Claude process, which is what actually reconnects a
 * server: MCP servers are children of that process, so disposing it takes them
 * down and the next turn starts them again against the same conversation.
 *
 * Two things this deliberately does not do. It does not use `restartSession`,
 * which clears `claudeSessionId` — a reconnect that forgot what the chat was
 * doing is not a reconnect. And it does not dispose a session that is mid-turn:
 * that would kill a running agent to fix a status dot, so it says so instead
 * and waits for a turn boundary.
 *
 * With no chat open, or one whose servers have not started, there is no process
 * to restart — what is on screen came from `claude mcp list`, so the button runs
 * that again instead.
 */
function ReconnectButton({
  label = 'Reconnect',
  notify,
  scope,
  hasStarted,
  cwd
}: {
  label?: string
  notify: (message: string) => void
  /** What the control acts on, said out loud — "every server in this chat". */
  scope: string
  hasStarted: boolean
  /** Where the ahead-of-time check runs, when there is no chat to restart. */
  cwd: string
}): React.JSX.Element {
  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  // Subscribed, not read once: the spinner lives in the running store, and a
  // control that stays disabled after the turn ends is worse than no control.
  const running = useRunningStore((state) =>
    activeSessionId ? state.running[activeSessionId] === true : false
  )
  const checking = useMcpHealthStore((state) => state.byCwd[cwd]?.loading === true)
  const recheck = !activeSessionId || !hasStarted

  const reconnect = useCallback(async () => {
    const sessionId = useSessionsStore.getState().activeSessionId
    if (!sessionId || !hasStarted) {
      useMcpHealthStore.getState().warm(cwd, 0)
      return
    }
    if (isSessionRunning(sessionId)) {
      notify('This chat is mid-turn. Stop it, then reconnect.')
      return
    }
    try {
      await window.api.claude.dispose(sessionId)
      notify(`Restarted. ${scope} reconnect on your next message.`)
    } catch (error) {
      notify(`Could not restart this chat: ${String(error)}`)
    }
  }, [cwd, hasStarted, notify, scope])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void reconnect()}
          disabled={recheck ? checking : running}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-c-sm text-info transition-colors hover:bg-info/10 disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <RotateCw className={`size-3 ${recheck && checking ? 'animate-spin' : ''}`} />
          {recheck ? 'Check again' : label}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {recheck
          ? 'Ask Claude Code again which of these servers connect. A chat starts its own when you send a message.'
          : running
          ? 'This chat is working. Stop the turn before restarting its servers.'
          : `Restart this chat's Claude process so ${scope} reconnect. The conversation is kept.`}
      </TooltipContent>
    </Tooltip>
  )
}

function statusColour(status: McpServerInfo['status']): string {
  if (status === 'connected') return 'bg-success'
  if (status === 'failed') return 'bg-danger'
  return 'bg-warning'
}

/** The second line of a row: what state it is in, or where it comes from. */
function rowCaption(row: Row, checking: boolean): string {
  if (row.disabled) return 'Disabled in this project'
  if (row.status === 'needs-auth') return 'Needs authentication'
  if (row.status === 'failed' && row.detail) return row.detail
  if (row.liveStatus && row.status === 'pending') return 'Waiting to connect'
  // Mid-check, a row with no answer yet says where it is from, like any other.
  // The header already says a check is running; saying it again on every row
  // was a column of the same word.
  if (!row.liveStatus && !row.checked && !checking) {
    return 'Not started · connects with the next message'
  }
  return row.source || row.scope || 'Configured'
}

function ServerRow({
  row,
  checking,
  onSelect
}: {
  row: Row
  checking: boolean
  onSelect: () => void
}): React.JSX.Element {
  const toolCount = row.tools.length
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent/60"
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          checking && !row.liveStatus && !row.checked ? 'bg-muted-foreground' : statusColour(row.status)
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-c-md text-foreground/90">{row.name}</span>
        <span className="block truncate text-c-sm text-muted-foreground">
          {rowCaption(row, checking)}
        </span>
      </span>
      {toolCount > 0 && (
        <span className="shrink-0 font-mono text-c-xs text-muted-foreground">{toolCount}</span>
      )}
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}

/** One truth about the server, on one line. */
function MetaRow({
  icon,
  label,
  children
}: {
  icon?: React.ReactNode
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="flex w-24 shrink-0 items-center gap-1 pt-px text-c-sm text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  )
}

function ServerDetail({
  server,
  cwd,
  compact,
  summary,
  onBack,
  onChanged
}: {
  server: Row
  cwd: string
  compact: boolean
  summary: { connected: number; failed: number }
  onBack: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [inspection, setInspection] = useState<McpInspection | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [openTool, setOpenTool] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const inspect = useCallback(() => {
    if (!cwd) return
    setInspecting(true)
    setNote(null)
    void window.api.mcp
      .inspect(cwd, server.name)
      .then((result) => setInspection(result))
      .catch((error) => setInspection({ ok: false, error: String(error) }))
      .finally(() => setInspecting(false))
  }, [cwd, server.name])

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!cwd) return
      setNote(null)
      void window.api.mcp
        .setEnabled(cwd, server.name, enabled)
        .then((result: McpToggleResult) => {
          if (!result.ok) setNote(result.error)
          onChanged()
        })
        .catch((error) => setNote(String(error)))
    },
    [cwd, onChanged, server.name]
  )

  const command = server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  const credentialKeys = [...(server.envKeys ?? []), ...(server.headerKeys ?? [])]
  const projectScoped = server.scope === 'project'
  // A server the session has but no config file names. Its tools are real and
  // already known; there is nothing on disk to inspect.
  const sessionOnly = server.sessionOnly ?? false

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to servers"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>All servers</TooltipContent>
        </Tooltip>
        <span className={`size-1.5 shrink-0 rounded-full ${statusColour(server.status)}`} />
        <span className="min-w-0 flex-1 truncate text-c-md font-medium text-foreground">
          {server.name}
        </span>
        <StatusChip status={server.status} disabled={server.disabled} liveStatus={server.liveStatus} />
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto ${compact ? 'px-2 pb-2' : 'px-3 pb-3'}`}>
        <div className="border-b border-separator pb-2">
          <MetaRow label="Source">
            {server.source ||
              (sessionOnly
                ? server.liveStatus
                  ? 'Provided to this chat'
                  : 'A connector or plugin'
                : 'Not configured here')}
          </MetaRow>
          {server.detail && (
            <MetaRow icon={<AlertCircle className="size-3" />} label="Status">
              <span className="text-c-sm text-foreground/80">{server.detail}</span>
            </MetaRow>
          )}
          {/* A row only the check knows about has no config to say how it
              connects, and guessing stdio would be wrong for every connector. */}
          {!(sessionOnly && !server.liveStatus) && (
            <MetaRow icon={<Plug className="size-3" />} label="Transport">
              <span className="font-mono text-c-sm text-foreground/80">
                {server.transport ?? 'stdio'}
              </span>
              {projectScoped && (
                <span className="ml-1.5 text-c-sm text-muted-foreground">
                  · disable applies to this project
                </span>
              )}
            </MetaRow>
          )}
          {command && (
            <MetaRow icon={<Terminal className="size-3" />} label="Command">
              <span className="font-mono text-c-sm text-foreground/80" title={command}>
                {command}
              </span>
            </MetaRow>
          )}
          {credentialKeys.length > 0 && (
            <MetaRow icon={<KeyRound className="size-3" />} label="Credentials">
              <span className="font-mono text-c-sm text-muted-foreground">
                {credentialKeys.join(', ')}
              </span>
            </MetaRow>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 py-2">
          {!sessionOnly && (
            <button
              type="button"
              onClick={inspect}
              className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-c-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Wrench className="size-3" />
              {inspection?.ok ? 'Refresh tools' : 'View tools'}
            </button>
          )}
          {projectScoped && (
            <button
              type="button"
              onClick={() => setEnabled(Boolean(server.disabled))}
              className="rounded-md border border-border bg-muted/40 px-2 py-1 text-c-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              {server.disabled ? 'Enable here' : 'Disable here'}
            </button>
          )}
          <ReconnectButton
            label="Reconnect all"
            notify={setNote}
            scope="every server in this chat"
            hasStarted={server.liveStatus === true}
            cwd={cwd}
          />
        </div>

        {note && (
          <p className={`pb-2 text-c-sm ${note.startsWith('Could not') ? 'text-danger' : 'text-info'}`}>
            {note}
          </p>
        )}

        {!server.disabled && server.status === 'pending' && !note && (
          <p className="pb-2 text-c-sm text-muted-foreground">
            {server.liveStatus
              ? 'Claude is waiting for this server to connect. Reconnect to retry on the next message.'
              : 'Claude has not started this server yet. It connects when you send a message.'}
          </p>
        )}

        {inspecting && <p className="py-1 text-c-sm text-muted-foreground">Asking the server…</p>}

        {!inspecting && inspection && !inspection.ok && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2">
            <div className="flex items-start gap-1.5">
              <AlertCircle className="mt-px size-3.5 shrink-0 text-danger" />
              <p className="min-w-0 flex-1 text-c-sm text-danger">{inspection.error}</p>
            </div>
            <button
              type="button"
              onClick={inspect}
              className="mt-1.5 flex items-center gap-1 text-c-sm text-foreground/80 transition-colors hover:text-foreground"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          </div>
        )}

        {!inspecting && inspection?.ok && (
          <div>
            <p className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {inspection.tools.length} tool{inspection.tools.length === 1 ? '' : 's'}
            </p>
            <ul className="flex flex-col">
              {inspection.tools.map((tool) => (
                <li key={tool.name}>
                  <ToolRow
                    tool={tool}
                    open={openTool === tool.name}
                    onToggle={() => setOpenTool(openTool === tool.name ? null : tool.name)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {sessionOnly && server.tools.length > 0 && (
          <div>
            <p className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {server.tools.length} tool{server.tools.length === 1 ? '' : 's'} in this chat
            </p>
            <ul className="flex flex-col">
              {server.tools.map((tool) => (
                <li
                  key={tool}
                  className="border-b border-separator-subtle py-1 font-mono text-c-sm text-foreground/85 last:border-b-0"
                >
                  {tool}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!sessionOnly && !inspecting && !inspection && server.tools.length > 0 && (
          <p className="py-1 text-c-sm text-muted-foreground">
            Connected with {server.tools.length} tool{server.tools.length === 1 ? '' : 's'} this
            session. View tools for their descriptions and parameters.
          </p>
        )}

        {summary.failed > 0 && (
          <p className="pt-2 text-c-xs text-muted-foreground">
            {summary.failed} server{summary.failed === 1 ? '' : 's'} in this chat failed to start.
          </p>
        )}
      </div>
    </div>
  )
}

function StatusChip({
  status,
  disabled,
  liveStatus
}: {
  status: McpServerInfo['status']
  disabled?: boolean
  liveStatus?: boolean
}): React.JSX.Element {
  const [label, tone] = disabled
    ? ['Disabled', 'bg-accent text-muted-foreground']
    : status === 'connected'
      ? ['Connected', 'bg-success/15 text-success']
      : status === 'failed'
        ? ['Failed', 'bg-danger/15 text-danger']
      : status === 'needs-auth'
        ? ['Needs auth', 'bg-warning/15 text-warning']
      : [liveStatus ? 'Waiting' : 'Not started', 'bg-warning/15 text-warning']
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-c-xs font-medium ${tone}`}>
      {label}
    </span>
  )
}

/**
 * One tool. Collapsed it is a name; opened it is the full registered name, what
 * it does, and the parameters it takes — which is the whole reason to look.
 */
function ToolRow({
  tool,
  open,
  onToggle
}: {
  tool: McpToolInfo
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="border-b border-separator-subtle last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-1 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-c-sm text-foreground/85">
          {tool.name}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="pb-2 pl-2">
          {tool.description && (
            <p className="text-c-sm text-muted-foreground">{tool.description}</p>
          )}
          {(tool.parameters ?? []).length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {(tool.parameters ?? []).map((parameter) => (
                <span
                  key={parameter.name}
                  className="rounded-[3px] border border-border/60 px-1 py-px font-mono text-c-xs text-muted-foreground"
                  title={`${parameter.name}: ${parameter.type}${parameter.required ? ' (required)' : ''}`}
                >
                  {parameter.name}
                  <span>{parameter.required ? '' : '?'}:{parameter.type}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-c-xs text-muted-foreground">Takes no parameters.</p>
          )}
        </div>
      )}
    </div>
  )
}
