/**
 * A compaction, as a rule across the transcript.
 *
 * Compaction is a boundary in the conversation, not something anyone said, so
 * it is drawn as one. It used to be two messages: an assistant line announcing
 * it and a `/compact` bubble on the user's side, neither of which either party
 * wrote — and after a finished turn the announcement read as Claude stalling
 * mid-task.
 *
 * The CLI says nothing while it works and reports only at the end, with the size
 * it summarised. So the running state claims what is known — the size going in
 * and the time so far — and the sweep along the rule says "still going" without
 * pretending to a percentage.
 */
import React, { useEffect, useState } from 'react'
import { FoldVertical, LoaderCircle } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'

export type CompactionInput = {
  trigger: 'auto' | 'manual'
  status: 'running' | 'done' | 'failed'
  startedAt: number
  /** The context going in: what the chat held when it started, or what the CLI reports. */
  tokens?: number
  durationMs?: number
  /** How full the context was when Nyra triggered it. */
  fillPct?: number
  /** Triggered by Nyra between turns, so the turn above had finished. */
  afterTurn?: boolean
}

/** 905k, 1.2M. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** 0:42 while it runs. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 42s, 1m 31s once it is done. */
function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

export default function CompactionDivider({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const input = message.input as unknown as CompactionInput
  const running = input.status === 'running'
  const failed = input.status === 'failed'
  const now = useNow(running)

  const title = running
    ? 'Compacting context'
    : failed
      ? 'Compaction failed'
      : input.trigger === 'auto'
        ? 'Context compacted automatically'
        : 'Context compacted'

  const size = input.tokens ? `${compactTokens(input.tokens)} tokens` : null
  const meta = running
    ? [size, clock(now - input.startedAt)]
    : [
        input.fillPct !== undefined && !failed ? `${Math.round(input.fillPct)}% full` : null,
        [size, input.durationMs !== undefined ? `in ${took(input.durationMs)}` : null].filter(Boolean).join(' ') || null
      ]

  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <Rule running={running} side="left" />
        <div className="flex min-w-0 shrink items-center gap-2">
          {running ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <FoldVertical className={`size-3.5 shrink-0 ${failed ? 'text-danger' : 'text-muted-foreground'}`} />
          )}
          <span
            className={`shrink-0 text-c-sm font-medium ${
              running ? 'text-foreground' : failed ? 'text-danger' : 'text-muted-foreground'
            }`}
          >
            {title}
          </span>
          <span className="min-w-0 truncate text-c-sm text-muted-foreground tabular-nums">
            {meta.filter(Boolean).join(' · ')}
          </span>
        </div>
        <Rule running={running} side="right" />
      </div>
      {input.status === 'done' && input.afterTurn && (
        <p className="mt-1.5 text-center text-c-xs text-muted-foreground">
          Claude had wrapped up — no tasks left to pick up.
        </p>
      )}
    </div>
  )
}

/** One half of the rule. While running, a bright segment travels in toward the label. */
function Rule({ running, side }: { running: boolean; side: 'left' | 'right' }): React.JSX.Element {
  return (
    <div className="relative h-px min-w-6 flex-1 overflow-hidden bg-border">
      {running && <span className={`nyra-compact-sweep nyra-compact-sweep-${side}`} />}
    </div>
  )
}
