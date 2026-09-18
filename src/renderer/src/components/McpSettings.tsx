import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Wrench } from 'lucide-react'
import { useSessionsStore, type McpServerInfo, newMessageId } from '../store/sessions'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type McpConfigEntry = {
  name: string
  command?: string
  args?: string[]
  url?: string
  scope: 'global' | 'project'
}

/** Stable empty array — a fresh one per call re-renders forever. */
const EMPTY_MCP: McpServerInfo[] = []

/**
 * The MCP servers this project can reach, and what they expose.
 *
 * It was a tab in the right panel, which put a piece of configuration next to
 * things that change every turn. You set a server up once and then forget it,
 * which is what settings are for — and it freed the panel to be one thing.
 */
export default function McpSettings(): React.JSX.Element {
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
      id: newMessageId(),
      role: 'assistant',
      text: 'Session restarted. MCP servers will reconnect on the next message.'
    })
  }, [])

  const connected = servers.filter((s) => s.status === 'connected').length
  const failed = servers.filter((s) => s.status === 'failed').length
  const pending = servers.filter((s) => s.status === 'pending').length

  if (servers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/70">No MCP servers configured</p>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-end px-1">
        {failed > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleReconnect}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 bg-info/10 hover:bg-info/20 transition-colors"
              >
                <RefreshCw className="size-2.5 text-info/70" />
                <span className="text-[9px] font-medium text-info/70">Reconnect</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Restart session to reconnect MCP servers</TooltipContent>
          </Tooltip>
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
