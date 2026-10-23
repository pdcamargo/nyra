import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, Play } from 'lucide-react'
import { questionsOf, type AskQuestion } from '../lib/askBlocks'
import type { ToolCallMessage } from '../store/sessions'
import { DockButton } from './QuestionDock'

/**
 * Questions Claude carried on past, as the top of the composer.
 *
 * Collapsed by default to one line: they are there to be answered when the user
 * has a moment, not to stand between them and the reply they are reading. The
 * composer below stays theirs — nothing typed there answers these, which is the
 * difference from `QuestionDock`, whose question is the turn's last word.
 */
export default function DeferredTray({
  questions,
  running,
  onAnswer,
  onKeep,
  onIgnoreAll
}: {
  questions: ToolCallMessage[]
  /** Whether the turn is live: an answer then reaches Claude at its next step,
   *  and once it is over, goes as the next message. */
  running: boolean
  onAnswer: (toolId: string, answer: string) => void
  onKeep: (toolId: string) => void
  /** Let every assumption stand at once. Nothing is sent. */
  onIgnoreAll: () => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [focused, setFocused] = useState<string | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>({})

  // A fresh question after the last was settled starts collapsed again, and one
  // that was settled from elsewhere stops being the one on screen.
  useEffect(() => {
    if (questions.length === 0) setExpanded(false)
    if (focused && !questions.some((q) => q.tool_id === focused)) setFocused(null)
  }, [questions, focused])

  if (questions.length === 0) return null

  const single = questions.length === 1
  const current = single ? questions[0] : questions.find((q) => q.tool_id === focused)
  const assumedOf = (m: ToolCallMessage): string | undefined => questionsOf(m.input)[0]?.assumed

  const summary = (): string => {
    const assumed = single ? assumedOf(questions[0]) : undefined
    if (running) {
      return assumed ? `Claude is going with ${assumed} until you answer` : 'Claude keeps going with its defaults'
    }
    return assumed
      ? `Claude finished with ${assumed}. Answering starts a new turn.`
      : 'Claude finished with its defaults. Answering starts a new turn.'
  }

  return (
    <div className="pb-2">
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-2 pb-2 text-start"
        >
          <CircleHelp className="size-3.5 shrink-0 text-info" />
          <span className="shrink-0 text-c-sm font-medium text-foreground">
            {single ? '1 open question' : `${questions.length} open questions`}
          </span>
          <span className="min-w-0 flex-1 truncate text-c-sm text-muted-foreground">{summary()}</span>
          <span className="shrink-0 text-c-sm font-medium text-info">Answer</span>
          <ChevronUp className="size-3.5 shrink-0 text-info" />
        </button>
      ) : current ? (
        <AnswerPanel
          key={current.tool_id}
          message={current}
          running={running}
          picked={picks[current.tool_id]}
          onPick={(label) => setPicks((p) => ({ ...p, [current.tool_id]: label }))}
          onBack={single ? undefined : () => setFocused(null)}
          onCollapse={() => setExpanded(false)}
          onAnswer={(answer) => onAnswer(current.tool_id, answer)}
          onKeep={() => onKeep(current.tool_id)}
        />
      ) : (
        <div className="grid gap-1 pb-2">
          <div className="flex items-center gap-2 pb-1">
            <CircleHelp className="size-3.5 shrink-0 text-info" />
            <span className="shrink-0 text-c-sm font-medium text-foreground">{questions.length} open questions</span>
            <span className="min-w-0 flex-1 truncate text-c-sm text-muted-foreground">{summary()}</span>
            <DockButton onClick={onIgnoreAll}>Ignore all</DockButton>
            <CollapseButton onClick={() => setExpanded(false)} />
          </div>
          {questions.map((m) => {
            const q = questionsOf(m.input)[0]
            if (!q) return null
            return (
              <button
                key={m.tool_id}
                type="button"
                onClick={() => setFocused(m.tool_id)}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 text-start text-c-sm transition-colors hover:bg-input/40"
              >
                <span className="w-20 shrink-0 truncate text-c-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {q.header ?? 'Question'}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{q.question}</span>
                {q.assumed && <span className="shrink-0 text-info">{q.assumed}</span>}
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            )
          })}
        </div>
      )}
      <div className="h-px bg-separator" />
    </div>
  )
}

function CollapseButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Hide open questions"
      className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      <ChevronDown className="size-3.5" />
    </button>
  )
}

/** One question, open: its options, the one Claude is going with marked. */
function AnswerPanel({
  message,
  running,
  picked,
  onPick,
  onBack,
  onCollapse,
  onAnswer,
  onKeep
}: {
  message: ToolCallMessage
  running: boolean
  picked?: string
  onPick: (label: string) => void
  onBack?: () => void
  onCollapse: () => void
  onAnswer: (answer: string) => void
  onKeep: () => void
}): React.JSX.Element | null {
  const question: AskQuestion | undefined = questionsOf(message.input)[0]
  if (!question) return null
  // Sending what Claude is already doing is keeping it, so only a change sends.
  const changed = !!picked && picked !== question.assumed

  return (
    <div className="grid gap-2 pb-2">
      <div className="flex items-center gap-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="All open questions"
            className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        ) : (
          <CircleHelp className="size-3.5 shrink-0 text-info" />
        )}
        <span className="flex-1 text-c-sm font-medium text-foreground/80">Open question</span>
        <CollapseButton onClick={onCollapse} />
      </div>

      <p className="text-c-md leading-snug text-foreground">
        {question.header && (
          <span className="mr-2 rounded-sm bg-accent px-1.5 py-0.5 align-middle text-c-xs font-medium uppercase tracking-wide text-muted-foreground">
            {question.header}
          </span>
        )}
        {question.question}
      </p>

      <div className="grid gap-1.5">
        {question.options.map((opt) => {
          const on = picked === opt.label
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(opt.label)}
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-start text-c-sm transition-colors ${
                on ? 'border-primary/40 bg-primary/10' : 'border-input hover:bg-input/40'
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  on ? 'border-primary bg-primary' : 'border-input'
                }`}
              >
                {on && <span className="size-1.5 rounded-full bg-primary-foreground" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
                <span className="flex items-center gap-2 text-foreground">
                  {opt.label}
                  {opt.label === question.assumed && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-px text-c-xs text-info">
                      <Play className="size-2.5" />
                      Claude is going with this
                    </span>
                  )}
                </span>
                {opt.description && <span className="text-muted-foreground">{opt.description}</span>}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-c-xs text-muted-foreground">
          {running
            ? "Claude reads this at its next step. It won't stop."
            : 'Claude has finished, so this goes as your next message.'}
        </span>
        {question.assumed && <DockButton onClick={onKeep}>Keep {question.assumed}</DockButton>}
        <DockButton solid disabled={!changed} onClick={() => picked && onAnswer(picked)}>
          Send answer
        </DockButton>
      </div>
    </div>
  )
}
