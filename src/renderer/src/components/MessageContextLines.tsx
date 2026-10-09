import { ChevronDown, ChevronUp, CircleCheck, ListChecks, PanelRightOpen, PenLine, Sparkles } from 'lucide-react'
import type { MessageContext } from '../store/sessions'
import { openDesignInPanel, openQuestionnaireInPanel } from '../lib/openFile'
import { basename, isAbsolute } from '../lib/paths'

/**
 * What a user message carried beyond its words, as one line each.
 *
 * The full text went to Claude; the bubble says what it was. A questionnaire's
 * line opens into the record of what was sent — read from the message itself,
 * so it shows what Claude got then, not what the answers became later. The
 * record is drawn under the bubble, not in it (`QuestionnaireRecord`), so the
 * row that owns the bubble holds which one is open.
 */
export default function MessageContextLines({
  context,
  record = null,
  onRecord
}: {
  context: MessageContext[]
  /** Which questionnaire's record is open under the bubble. */
  record?: number | null
  onRecord?: (at: number | null) => void
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex flex-col gap-1 last:mb-0">
      {context.map((c, i) =>
        c.kind === 'questionnaire' ? (
          <QuestionnaireLine key={i} context={c} open={record === i} onToggle={() => onRecord?.(record === i ? null : i)} />
        ) : c.kind === 'design-feedback' ? (
          <button
            key={i}
            type="button"
            className="nyra-design-chip mb-0.5 self-start"
            onClick={() => c.ref?.path && void openDesignInPanel(c.ref.artboard ? `${c.ref.path}#${c.ref.artboard}` : c.ref.path)}
          >
            <span className="nyra-design-chip-icon" aria-hidden="true" />
            {c.label}
          </button>
        ) : (
          <CommentLine key={i} context={c} />
        )
      )}
    </div>
  )
}

/** "④ Comment on **Grant access** · Permissions — ready". */
function CommentLine({ context: c }: { context: MessageContext }): React.JSX.Element {
  const r = c.ref
  const lead = r?.round === 'reply' ? 'Reply on' : 'Comment on'
  return (
    <button
      type="button"
      onClick={() => r?.path && void openDesignInPanel(r.artboard ? `${r.path}#${r.artboard}` : r.path)}
      className="flex items-center gap-1 self-start text-left text-c-lg text-muted-foreground hover:text-foreground"
    >
      {r?.pin !== undefined && (
        <span className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-design-accent text-[11.5px] font-medium text-design-accent-foreground tabular-nums shadow-panel">
          {r.pin}
        </span>
      )}
      {r?.target ? (
        <span className="min-w-0 truncate">
          {lead} <span className="font-semibold text-foreground">{r.target}</span>
          {r.artboardName ? ` · ${r.artboardName}` : ''}
        </span>
      ) : (
        <span className="min-w-0 truncate">{c.label}</span>
      )}
    </button>
  )
}

/** `answered="8" of="12"` off the record, for "· 4 left to Claude". */
function leftToClaude(body: string): number {
  const m = /answered="(\d+)" of="(\d+)"/.exec(body)
  return m ? Math.max(0, Number(m[2]) - Number(m[1])) : 0
}

function QuestionnaireLine({
  context,
  open,
  onToggle
}: {
  context: MessageContext
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const left = leftToClaude(context.body)
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? 'Hide the answers' : 'Show the answers'}
      onClick={onToggle}
      className="flex items-center gap-2 text-left"
    >
      <ListChecks className="size-3.5 shrink-0 text-design-accent" />
      <span className="min-w-0 flex-1">
        {context.label}
        {left > 0 && <span className="text-c-lg text-muted-foreground"> · {left} left to Claude</span>}
      </span>
      {open ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
    </button>
  )
}

/** The answers that were sent, under the bubble that sent them. */
export function QuestionnaireRecord({ context }: { context: MessageContext }): React.JSX.Element {
  const rows = recordOf(context.body)
  return (
    <div className="mt-2 flex w-full max-w-[560px] flex-col rounded-at-12 border bg-background px-4 py-2 text-c-lg">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2 py-1">
          {r.kind === 'decide' ? (
            <Sparkles className="mt-0.5 size-[13px] shrink-0 text-design-accent" />
          ) : r.kind === 'typed' ? (
            <PenLine className="mt-0.5 size-[13px] shrink-0 text-success" />
          ) : (
            <CircleCheck className="mt-0.5 size-[13px] shrink-0 text-success" />
          )}
          <span className="w-[220px] shrink-0 text-muted-foreground">{r.question}</span>
          <span className={r.kind === 'decide' ? 'min-w-0 flex-1 text-design-accent' : 'min-w-0 flex-1 whitespace-pre-line'}>{r.answer}</span>
        </div>
      ))}
      {context.ref?.questionnaireId && (
        <button
          type="button"
          onClick={() => openQuestionnaireInPanel(context.ref!.questionnaireId!)}
          className="mt-1 mb-1 flex items-center gap-1 self-start text-muted-foreground hover:text-foreground"
        >
          <PanelRightOpen className="size-[13px]" />
          Open the questions
        </button>
      )}
    </div>
  )
}

type RecordRow = { question: string; answer: string; kind: 'picked' | 'typed' | 'decide' }

/**
 * The sent text, back into rows: `question → answer`, and the two summary
 * lines. An indented line carries on the answer above it; files are named by
 * their file name, where Claude got the whole path.
 */
export function recordOf(body: string): RecordRow[] {
  const rows: RecordRow[] = []
  for (const line of body.split('\n')) {
    const last = rows.at(-1)
    if (line.startsWith('  ') && last && last.kind !== 'decide') {
      last.answer += `\n${line.slice(2)}`
      last.kind = 'typed'
      continue
    }
    if (!line.includes(' → ') || line.startsWith('<')) continue
    const at = line.indexOf(' → ')
    const question = line.slice(0, at)
    const answer = line.slice(at + 3)
    if (question === 'Decide for me' || question.startsWith('Not answered')) {
      rows.push({ question: answer.split(' · ').join(', '), answer: 'Left to Claude', kind: 'decide' })
      continue
    }
    // What Claude was told to do, said the way the button said it.
    if (answer.startsWith('Explore options — ')) {
      rows.push({ question, answer: 'Claude drafts options', kind: 'decide' })
      continue
    }
    const parts = answer.split(' · ')
    if (parts.every(isAbsolute)) {
      rows.push({ question, answer: parts.map(basename).join(', '), kind: 'picked' })
      continue
    }
    rows.push({ question, answer, kind: answer.length > 60 ? 'typed' : 'picked' })
  }
  return rows
}
