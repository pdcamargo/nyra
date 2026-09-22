/**
 * What this chat is watching, and therefore what can interrupt it.
 *
 * A monitor is not a shell doing work — it is a standing instruction to come
 * back when something happens: a CI run finishing, a log line appearing, a queue
 * moving. It outlives the turn that armed it and it will start a new turn on its
 * own, which makes it the one background thing you want to know about before you
 * type. Unarmed, the conversation is yours; with three monitors running, it is
 * going to speak up.
 *
 * Nyra could not see these at all until the registry learned to create a row for
 * a `Monitor` tool call — every `task_started` for one arrived, found no row, and
 * was dropped. The same shape as `PortChips` on purpose: same registry, same
 * pill, same place in the composer, because "what this chat has going on" should
 * read as one row of marks rather than as several competing conventions.
 */
import React from 'react'
import { Eye } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useSessionsStore } from '../store/sessions'
import { EMPTY_PROCESSES, useProcessesStore, type BgProcess } from '../store/processes'
import { useUiStore } from '../store/ui'

/** Rows persisted before monitors were tracked have no kind; they were shells. */
export function isMonitor(proc: BgProcess): boolean {
  return proc.kind === 'monitor'
}

/** Every watch this chat currently has armed, oldest first. */
export function liveMonitors(processes: readonly BgProcess[]): BgProcess[] {
  return processes
    .filter((p) => isMonitor(p) && p.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function useMonitors(sessionId: string | null): BgProcess[] {
  const processes = useProcessesStore((s) =>
    sessionId ? (s.bySession[sessionId] ?? EMPTY_PROCESSES) : EMPTY_PROCESSES
  )
  return liveMonitors(processes)
}

/** What a monitor is called, falling back to what it runs. */
export function monitorLabel(proc: BgProcess): string {
  return proc.description?.trim() || proc.command || 'watching'
}

/**
 * The summary is where the list already lives, so the pill opens it rather than
 * growing a panel of its own.
 */
function showTheList(): void {
  useUiStore.getState().setSummaryOpen(true)
}

/** Same bargain as the port pills: past the limit, one pill and a count. */
const INLINE_LIMIT = 2
const INLINE_LIMIT_COMPACT = 1

function MonitorRows({ monitors }: { monitors: readonly BgProcess[] }): React.JSX.Element {
  return (
    <>
      {monitors.map((proc) => (
        <div
          key={proc.shellId}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left"
        >
          <Eye className="size-3.5 shrink-0 text-info" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
            {monitorLabel(proc)}
          </span>
          {proc.command && proc.description && (
            <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[10px] text-muted-foreground">
              {proc.command}
            </span>
          )}
        </div>
      ))}
    </>
  )
}

/** The composer's monitor pills, beside the ports and the PRs. */
export function ComposerMonitorPills({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element | null {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const monitors = useMonitors(activeSessionId)
  if (!activeSessionId || monitors.length === 0) return null

  if (monitors.length > (compact ? INLINE_LIMIT_COMPACT : INLINE_LIMIT)) {
    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground">
              <Eye className="size-3.5 shrink-0 text-info" />
              {monitors.length} watching
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {`${monitors.length} monitors — each one can start a turn on its own`}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-80 p-1.5">
          <MonitorRows monitors={monitors} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      {monitors.map((proc) => (
        <Tooltip key={proc.shellId}>
          <TooltipTrigger
            onClick={showTheList}
            className="flex h-7 max-w-[10rem] items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Eye className="size-3.5 shrink-0 text-info" />
            <span className="truncate">{monitorLabel(proc)}</span>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">
            {`Watching: ${monitorLabel(proc)}\nThis can start a turn on its own.`}
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  )
}
