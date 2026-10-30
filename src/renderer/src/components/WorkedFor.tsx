import React from 'react'
import { ChevronRight, ChevronUp } from 'lucide-react'
import { formatElapsed } from './ActivityStrip'

/**
 * Where a finished turn's working went: one line in place of its tool calls
 * and narration, opened to put them back where they were. Not monospaced like
 * a tool group's summary, since it stands for the whole turn rather than a run of calls.
 */
export default function WorkedFor({
  durationMs,
  open,
  onToggle
}: {
  durationMs?: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    // Closed, the rule is where the working ends and the reply begins.
    <div className={open ? 'py-1' : 'mb-2 border-b border-border/50 pt-1 pb-1'}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        // Same hover box as a tool group's: the fill gets room, the text keeps the prose's edge.
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <span className="text-c-sm text-muted-foreground">
          {durationMs !== undefined ? `Worked for ${formatElapsed(durationMs)}` : 'Worked'}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="flex-1" />
      </button>
    </div>
  )
}

/**
 * Where an opened turn's working ends: the rail stops here, and the turn closes
 * from the bottom without scrolling back up to its row.
 */
export function WorkedForEnd({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="pt-1 pb-3">
      <button
        onClick={onClose}
        className="-mx-1 flex items-center gap-2 rounded-sm px-1 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/40"
      >
        <ChevronUp className="size-3 shrink-0" />
        <span className="text-c-sm">Collapse</span>
      </button>
    </div>
  )
}
