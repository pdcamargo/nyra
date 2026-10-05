import { useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquareText, Pencil, X } from 'lucide-react'
import { useAnnotationsStore, useSessionAnnotations } from '../../store/annotations'
import { annotationsLabel, type ChatAnnotation } from '../../lib/chatAnnotations'

/**
 * The annotations waiting to go with the next message, at the top of the
 * composer. A chip until opened, so collecting a dozen of them does not push
 * the field off the bottom of the window.
 */
export default function AnnotationTray({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const annotations = useSessionAnnotations(sessionId)
  const [open, setOpen] = useState(false)
  if (!sessionId || annotations.length === 0) return null

  const label = annotationsLabel(annotations.length)
  if (!open) {
    return (
      <div className="pb-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[12.5px] font-[550] transition-colors hover:bg-accent"
        >
          <MessageSquareText className="size-3.5 text-muted-foreground" />
          {label}
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div className="mb-2 rounded-[10px] border bg-background p-1.5 text-[12.5px]">
      <div className="flex items-center gap-1.5 px-1.5 pb-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-expanded
          className="flex items-center gap-1.5 font-[550]"
        >
          <MessageSquareText className="size-3.5 text-muted-foreground" />
          {label}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => useAnnotationsStore.getState().clear(sessionId)}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear all
        </button>
      </div>
      <div className="max-h-[min(30vh,240px)] overflow-y-auto">
        {annotations.map((a, i) => (
          <Row key={a.id} sessionId={sessionId} annotation={a} n={i + 1} />
        ))}
      </div>
    </div>
  )
}

function Row({ sessionId, annotation: a, n }: { sessionId: string; annotation: ChatAnnotation; n: number }): React.JSX.Element {
  const jump = (edit: boolean): void =>
    useAnnotationsStore.getState().requestJump({
      messageId: a.messageId,
      start: a.start,
      end: a.end,
      ...(edit ? { editId: a.id } : {})
    })
  return (
    <div className="group/row flex items-start gap-2.5 rounded-[8px] px-1.5 py-1.5 hover:bg-accent/60">
      <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-info text-[11px] font-semibold text-info-foreground tabular-nums">
        {n}
      </span>
      <button type="button" onClick={() => jump(false)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[11.5px] text-muted-foreground/80">{a.source === 'user' ? 'You' : 'Claude'}</span>
          <span className="truncate text-muted-foreground">{a.quote}</span>
        </span>
        {a.comment && <span className="line-clamp-2 whitespace-pre-line">{a.comment}</span>}
      </button>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={() => jump(true)}
          aria-label={`Edit annotation ${n}`}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => useAnnotationsStore.getState().remove(sessionId, a.id)}
          aria-label={`Remove annotation ${n}`}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </span>
    </div>
  )
}
