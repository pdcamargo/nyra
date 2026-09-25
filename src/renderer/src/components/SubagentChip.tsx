/**
 * Subagents Claude spawned, as one line in the transcript.
 *
 * They used to appear only in the pinned summary, which left the transcript
 * silent for however long they ran — nothing said work had started, so it read
 * as nothing happening at all. The line is the announcement; the subagents tab
 * is still where you watch one, and clicking goes to the same place a row in
 * the pinned summary does.
 */
import React from 'react'
import type { ToolCallMessage } from '../store/sessions'
import { useSessionsStore } from '../store/sessions'
import { openSubagentsInPanel } from '../lib/openFile'

/** Warm first, so a lone subagent gets the Claude clay. */
const SPARK_TINTS = ['#D97757', '#6A9BCC', '#788C5D', '#C46686', '#CC9B4A']

/**
 * Claude's spark: uneven rays from a common centre. Drawn once at module load —
 * the jitter is fixed so every spark in the app is the same shape.
 */
const SPARK_RAYS = Array.from({ length: 11 }, (_, i) => {
  const angle = (i / 11) * Math.PI * 2 + (i % 3) * 0.06
  const length = 8.5 + ((i * 7) % 4) * 0.9
  const x = 12 + Math.cos(angle) * length
  const y = 12 + Math.sin(angle) * length
  return `M12 12L${x.toFixed(2)} ${y.toFixed(2)}`
}).join('')

function Spark({ color, className }: { color: string; className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d={SPARK_RAYS} stroke={color} strokeWidth={2.6} strokeLinecap="round" fill="none" />
    </svg>
  )
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export default function SubagentChip({ messages }: { messages: ToolCallMessage[] }): React.JSX.Element | null {
  const agents = useSessionsStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    return session?.agents
  })
  if (messages.length === 0) return null

  // The session's agent list is the truth about status — a background agent's
  // tool call returns the moment it is launched, long before it is finished.
  const rows = messages.map((m) => {
    const agent = agents?.find((a) => a.toolId === m.tool_id)
    const name = agent?.name ?? String(m.input.description ?? 'Subagent')
    const status = agent?.status ?? (m.result === undefined ? 'running' : 'done')
    return { toolId: m.tool_id, name, status }
  })

  const running = rows.some((r) => r.status === 'running')
  const allFailed = rows.every((r) => r.status === 'failed')
  const names = joinNames(rows.map((r) => r.name))
  const verb = running ? 'started working' : allFailed ? 'failed' : 'finished'
  const textClass = running ? 'nyra-shimmer' : allFailed ? 'text-danger' : 'text-muted-foreground'

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => openSubagentsInPanel(rows.length === 1 ? rows[0].toolId : null)}
        title={`${names} ${verb}`}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <span className="flex shrink-0 items-center gap-0.5">
          {rows.slice(0, 3).map((r, i) => (
            <Spark
              key={r.toolId}
              color={SPARK_TINTS[i % SPARK_TINTS.length]}
              className={`size-3.5 ${r.status === 'running' ? 'nyra-breathe' : ''}`}
            />
          ))}
        </span>
        <span className={`min-w-0 truncate text-c-sm ${textClass}`}>
          {names} {verb}
        </span>
      </button>
    </div>
  )
}
