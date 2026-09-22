import React, { useMemo, useState } from 'react'
import { Circle, CircleCheck, CircleHelp, PenLine } from 'lucide-react'
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle
} from './ui/questionnaire'
import { composeAnswer, parseAnswer, questionsOf, readAnswer, type AskQuestion } from '../lib/askBlocks'
import { useUiStore } from '../store/ui'
import { useSessionsStore, type ToolCallMessage } from '../store/sessions'
import { useQuestionAnswerStore } from '../store/questionAnswer'

/** The short label a question carries, so a set of them can be told apart. */
function HeaderChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="mr-2 rounded-sm bg-accent px-1.5 py-0.5 align-middle text-c-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  )
}

/**
 * Claude's AskUserQuestion, rendered as something you can actually answer.
 *
 * It used to be a read-only list with "Reply in chat to answer" in the corner,
 * which meant retyping an option's label by hand. Answering now composes the
 * reply and drops it in the composer — deliberately not sending it, so the
 * answer is still yours to edit or add to before it goes.
 *
 * Only live while the call is still pending: once Claude has a result, the card
 * is a record of what was asked, and offering buttons would be a lie.
 */
export default function AskUserQuestionCard({
  message,
  onAnswer
}: {
  message: ToolCallMessage
  /** Send the answer. Absent only where the card is a record, not a prompt. */
  onAnswer?: (toolId: string, answer: string) => void
}): React.JSX.Element | null {
  const questions = useMemo(() => questionsOf(message.input), [message.input])
  const denied = message.denied === true
  const answered = message.result !== undefined || denied
  const prefillInput = useUiStore((s) => s.prefillInput)
  const [submitted, setSubmitted] = useState(false)
  const dockedHere = useQuestionAnswerStore((s) => s.toolId === message.tool_id)

  const items = useMemo(
    () =>
      questions.map((q, i) => ({
        name: `q${i}`,
        required: false,
        choices: q.options.map((opt) => ({ value: opt.label }))
      })),
    [questions]
  )

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const picks = Object.fromEntries(
      questions.map((_, i) => [i, data.getAll(`q${i}`).filter(Boolean) as string[]])
    )
    const answer = composeAnswer(questions, picks)
    if (!answer) return
    setSubmitted(true)
    // Answering used to drop the text in the composer for you to send, on the
    // theory that you might want to edit it first. In practice you have just
    // picked from a list and pressed a button labelled Submit; stopping there to
    // make you press Enter as well is a step with nothing in it.
    if (onAnswer) {
      onAnswer(message.tool_id, answer)
      return
    }
    prefillInput(answer)
    const sid = useSessionsStore.getState().activeSessionId
    if (sid) useSessionsStore.getState().updateToolResult(sid, message.tool_id, answer)
  }

  const interactive = !answered && !submitted && questions.length > 0

  // The dock has it, so this would be the same question a second time. It comes
  // back as a record the moment it is answered or waved away — the same trade
  // `PlanCard` makes when a plan is pinned.
  if (dockedHere) return null

  return (
    <div
      /* mb over my: the answer to a question is a user bubble directly below
         it, and at the transcript's own rhythm the two touched — the card read
         as the top half of the reply rather than the thing being replied to. */
      className={`mt-1 mb-4 overflow-hidden rounded-lg border text-c-md ${
        denied ? 'border-danger/15 bg-danger/5' : 'border-border bg-muted/40'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border/55 px-3 py-2">
        <CircleHelp className="size-3.5 text-info" />
        <span className="font-medium text-foreground/80">Question</span>
        {denied && <span className="text-c-xs text-danger">denied</span>}
        <span className="ml-auto text-c-xs text-muted-foreground">
          {submitted ? 'Sent' : interactive ? 'Pick to answer' : 'Answered in chat'}
        </span>
      </div>

      {questions.length === 0 ? (
        <p className="px-3 py-2 italic text-muted-foreground">(no questions provided)</p>
      ) : interactive ? (
        <Questionnaire items={items} onSubmit={onSubmit} className="px-3 py-2.5">
          {questions.length > 1 && <QuestionnaireProgress />}
          {questions.map((q, i) => (
            <QuestionnaireItem key={i} name={`q${i}`} multiple={q.multiSelect === true}>
              <QuestionnaireTitle>
                {q.header && <HeaderChip>{q.header}</HeaderChip>}
                {q.question}
              </QuestionnaireTitle>
              <QuestionnaireChoices>
                {q.options.map((opt) => (
                  <QuestionnaireChoice key={opt.label} value={opt.label}>
                    {opt.label}
                    {opt.description && (
                      <QuestionnaireChoiceDescription>
                        {opt.description}
                      </QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
            </QuestionnaireItem>
          ))}
          <QuestionnaireActions>
            <QuestionnairePrevious />
            {/* For the question you would rather not answer. Free text is the
                composer's job now — this card only appears when the dock is not
                already holding the same question. */}
            {questions.length > 1 && <QuestionnaireSkip />}
            <QuestionnaireNext />
            <QuestionnaireSubmit />
          </QuestionnaireActions>
        </Questionnaire>
      ) : (
        <Record questions={questions} result={message.result} />
      )}
    </div>
  )
}

/**
 * What a question looks like once it has been answered.
 *
 * It used to be every option of every question in its own bordered box, with
 * nothing saying which one was picked — three questions of four options was a
 * screenful of boxes inside a box, and a typed answer was not in there at all,
 * because it is not one of the options.
 *
 * So the record is the answers, and the options are behind a toggle for when
 * you want to know what else was on offer. A marker column rather than a border
 * each: the shape of the list is what says these are alternatives.
 */
function Record({
  questions,
  result
}: {
  questions: AskQuestion[]
  result?: string
}): React.JSX.Element {
  const [showOptions, setShowOptions] = useState(false)
  const answers = useMemo(() => parseAnswer(result, questions), [result, questions])
  const hasOptions = questions.some((q) => q.options.length > 0)

  return (
    <div className="px-3 py-2.5">
      <div className="space-y-3">
        {questions.map((q, i) => {
          const { picked, typed } = readAnswer(answers[i], q.options)
          const unanswered = picked.length === 0 && !typed
          return (
            <div key={i} className="space-y-1">
              {/* No header chip here, unlike the dock. The chip exists so one
                  question of a set can be told apart when you see them one at a
                  time; a record lists every question in full, so it earns
                  nothing — and an inline chip pushed the question text a chip's
                  width right of every answer under it, which is two columns in
                  a block that should read as one. */}
              <p className="leading-relaxed text-foreground/80">{q.question}</p>

              {typed && <Answer icon={PenLine}>{typed}</Answer>}
              {!showOptions &&
                picked.map((label) => (
                  <Answer key={label} icon={CircleCheck}>
                    {label}
                  </Answer>
                ))}
              {!showOptions && unanswered && (
                <p className="pl-[22px] text-c-sm text-muted-foreground">Not answered</p>
              )}

              {showOptions &&
                q.options.map((opt) => {
                  const on = picked.includes(opt.label)
                  return (
                    <Answer key={opt.label} icon={on ? CircleCheck : Circle} muted={!on}>
                      {opt.label}
                      {opt.description && (
                        <span className="text-muted-foreground"> — {opt.description}</span>
                      )}
                    </Answer>
                  )
                })}
            </div>
          )
        })}
      </div>

      {hasOptions && (
        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="mt-2.5 text-c-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {showOptions ? 'Hide options' : 'Show all options'}
        </button>
      )}
    </div>
  )
}

/** One line of the record: a marker, then the text. */
function Answer({
  icon: Icon,
  muted,
  children
}: {
  icon: React.ComponentType<{ className?: string }>
  muted?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p
      className={`flex gap-1.5 text-c-md leading-relaxed ${
        muted ? 'text-muted-foreground' : 'text-foreground'
      }`}
    >
      {/* One line box tall, with the icon centred in it, rather than a pixel
          nudge: `leading-relaxed` is 1.625, so this tracks the type size and
          the marker stays on the centre of the first line at any of them. A
          hand-tuned margin put it 3px high. */}
      <span className="flex h-[1.625em] shrink-0 items-center">
        <Icon className={`size-3.5 ${muted ? 'text-muted-foreground' : 'text-success'}`} />
      </span>
      <span className="min-w-0 whitespace-pre-wrap">{children}</span>
    </p>
  )
}
