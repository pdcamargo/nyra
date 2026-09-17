import React, { useState, useMemo, useEffect, useCallback, Suspense } from 'react'
import { List, RefreshCw, Rows3, Wrench, X } from 'lucide-react'
import { useSessionsStore, type Task, type Agent, type ToolCallMessage, type SessionUsage, type Message, type McpServerInfo } from '../store/sessions'
import { useRateLimitStore, type RateLimitWindow } from '../store/rateLimit'
import { useUiStore } from '../store/ui'
import FileChangelog from './FileChangelog'
import AvailableAgents from './AvailableAgents'

// Lazy so monaco-editor only loads when the Memory tab is opened.
const MemoryTab = React.lazy(() => import('./MemoryTab'))

const EMPTY_AGENTS: Agent[] = []
const EMPTY_TASKS: Task[] = []
const EMPTY_MESSAGES: Message[] = []
const EMPTY_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }

type Tab = 'agents' | 'context' | 'mcp' | 'memory'
const TABS: Tab[] = ['agents', 'context', 'mcp', 'memory']

export default function RightPanel(): React.JSX.Element {
  const activeTab = useUiStore((s) => s.rightPanelTab)
  const setActiveTab = useUiStore((s) => s.setRightPanelTab)

  return (
    <aside className="flex h-full w-64 flex-col bg-card border-l border-border/55">
      {/* Header — matches sidebar and chat header height */}
      <div className="flex items-end border-b border-border/55 px-3 py-2">
        <div className="flex gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground/80 hover:bg-accent/50'
              }`}
            >
              {tab === 'mcp' ? 'MCP' : tab}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === 'agents' && (
          <div className="flex-1 overflow-y-auto p-3">
            <AgentsTab />
          </div>
        )}
        {activeTab === 'context' && (
          <div className="flex-1 overflow-y-auto p-3">
            <ContextTab />
          </div>
        )}
        {activeTab === 'mcp' && (
          <div className="flex-1 overflow-y-auto p-3">
            <McpPanel />
          </div>
        )}
        {activeTab === 'memory' && (
          <Suspense fallback={<div className="p-3 text-[11px] text-muted-foreground/70">Loading…</div>}>
            <MemoryTab />
          </Suspense>
        )}
      </div>
    </aside>
  )
}

function AgentsTab(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <AvailableAgents />
      <div className="h-px bg-accent/50" />
      <AgentTree />
      <div className="h-px bg-accent/50" />
      <TodoList />
    </div>
  )
}

function ContextTab(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <ContextTracker />
      <RateLimitCard />
      <FileChangelog />
    </div>
  )
}

function SectionLabel({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="px-1 mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
      {label}
    </p>
  )
}

function AgentTree(): React.JSX.Element {
  const [viewMode, setViewMode] = useState<'list' | 'timeline'>('list')
  const agents = useSessionsStore((state) => {
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.agents ?? EMPTY_AGENTS
  })

  const doneCount = agents.filter((a) => a.status === 'done').length
  const total = agents.length
  const hasRunning = agents.some((a) => a.status === 'running')
  const orchestratorStatus: AgentNodeStatus = hasRunning ? 'running' : total > 0 ? 'done' : 'idle'

  return (
    <div>
      {total > 0 ? (
        <div className="flex items-center justify-between px-1 mb-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">Agent Tree</p>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground font-mono">{doneCount}/{total} done</span>
            <button
              onClick={() => setViewMode('list')}
              className={`p-0.5 rounded-sm ${viewMode === 'list' ? 'text-foreground/80' : 'text-muted-foreground/70 hover:text-muted-foreground'}`}
              title="List view"
            >
              <List className="size-3" />
            </button>
            <button
              onClick={() => setViewMode('timeline')}
              className={`p-0.5 rounded-sm ${viewMode === 'timeline' ? 'text-foreground/80' : 'text-muted-foreground/70 hover:text-muted-foreground'}`}
              title="Timeline view"
            >
              <Rows3 className="size-3" />
            </button>
          </div>
        </div>
      ) : (
        <SectionLabel label="Agent Tree" />
      )}
      {viewMode === 'list' ? (
        <>
          <AgentNodeRow name="Orchestrator" status={orchestratorStatus} depth={0} />
          {agents.map((agent) => (
            <AgentNodeRow
              key={agent.toolId}
              name={agent.name}
              status={agent.status}
              depth={1}
              meta={agent}
            />
          ))}
        </>
      ) : (
        <TimelineView agents={agents} />
      )}
      {total === 0 && (
        <p className="mt-4 text-[11px] text-muted-foreground/70 text-center">
          Agents appear here during a session
        </p>
      )}
    </div>
  )
}

type AgentNodeStatus = 'running' | 'done' | 'failed' | 'idle'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function AgentNodeRow({
  name,
  status,
  depth,
  meta
}: {
  name: string
  status: AgentNodeStatus
  depth: number
  meta?: Agent
}): React.JSX.Element {
  const statusColors: Record<AgentNodeStatus, string> = {
    running: 'bg-info animate-pulse',
    done: 'bg-success',
    failed: 'bg-danger',
    idle: 'bg-accent'
  }

  const metaParts: string[] = []
  if (meta?.durationMs != null) metaParts.push(formatDuration(meta.durationMs))
  if (meta?.totalTokens != null) metaParts.push(`${(meta.totalTokens / 1000).toFixed(1)}k tok`)

  return (
    <div
      className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50 transition-colors"
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
    >
      {depth > 0 && <span className="text-[10px] text-muted-foreground/70 mt-0.5">└</span>}
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 mt-1 ${statusColors[status]}`} />
      <div className="min-w-0 flex-1">
        <span className="text-xs text-foreground/80">{name}</span>
        {meta?.subagentType && (
          <span className="ml-1.5 text-[10px] text-muted-foreground/70">{meta.subagentType}</span>
        )}
        {metaParts.length > 0 && (
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">{metaParts.join(' · ')}</p>
        )}
      </div>
      {status === 'running' && meta && (
        <button
          onClick={() => window.api.claude.abort(useSessionsStore.getState().activeSessionId ?? undefined)}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-accent text-muted-foreground hover:text-danger transition-all shrink-0 mt-0.5"
          title="Cancel (stops entire session)"
        >
          <X className="size-2.5" />
        </button>
      )}
    </div>
  )
}

function TimelineView({ agents }: { agents: Agent[] }): React.JSX.Element {
  const [tick, setTick] = useState(0)

  const hasRunning = agents.some((a) => a.status === 'running')

  useEffect(() => {
    if (!hasRunning) return undefined
    const intervalId = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(intervalId)
  }, [hasRunning])

  const now = Date.now()
  const timelineStart = Math.min(...agents.map((a) => a.startedAt))
  const timelineEnd = Math.max(
    ...agents.map((a) => {
      if (a.status === 'running') return now
      return a.startedAt + (a.durationMs ?? 0)
    })
  )
  const totalSpan = Math.max(timelineEnd - timelineStart, 1)

  // suppress unused var warning — tick drives re-render
  void tick

  return (
    <div className="space-y-1">
      {agents.map((agent) => {
        const start = agent.startedAt - timelineStart
        const duration =
          agent.status === 'running' ? now - agent.startedAt : (agent.durationMs ?? 0)
        const leftPct = (start / totalSpan) * 100
        const widthPct = Math.max((duration / totalSpan) * 100, 2)

        const barColor =
          agent.status === 'running'
            ? 'bg-info/70'
            : agent.status === 'failed'
              ? 'bg-danger/70'
              : 'bg-success/70'

        const metaParts: string[] = []
        if (duration > 0) metaParts.push(formatDuration(duration))
        if (agent.totalTokens != null)
          metaParts.push(`${(agent.totalTokens / 1000).toFixed(1)}k tok`)

        return (
          <div key={agent.toolId} className="group flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground w-[72px] truncate shrink-0" title={agent.name}>
              {agent.name}
            </span>
            <div className="flex-1 relative h-4">
              <div
                className={`absolute top-0.5 h-3 rounded-xs ${barColor} ${agent.status === 'running' ? 'animate-pulse' : ''}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                title={metaParts.join(' · ') || agent.name}
              />
            </div>
            {agent.status === 'running' && (
              <button
                onClick={() => window.api.claude.abort(useSessionsStore.getState().activeSessionId ?? undefined)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-accent text-muted-foreground hover:text-danger transition-all shrink-0"
                title="Cancel (stops entire session)"
              >
                <X className="size-2.5" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TodoList(): React.JSX.Element {
  const tasks = useSessionsStore((state) => {
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.tasks ?? EMPTY_TASKS
  })

  const completed = tasks.filter((t) => t.status === 'completed').length
  const total = tasks.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0

  if (total === 0) {
    return (
      <div>
        <SectionLabel label="Tasks" />
        <p className="text-[11px] text-muted-foreground/70 text-center mt-4">
          Todo items appear when Claude creates a task list
        </p>
      </div>
    )
  }

  return (
    <div>
      {/* Header + counter */}
      <div className="flex items-center justify-between px-1 mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">Tasks</p>
        <span className="text-[10px] text-muted-foreground font-mono">{completed}/{total} done</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 w-full rounded-full bg-accent mb-3">
        <div
          className="h-1 rounded-full bg-success/60 transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Task list */}
      <div className="space-y-0.5">
        {tasks.map((task) => (
          <TaskItem key={task.taskId} task={task} />
        ))}
      </div>
    </div>
  )
}

function TaskItem({ task }: { task: Task }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const dotClass =
    task.status === 'completed'
      ? 'bg-success'
      : task.status === 'in_progress'
        ? 'bg-info animate-pulse'
        : 'bg-secondary'

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50 transition-colors text-left"
      >
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 mt-1 ${dotClass}`} />
        <div className="min-w-0 flex-1">
          <span
            className={`text-xs leading-snug ${
              task.status === 'completed'
                ? 'text-muted-foreground line-through'
                : 'text-foreground/80'
            }`}
          >
            {task.subject}
          </span>
          {task.status === 'in_progress' && task.activeForm && (
            <p className="text-[10px] italic text-info/60 mt-0.5">{task.activeForm}</p>
          )}
        </div>
      </button>
      {expanded && task.description && (
        <div className="ml-5 mr-2 mb-1 px-2 py-1.5 rounded-sm bg-muted/40 border border-border/55">
          <p className="text-[10px] text-muted-foreground leading-relaxed whitespace-pre-wrap">{task.description}</p>
        </div>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const CONTEXT_LIMIT = 1_000_000
const FILE_TOOL_NAMES = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep'])

function ContextTracker(): React.JSX.Element {
  const usage = useSessionsStore((state) => {
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.usage ?? EMPTY_USAGE
  })

  const messages = useSessionsStore((state) => {
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.messages ?? EMPTY_MESSAGES
  })

  const total = usage.inputTokens + usage.outputTokens
  const pct = Math.min((total / CONTEXT_LIMIT) * 100, 100)
  const barColor = pct > 90 ? 'bg-danger/70' : pct > 70 ? 'bg-warning/60' : 'bg-info/60'

  const files = useMemo(() => {
    const paths = new Set<string>()
    for (const msg of messages) {
      if (msg.role !== 'tool_call') continue
      const tc = msg as ToolCallMessage
      if (!FILE_TOOL_NAMES.has(tc.tool_name)) continue
      const fp = tc.input?.file_path ?? tc.input?.path
      if (typeof fp === 'string' && fp) paths.add(fp)
    }
    return Array.from(paths)
  }, [messages])

  return (
    <div className="space-y-4">
      <div>
        <SectionLabel label="Token Usage" />
        <div className="rounded-lg border border-border/55 bg-muted/40 p-3">
          <div className="flex justify-between text-[11px] mb-2">
            <span className="text-muted-foreground">Used</span>
            <span className="text-foreground/80 font-mono">{formatTokens(total)} / 1M</span>
          </div>
          <div className="h-1 w-full rounded-full bg-accent">
            <div
              className={`h-1 rounded-full transition-all duration-500 ease-out ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {total > 0 && (
            <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground/70">
              <div className="flex justify-between">
                <span>Input</span>
                <span className="font-mono">{formatTokens(usage.inputTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span>Output</span>
                <span className="font-mono">{formatTokens(usage.outputTokens)}</span>
              </div>
              {usage.cacheReadTokens > 0 && (
                <div className="flex justify-between">
                  <span>Cache read</span>
                  <span className="font-mono">{formatTokens(usage.cacheReadTokens)}</span>
                </div>
              )}
              {usage.cacheCreationTokens > 0 && (
                <div className="flex justify-between">
                  <span>Cache write</span>
                  <span className="font-mono">{formatTokens(usage.cacheCreationTokens)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {files.length > 0 && (
        <div className="px-1">
          <p className="text-[10px] text-muted-foreground/70">
            {files.length} file{files.length !== 1 ? 's' : ''} touched
          </p>
        </div>
      )}
    </div>
  )
}

function formatResetTime(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000 - now
  if (ms <= 0) return '0m'
  const mins = Math.ceil(ms / 60_000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function RateLimitBar({ window: w, now }: { window: RateLimitWindow; now: number }): React.JSX.Element {
  const isThrottled = w.status !== 'allowed'
  const resetsInMs = w.resetsAt * 1000 - now
  const totalWindowMs = w.rateLimitType === 'five_hour' ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
  const elapsed = totalWindowMs - resetsInMs
  const pct = isThrottled ? 100 : Math.min(Math.max((elapsed / totalWindowMs) * 100, 0), 100)
  const barColor = isThrottled || pct > 90 ? 'bg-danger/70' : pct > 70 ? 'bg-warning/60' : 'bg-info/60'
  const valColor = isThrottled || pct > 90 ? 'text-danger/80' : pct > 70 ? 'text-warning/70' : 'text-info/60'
  const label = w.rateLimitType === 'five_hour' ? '5-hour window' : '7-day window'

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-mono ${valColor}`}>
          {isThrottled ? 'LIMIT' : `resets ${formatResetTime(w.resetsAt, now)}`}
        </span>
      </div>
      <div className="h-1 w-full rounded-full bg-accent">
        <div
          className={`h-1 rounded-full transition-all duration-500 ease-out ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function RateLimitCard(): React.JSX.Element | null {
  const windows = useRateLimitStore((s) => s.windows)
  const [now, setNow] = useState(Date.now())

  const entries = Object.values(windows)

  useEffect(() => {
    if (entries.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [entries.length])

  if (entries.length === 0) return null

  const anyThrottled = entries.some((w) => w.status !== 'allowed')
  const borderColor = anyThrottled ? 'border-danger/20' : 'border-border/55'
  const bgColor = anyThrottled ? 'bg-danger/4' : 'bg-muted/40'

  return (
    <div>
      <SectionLabel label="Rate Limit" />
      <div className={`rounded-lg border ${borderColor} ${bgColor} p-3 space-y-3`}>
        {entries.map((w) => (
          <RateLimitBar key={w.rateLimitType} window={w} now={now} />
        ))}
        {anyThrottled && (
          <div className="rounded-sm bg-danger/10 px-2 py-1.5 flex items-center gap-1.5">
            <span className="text-[11px]">⏱</span>
            <span className="text-[10px] font-mono text-danger/80">
              Throttled — resets {formatResetTime(entries[0].resetsAt, now)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

type McpConfigEntry = { name: string; command?: string; args?: string[]; url?: string; scope: 'global' | 'project' }

const EMPTY_MCP: McpServerInfo[] = []

function McpPanel(): React.JSX.Element {
  const [configEntries, setConfigEntries] = useState<McpConfigEntry[]>([])
  const cwd = useSessionsStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId)?.cwd ?? '')
  const liveServers = useSessionsStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return session?.mcpServers ?? EMPTY_MCP
  })

  useEffect(() => {
    if (!cwd) return
    window.api.mcp.list(cwd).then((result: McpConfigEntry[]) => setConfigEntries(result)).catch(() => {})
  }, [cwd])

  // Merge live status with static config
  const servers = useMemo(() => {
    const configMap = new Map(configEntries.map((c) => [c.name, c]))
    if (liveServers.length > 0) {
      return liveServers.map((live) => {
        const cfg = configMap.get(live.name)
        return { ...live, command: cfg?.command, args: cfg?.args, url: cfg?.url, scope: cfg?.scope }
      })
    }
    return configEntries.map((cfg) => ({
      name: cfg.name,
      status: 'pending' as const,
      tools: [] as string[],
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      scope: cfg.scope
    }))
  }, [liveServers, configEntries])

  const handleReconnect = useCallback(() => {
    const store = useSessionsStore.getState()
    const sid = store.activeSessionId
    if (!sid) return
    window.api.claude.abort(sid)
    store.restartSession(sid)
    store.addMessage(sid, {
      id: Date.now().toString(),
      role: 'assistant',
      text: 'Session restarted. MCP servers will reconnect on the next message.'
    })
  }, [])

  const connected = servers.filter((s) => s.status === 'connected').length
  const failed = servers.filter((s) => s.status === 'failed').length
  const pending = servers.filter((s) => s.status === 'pending').length

  if (servers.length === 0) {
    return (
      <div>
        <SectionLabel label="MCP Servers" />
        <p className="text-[11px] text-muted-foreground/70 text-center mt-4">No MCP servers configured</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">MCP Servers</p>
        {failed > 0 && (
          <button
            onClick={handleReconnect}
            className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 bg-info/10 hover:bg-info/20 transition-colors"
            title="Restart session to reconnect MCP servers"
          >
            <RefreshCw className="size-2.5 text-info/70" />
            <span className="text-[9px] font-medium text-info/70">Reconnect</span>
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {servers.map((server) => (
          <McpServerCard key={server.name} server={server} />
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground/70 text-center mt-3">
        {connected > 0 && <span className="text-success/50">{connected} connected</span>}
        {connected > 0 && (failed > 0 || pending > 0) && <span> · </span>}
        {failed > 0 && <span className="text-danger/50">{failed} failed</span>}
        {failed > 0 && pending > 0 && <span> · </span>}
        {pending > 0 && <span className="text-warning/50">{pending} pending</span>}
      </p>
    </div>
  )
}

function McpServerCard({ server }: { server: McpServerInfo & { command?: string; args?: string[]; url?: string; scope?: string } }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const statusDot =
    server.status === 'connected' ? 'bg-success'
    : server.status === 'failed' ? 'bg-danger'
    : 'bg-warning animate-pulse'

  const statusBadge =
    server.status === 'connected' ? 'bg-success/15 text-success/70'
    : server.status === 'failed' ? 'bg-danger/15 text-danger/70'
    : 'bg-warning/15 text-warning/70'

  const cmdText = server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')

  return (
    <div className="rounded-lg border border-border/55 bg-muted/40 p-2.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2"
      >
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot}`} />
        <span className="text-xs text-foreground/80 font-medium truncate flex-1 text-left">{server.name}</span>
        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${statusBadge}`}>
          {server.status}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {cmdText && (
            <p className="text-[10px] text-muted-foreground/70 font-mono truncate" title={cmdText}>{cmdText}</p>
          )}
          {server.tools.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <Wrench className="size-2.5 text-muted-foreground/70" />
                <span className="text-[10px] text-muted-foreground/70">{server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="space-y-0.5">
                {server.tools.map((tool) => (
                  <div key={tool} className="flex items-center gap-1.5 px-1">
                    <span className="text-[10px] text-muted-foreground/70">•</span>
                    <span className="text-[10px] text-muted-foreground font-mono truncate">{tool}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {server.tools.length === 0 && server.status === 'failed' && (
            <p className="text-[10px] text-danger/40 italic">Failed to connect — no tools available</p>
          )}
        </div>
      )}
    </div>
  )
}
