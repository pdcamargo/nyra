import { useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquareText } from 'lucide-react'
import { useAnnotationsStore } from '../../store/annotations'
import { annotationsLabel } from '../../lib/chatAnnotations'
import type { MessageContext } from '../../store/sessions'

/**
 * Under a sent bubble: which annotations went with it. Closed, one line;
 * open, each quote and comment as sent — read off the message, so it shows
 * what Claude got then. A row brings its source back on screen and lights it.
 */
export default function AnnotationReceipt({ context }: { context: MessageContext }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const annotations = context.ref?.annotations ?? []
  if (annotations.length === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="mt-1.5 flex w-[85%] flex-col items-end gap-1.5 text-c-lg">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <MessageSquareText className="size-3.5" />
        {annotationsLabel(annotations.length)}
        <Chevron className="size-3.5" />
      </button>
      {open && (
        <div className="flex w-full flex-col gap-1 rounded-[12px] border bg-background p-1.5">
          {annotations.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => useAnnotationsStore.getState().requestJump({ messageId: a.messageId, start: a.start, end: a.end })}
              className="flex items-start gap-2.5 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
            >
              <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-info text-[11px] font-semibold text-info-foreground tabular-nums">
                {i + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-c-md text-muted-foreground/80">{a.source === 'user' ? 'You' : 'Claude'}</span>
                  <span className="truncate text-muted-foreground">{a.quote}</span>
                </span>
                {a.comment ? (
                  <span className="whitespace-pre-line">{a.comment}</span>
                ) : (
                  <span className="text-muted-foreground/70">No comment</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
