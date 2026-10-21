import React from 'react'
import { Check, CircleCheck, CircleHelp, LoaderCircle } from 'lucide-react'
import { questionsOf } from '../lib/askBlocks'
import type { ToolCallMessage } from '../store/sessions'

/**
 * Where Claude asked a question it did not stop for.
 *
 * One line in the transcript, at the point it was asked, that follows the
 * question through its life: what Claude is going with while it is open, the
 * answer on its way, the answer read, or the assumption kept. Answering happens
 * in the composer's tray, not here — this is the record.
 */
export default function DeferredQuestionMarker({ message }: { message: ToolCallMessage }): React.JSX.Element | null {
  const question = questionsOf(message.input)[0]
  if (!question) return null
  const state = message.deferred ?? 'open'
  const answer = message.result

  const note =
    state === 'sending'
      ? `${answer} · reaches Claude at its next step`
      : state === 'read'
        ? `${answer} · read by Claude`
        : state === 'kept'
          ? `Kept ${question.assumed ?? "Claude's call"}`
          : question.assumed
            ? `Going with ${question.assumed}`
            : 'Claude is carrying on'

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-c-sm ${
        state === 'open' ? 'border-dashed border-info/60' : 'border-border'
      }`}
    >
      {state === 'open' && <CircleHelp className="size-3.5 shrink-0 text-info" />}
      {state === 'sending' && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      {state === 'read' && <CircleCheck className="size-3.5 shrink-0 text-success" />}
      {state === 'kept' && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
      {question.header && (
        <span className="shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-c-xs font-medium uppercase tracking-wide text-muted-foreground">
          {question.header}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-foreground">{question.question}</span>
      <span className={`shrink-0 ${state === 'open' ? 'text-info' : 'text-muted-foreground'}`}>{note}</span>
    </div>
  )
}
