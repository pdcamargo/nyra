import React from 'react'
import { useSessionsStore } from '../store/sessions'
import { useProcessesStore, EMPTY_PROCESSES, type BgProcess } from '../store/processes'
import { useUiStore } from '../store/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * Background processes, as a chip on the conversation's status line.
 *
 * It used to sit in an app-wide status bar, but that bar held nothing else and
 * this returns null whenever there is nothing running — so it was a 22px empty
 * strip almost all of the time.
 */
export default function TasksChip(): React.JSX.Element | null {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const bySession = useProcessesStore((s) => s.bySession)
  const procs = activeSessionId ? bySession[activeSessionId] ?? EMPTY_PROCESSES : EMPTY_PROCESSES
  const focusProcessesTab = useUiStore((s) => s.focusProcessesTab)
  const bottomOpen = useUiStore((s) => s.bottomPanelOpen)
  const setBottomOpen = useUiStore((s) => s.setBottomPanelOpen)

  if (procs.length === 0) return null

  const summary = summarizeChip(procs)

  const onClick = (): void => {
    if (bottomOpen && summary.label) {
      setBottomOpen(false)
    } else {
      focusProcessesTab()
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={`flex items-center gap-1.5 px-1.5 py-px h-[18px] rounded-sm transition-colors hover:bg-accent/50 ${bottomOpen ? 'bg-accent/50 text-foreground/80' : ''}`}
          aria-label="Background processes"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${summary.dotClass}`} />
          <span>{summary.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Background processes</TooltipContent>
    </Tooltip>
  )
}

function summarizeChip(procs: BgProcess[]): { label: string; dotClass: string } {
  let running = 0, failed = 0, exited = 0, killed = 0
  for (const p of procs) {
    if (p.status === 'running' || p.status === 'orphaned' || p.status === 'untracked') running++
    else if (p.status === 'killed') killed++
    else if (p.status === 'stopped' || p.status === 'exited') {
      if (p.exitCode != null && p.exitCode !== 0) failed++
      else exited++
    }
  }

  if (running > 0) {
    return { label: `${running} running`, dotClass: 'bg-info animate-pulse' }
  }
  if (failed > 0) {
    return { label: `${failed} failed`, dotClass: 'bg-danger' }
  }
  return { label: `${exited + killed} done`, dotClass: 'bg-success/70' }
}
