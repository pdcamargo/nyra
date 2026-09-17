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
import { useUiStore } from '../store/ui'
import { useSessionsStore, type ToolCallMessage } from '../store/sessions'

/**
 * The value behind "Something else".
 *
 * The questionnaire refuses to submit an item whose status is `unanswered`, so a
 * free-text box sitting alongside the choices could be filled in and then
 * silently swallowed. Typing ticks this choice instead, which is what makes the
 * answer real; on submit it is swapped back out for what was actually typed.
 */
const OTHER = '__other__'

type Option = { label: string; description?: string }
type Question = {
  question: string
  header?: string
  options: Option[]
  multiSelect?: boolean
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  return raw.filter((q): q is Question => !!q && typeof q === 'object' && 'question' in q)
}

/** The short label a question carries, so a set of them can be told apart. */
function HeaderChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="mr-2 rounded-sm bg-accent px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
  message
}: {
  message: ToolCallMessage
}): React.JSX.Element {
  const questions = useMemo(() => parseQuestions(message.input), [message.input])
  const denied = message.denied === true
  const answered = message.result !== undefined || denied
  const prefillInput = useUiStore((s) => s.prefillInput)
  const [submitted, setSubmitted] = useState(false)

  const items = useMemo(
    () =>
      questions.map((q, i) => ({
        name: `q${i}`,
        required: false,
        choices: [...q.options.map((opt) => ({ value: opt.label })), { value: OTHER }]
      })),
    [questions]
  )

  /** Typing is answering — keep the sentinel choice in step with the text box. */
  const syncOther =
    (index: number) =>
    (event: React.FormEvent<HTMLInputElement>): void => {
      const field = event.currentTarget
      const wanted = field.value.trim().length > 0
      const choice = field.form?.querySelector<HTMLInputElement>(
        `input[name="q${index}"][value="${OTHER}"]`
      )
      if (choice && choice.checked !== wanted) choice.click()
    }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const lines = questions
      .map((q, i) => {
        const picked = data.getAll(`q${i}`).filter(Boolean) as string[]
        // None of the options is often the true answer, and on a multi-select it
        // sits happily beside one that is.
        const other = String(data.get(`q${i}-other`) ?? '').trim()
        const parts = picked.filter((p) => p !== OTHER)
        if (other) parts.push(other)
        if (parts.length === 0) return null
        return questions.length > 1 ? `${q.question} ${parts.join(', ')}` : parts.join(', ')
      })
      .filter(Boolean)
    if (lines.length === 0) return
    const answer = lines.join('\n')
    prefillInput(answer)
    setSubmitted(true)
    // Record it on the message too, so a reloaded transcript shows a question
    // that was answered rather than offering the buttons again.
    const sid = useSessionsStore.getState().activeSessionId
    if (sid) useSessionsStore.getState().updateToolResult(sid, message.tool_id, answer)
  }

  const interactive = !answered && !submitted && questions.length > 0

  return (
    <div
      className={`my-1 overflow-hidden rounded-lg border text-xs ${
        denied ? 'border-danger/15 bg-danger/5' : 'border-border bg-muted/40'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border/55 px-3 py-2">
        <CircleHelp className="size-3.5 text-info" />
        <span className="font-medium text-foreground/80">Question</span>
        {denied && <span className="text-[10px] text-danger/60">denied</span>}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {submitted ? 'Answer is in the composer' : interactive ? 'Pick to answer' : 'Answered in chat'}
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
                <QuestionnaireChoice value={OTHER}>Something else</QuestionnaireChoice>
              </QuestionnaireChoices>
              <input
                name={`q${i}-other`}
                onInput={syncOther(i)}
                placeholder="Something else — type it here"
                autoComplete="off"
                className="mt-2 h-8 w-full rounded-md border border-input bg-input/20 px-2.5 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30"
              />
            </QuestionnaireItem>
          ))}
          <QuestionnaireActions>
            <QuestionnairePrevious />
            {/* Typing ticks "Something else", so a written answer unlocks Next on
                its own. This is for the question you would rather not answer. */}
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
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
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
