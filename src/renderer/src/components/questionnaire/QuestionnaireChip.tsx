import { useEffect, useState } from 'react'
import { CircleCheck, ListChecks, PanelRightOpen } from 'lucide-react'
import type { ToolCallMessage } from '../../store/sessions'
import { progressOf, type Questionnaire } from '../../lib/questionnaire'
import { openQuestionnaireInPanel } from '../../lib/openFile'

/** The tool Claude asks with. */
export const DESIGN_TOOL_NAME = 'mcp__nyra-app__nyra_design'

/** A `nyra_design` call that opened a questionnaire. */
export function isQuestionnaireAsk(m: { tool_name: string; input?: unknown }): boolean {
  return m.tool_name === DESIGN_TOOL_NAME && (m.input as { action?: unknown } | undefined)?.action === 'ask'
}

/** Which questionnaire a call opened: the id it was given, or the one its
 *  result names. */
export function questionnaireIdOf(m: ToolCallMessage): string | null {
  const given = (m.input as { id?: unknown } | undefined)?.id
  if (typeof given === 'string' && given) return given
  return /\b(q_[a-z0-9]+)\b/i.exec(m.result ?? '')?.[1] ?? null
}

/**
 * Claude asked questions: one line, with live progress, that opens them.
 *
 * Not a card. The questions live in the side panel — which is also where you
 * answer them — and the transcript only says they exist and how far along they
 * are. Closing the panel loses nothing; this line brings it back.
 */
export default function QuestionnaireChip({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const id = questionnaireIdOf(message)
  const [q, setQ] = useState<Questionnaire | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = (): void =>
      void window.api.questionnaire.get(id).then((next) => {
        if (!cancelled) setQ(next)
      })
    load()
    const stop = window.api.questionnaire.onChanged((p) => {
      if (p.id === id) load()
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [id])

  const pending = message.result === undefined
  if (pending || !id) {
    return (
      <div className="flex items-center gap-2 py-1 text-c-lg">
        <ListChecks className="size-3.5 text-design-accent" />
        <span className={pending ? 'nyra-shimmer' : 'text-muted-foreground'}>{pending ? 'Claude is writing questions…' : 'Claude could not open its questions'}</span>
      </div>
    )
  }

  const { answered, total } = q ? progressOf(q) : { answered: 0, total: 0 }
  const title = q?.title || 'this design'
  const asked = (message.input as { questions?: { question?: unknown }[] } | undefined)?.questions ?? []
  const givenId = typeof (message.input as { id?: unknown } | undefined)?.id === 'string'

  // Asking for it back is a trace, not a new chip: nothing new was asked.
  if (asked.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void openQuestionnaireInPanel(id)}
        className="flex items-center gap-2 py-1 text-left font-mono text-c-md text-muted-foreground hover:text-foreground"
      >
        <PanelRightOpen className="size-[13px] shrink-0" />
        <span className="min-w-0 truncate">
          Opened {title} — {answered} of {total} answered
        </span>
      </button>
    )
  }

  const subject = title.replace(/ design system$/i, '')
  const sent = (q?.sent?.length ?? 0) > 0
  // A round added to one already asked says what it added, and which round.
  const round = givenId && q ? q.rounds.findIndex((r) => r.questions[0]?.question === asked[0]?.question) + 1 : 0
  const text = sent
    ? `Answered ${answered} of ${total} questions about ${subject}`
    : round > 1
      ? `Claude added ${asked.length} question${asked.length === 1 ? '' : 's'} to ${subject}`
      : answered > 0
        ? `${total} questions about ${title}`
        : `Claude has ${total} question${total === 1 ? '' : 's'} about ${title}`
  const action = sent ? 'View' : answered > 0 && round <= 1 ? 'Continue' : 'Open'
  // A round opens on its own questions, not on page one.
  const focus = round > 1 ? q?.rounds[round - 1]?.questions[0]?.id : undefined

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => void openQuestionnaireInPanel(id, undefined, focus)}
        className="-mx-1 flex max-w-full items-center gap-2 rounded-at-4 px-1 py-1 text-left text-c-lg transition-colors hover:bg-muted/40"
      >
        {sent ? <CircleCheck className="size-3.5 shrink-0 text-success" /> : <ListChecks className="size-3.5 shrink-0 text-design-accent" />}
        <span className={`min-w-0 truncate ${sent ? 'text-muted-foreground' : 'text-foreground'}`}>{text}</span>
        {!sent && round <= 1 && answered > 0 && (
          <>
            <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-border">
              <span className="block h-full rounded-full bg-design-accent" style={{ width: `${total ? (answered / total) * 100 : 0}%` }} />
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {answered} of {total}
            </span>
          </>
        )}
        {!sent && round > 1 && <span className="shrink-0 text-muted-foreground">round {round}</span>}
        <span className="ml-3 flex shrink-0 items-center gap-2 font-[550] text-design-accent">
          <PanelRightOpen className="size-[13px]" />
          {action}
        </span>
      </button>
    </div>
  )
}
