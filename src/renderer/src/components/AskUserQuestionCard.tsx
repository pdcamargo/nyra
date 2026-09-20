import React, { useMemo, useState } from 'react'
import { CircleHelp } from 'lucide-react'
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
import { composeAnswer, questionsOf } from '../lib/askBlocks'
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
      className={`my-1 overflow-hidden rounded-lg border text-c-md ${
        denied ? 'border-danger/15 bg-danger/5' : 'border-border bg-muted/40'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border/55 px-3 py-2">
        <CircleHelp className="size-3.5 text-info" />
        <span className="font-medium text-foreground/80">Question</span>
        {denied && <span className="text-c-xs text-danger/60">denied</span>}
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
        <div className="space-y-3 px-3 py-2">
          {questions.map((q, i) => (
            <div key={i} className="space-y-1.5">
              <p className="leading-relaxed text-foreground/80">
                {q.header && <HeaderChip>{q.header}</HeaderChip>}
                {q.question}
              </p>
              <ul className="mt-1 space-y-1">
                {q.options?.map((opt) => (
                  <li key={opt.label} className="rounded-sm border border-border/55 px-2 py-1.5">
                    <p className="font-medium text-foreground/80">{opt.label}</p>
                    {opt.description && (
                      <p className="mt-0.5 text-c-sm leading-relaxed text-muted-foreground">
                        {opt.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
