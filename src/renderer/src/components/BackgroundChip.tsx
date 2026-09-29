/**
 * A backgrounded shell or monitor, as one line in the transcript.
 *
 * `SubagentChip`'s shape for the same problem: the call returns the moment the
 * thing is launched, so as a row in a tool strip it read as finished while it
 * was still running, and the chat looked done. The start line stays where the
 * call was made and shimmers while the registry says it is live; the end is a
 * `BackgroundEnded` line of its own, written where it happened.
 *
 * Clicking opens Processes, which is where its output is.
 */
import React from 'react'
import { Eye, SquareTerminal } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'
import { useSessionsStore } from '../store/sessions'
import { stillRunning, useProcessesStore, type BgProcess } from '../store/processes'
import { useUiStore } from '../store/ui'
import {
  backgroundKindOf,
  backgroundLabel,
  type BackgroundKind,
  type BackgroundOutcome
} from '../lib/backgroundCalls'

/** The start line's words, given what the registry knows about it now. */
export function startText(kind: BackgroundKind, name: string, proc: BgProcess | undefined): string {
  // A server is meant to keep going and will not report back; its port is the news.
  if (kind === 'shell' && proc && proc.ports.length > 0) {
    return `${name} serving ${proc.ports.map((p) => `:${p}`).join(' ')}`
  }
  if (kind === 'monitor') return stillRunning(proc) ? `Watching ${name}` : `Watched ${name}`
  return stillRunning(proc) ? `${name} running in the background` : `${name} ran in the background`
}

export function endText(
  kind: BackgroundKind,
  name: string,
  status: BackgroundOutcome,
  exitCode: number | null
): string {
  if (status === 'failed') return `${name} failed${exitCode !== null ? ` · exit ${exitCode}` : ''}`
  if (kind === 'monitor') return status === 'stopped' ? `Stopped watching ${name}` : `Done watching ${name}`
  return status === 'stopped' ? `${name} was stopped` : `${name} finished`
}

function KindIcon({ kind, className }: { kind: BackgroundKind; className: string }): React.JSX.Element {
  const Icon = kind === 'monitor' ? Eye : SquareTerminal
  return <Icon aria-hidden className={`size-3.5 shrink-0 ${className}`} />
}

function Line({
  kind,
  text,
  live,
  iconClass,
  detail
}: {
  kind: BackgroundKind
  text: string
  live: boolean
  iconClass: string
  detail: string
}): React.JSX.Element {
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => useUiStore.getState().focusProcessesTab()}
        title={detail}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <KindIcon kind={kind} className={`${iconClass} ${live ? 'nyra-breathe' : ''}`} />
        <span className={`min-w-0 truncate text-c-sm ${live ? 'nyra-shimmer' : 'text-muted-foreground'}`}>
          {text}
        </span>
      </button>
    </div>
  )
}

export default function BackgroundChip({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const sid = useSessionsStore((s) => s.activeSessionId)

  if (message.tool_name === 'BackgroundEnded') {
    const kind = message.input.kind === 'monitor' ? 'monitor' : 'shell'
    const status = String(message.input.status) as BackgroundOutcome
    const exitCode = typeof message.input.exitCode === 'number' ? message.input.exitCode : null
    const text = endText(kind, String(message.input.name ?? ''), status, exitCode)
    return (
      <Line
        kind={kind}
        text={text}
        live={false}
        iconClass={status === 'failed' ? 'text-danger' : 'text-muted-foreground'}
        detail={text}
      />
    )
  }

  return <StartLine sid={sid} message={message} />
}

function StartLine({ sid, message }: { sid: string | null; message: ToolCallMessage }): React.JSX.Element {
  const proc = useProcessesStore((s) =>
    sid ? s.bySession[sid]?.find((p) => p.shellId === message.tool_id) : undefined
  )
  const kind = backgroundKindOf(message)
  const name = backgroundLabel(message)
  const serving = kind === 'shell' && !!proc && proc.ports.length > 0
  const live = stillRunning(proc) && !serving
  const command = typeof message.input.command === 'string' ? message.input.command : name
  return (
    <Line
      kind={kind}
      text={startText(kind, name, proc)}
      live={live}
      iconClass={live || serving ? 'text-info' : 'text-muted-foreground'}
      detail={command}
    />
  )
}
