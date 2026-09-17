import React, { useEffect, useState } from 'react'
import { Bot, Square } from 'lucide-react'
import { useBackgroundAgentsStore } from '../store/backgroundAgents'
import { useSessionsStore } from '../store/sessions'
import { useRunningStore } from '../store/running'

/** `1m 24s`, or `14s` under a minute. Seconds only — this is a pulse, not a stopwatch. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`
}

/** Re-render once a second, but only while something is actually running. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/**
 * What is happening right now, above the composer where you are looking.
 *
 * Two things were invisible. A plan being carried out looked identical to an idle
 * app — no sense of how long it had been going. And background subagents outlive
 * the turn that spawned them by minutes, so the turn ends, the spinner stops, and
 * three agents keep working behind a UI that says nothing is happening.
 */
export default function ActivityStrip({
  sessionId,
  onStop
}: {
  sessionId: string | null
  onStop: () => void
}): React.JSX.Element | null {
  const agents = useBackgroundAgentsStore((s) =>
    sessionId ? s.bySession[sessionId] : undefined
  )
  const running = useRunningStore((s) => (sessionId ? s.running[sessionId] === true : false))
  const execution = useSessionsStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId)?.executing : undefined
  )

  const busy = running || (agents?.length ?? 0) > 0
  const now = useTicker(busy)

  if (!busy) return null

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">
          {execution?.title ?? (running ? 'Working' : 'Finishing up')}
        </span>
        {execution && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatElapsed(now - execution.startedAt)}
          </span>
        )}
        <button
          type="button"
          onClick={onStop}
          title="Stop"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Square className="size-3 fill-current" />
        </button>
      </div>

      {(agents?.length ?? 0) > 0 && (
        <ul className="border-t border-border/55 px-2 py-1.5">
          {agents?.map((agent) => (
            <li key={agent.taskId} className="flex items-start gap-2 px-1 py-0.5">
              <Bot className="mt-0.5 size-3 shrink-0 text-info/70" />
              <div className="min-w-0 flex-1">
                <span className="text-xs leading-snug text-foreground/80">
                  {agent.description}
                </span>
                {/* The live line, when the CLI gives one — what it is doing, not
                    what it was asked to do. */}
                {agent.activity && agent.activity !== agent.description && (
                  <p className="mt-0.5 truncate text-[10px] italic text-info/60">
                    {agent.activity}
                  </p>
                )}
              </div>
              {agent.kind && (
                <span className="shrink-0 text-[10px] text-muted-foreground">{agent.kind}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
