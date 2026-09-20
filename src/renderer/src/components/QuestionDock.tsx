import React, { useMemo } from 'react'
import { Check, CircleHelp } from 'lucide-react'
import { composeAnswer, questionsOf, type AskOption } from '../lib/askBlocks'
import { useQuestionAnswerStore } from '../store/questionAnswer'
import type { ToolCallMessage } from '../store/sessions'

/**
 * Claude's question, as the top half of the composer.
 *
 * It used to be a card in the transcript with its own text box for "Something
 * else" — a second input a few pixels above the one you were already looking at,
 * and a sentinel choice whose whole job was to make that box count. Both are
 * gone. The composer is the free-text answer, so the options and the box you
 * type into are one control, and which of them wins is decided by whichever you
 * touched last (see `useQuestionAnswerStore`).
 *
 * Rendered inside the composer's own box rather than docked above it, so there
 * is one border and `focus-within` lights the whole thing at once.
 */
export default function QuestionDock({
  message,
  text,
  onSubmit
}: {
  message: ToolCallMessage
  /** What is in the composer right now. Non-empty means it beats any tick. */
  text: string
  onSubmit: (answer: string) => void
}): React.JSX.Element | null {
  const questions = useMemo(() => questionsOf(message.input), [message.input])
  const picks = useQuestionAnswerStore((s) => s.picks)
  const mode = useQuestionAnswerStore((s) => s.mode)
  const page = useQuestionAnswerStore((s) => s.page)
  const pick = useQuestionAnswerStore((s) => s.pick)
  const setPage = useQuestionAnswerStore((s) => s.setPage)

  if (questions.length === 0) return null

  const q = questions[Math.min(page, questions.length - 1)]
  const multi = q.multiSelect === true
  const typing = mode === 'typed' && text.trim().length > 0
  const chosen = typing ? [] : (picks[page] ?? [])
  const last = page === questions.length - 1

  const hint = typing
    ? 'Your words win — ticks cleared'
    : Object.keys(picks).length > 0
      ? 'Picks win — your text is ignored'
      : 'Pick one, or just type'

  const submit = (): void => onSubmit(composeAnswer(questions, picks))

  return (
    <div className="pb-2">
      <div className="flex items-center gap-2 pb-2">
        <CircleHelp className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground/80">Question</span>
        <span className="ml-auto text-c-xs text-muted-foreground">
          {questions.length > 1 ? `${page + 1} of ${questions.length}` : hint}
        </span>
      </div>

      <p className="pb-2 text-c-md leading-snug text-foreground">
        {q.header && (
          <span className="mr-2 rounded-sm bg-accent px-1.5 py-0.5 align-middle text-c-xs font-medium uppercase tracking-wide text-muted-foreground">
            {q.header}
          </span>
        )}
        {q.question}
      </p>

      <div className="grid gap-1.5">
        {q.options.map((opt: AskOption) => {
          const on = chosen.includes(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              onClick={() => {
                pick(page, opt.label, multi)
                // One question, one choice, nothing typed: the click *is* the
                // answer. Stopping to make you press Submit as well is a step
                // with nothing in it.
                if (!multi && questions.length === 1 && text.trim().length === 0) {
                  onSubmit(composeAnswer(questions, { [page]: [opt.label] }))
                }
              }}
              className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-start text-c-sm transition-colors ${
                on ? 'border-primary/40 bg-primary/10' : 'border-input hover:bg-input/40'
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${
                  multi ? 'rounded-[4px]' : 'rounded-full'
                } ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}
              >
                {on &&
                  (multi ? (
                    <Check className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-primary-foreground" />
                  ))}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
                <span className="text-foreground">{opt.label}</span>
                {opt.description && (
                  <span className="text-muted-foreground">{opt.description}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2 pt-2">
        <span className="flex-1" />
        {questions.length > 1 && (
          <>
            <DockButton disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </DockButton>
            {!last && <DockButton onClick={() => setPage(page + 1)}>Skip</DockButton>}
          </>
        )}
        {questions.length > 1 && !last ? (
          <DockButton solid onClick={() => setPage(page + 1)}>
            Next
          </DockButton>
        ) : (
          <DockButton solid disabled={typing || Object.keys(picks).length === 0} onClick={submit}>
            Submit
          </DockButton>
        )}
      </div>

      {/* Inset, so the question and the field below read as one card rather than
          two stacked ones. */}
      <div className="mt-2 h-px bg-separator" />
    </div>
  )
}

function DockButton({
  children,
  onClick,
  solid,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  solid?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2.5 py-1 text-c-sm font-medium transition-colors disabled:opacity-30 ${
        solid
          ? 'bg-foreground text-background hover:opacity-85'
          : 'border border-border-strong text-foreground hover:bg-accent/50'
      }`}
    >
      {children}
    </button>
  )
}
