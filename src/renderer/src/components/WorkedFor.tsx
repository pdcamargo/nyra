import React from 'react'
import { ChevronRight } from 'lucide-react'
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
    <div className="py-1">
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
