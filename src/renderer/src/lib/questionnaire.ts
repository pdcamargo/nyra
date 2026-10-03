/**
 * Questionnaires: the questions Claude asks to shape a design, and the answers.
 *
 * The file is Rust's (`questionnaires.rs`); this is how the renderer reads it,
 * how answers are kept, and how they are written up for Claude. Questions are
 * read leniently: Claude wrote them, and a question with an odd field should
 * still be answerable rather than vanish.
 */

export type QuestionKind = 'single' | 'multi' | 'text' | 'scale' | 'color' | 'files'

/**
 * What an option can show besides its label. Each is drawn from data, not
 * from a picture Claude has to produce: a palette is its colours, a radius is
 * a button and a field at that radius.
 */
export type OptionPreview =
  | { palette: string[] }
  | { radius: number }
  | { density: 'compact' | 'comfortable' | 'spacious' }
  | { type: { size: number; weight?: number; family?: string; sample?: string } }
  | { swatch: string }
  /** A drawn direction: `<absolute path>#<artboard id>`, shown live. */
  | { artboard: string }

export type QuestionOption = {
  label: string
  description?: string
  /** A lucide icon name drawn beside the label: `folder-git-2`. */
  icon?: string
  /** A line of mono under the description: the path an option would use. */
  detail?: string
  preview?: OptionPreview
  /** Claude's pick, from what the code already says. */
  suggested?: boolean
  why?: string
}

export type Question = {
  id: string
  question: string
  kind: QuestionKind
  /** The rail section it is grouped under: "Color", "Type". */
  section?: string
  /** A short label above the question: "Accent". */
  chip?: string
  options?: QuestionOption[]
  scale?: {
    min: number
    max: number
    step?: number
    unit?: string
    minLabel?: string
    maxLabel?: string
    suggested?: number
    why?: string
    /** Two hex colours the track's strip runs between: cool → warm. */
    gradient?: [string, string]
  }
  /** For `color`: Claude's suggestion, as a hex. */
  suggested?: string
  why?: string
  /** Hint inside an empty text box or drop zone. */
  placeholder?: string
  /** `false` hides Decide for me and Explore options: there is nothing to
   *  decide. `'decide'` keeps Decide for me only: there is nothing to draw. */
  handBack?: false | 'decide'
}

/** A file added to an answer: Nyra's copy, beside the questionnaire. */
export type AnswerFile = { name: string; path: string; size: number }

export type Answer =
  | { kind: 'picked'; labels: string[] }
  | { kind: 'typed'; text: string }
  | { kind: 'value'; value: number | string }
  | { kind: 'files'; files: AnswerFile[] }
  | { kind: 'decide' }
  | { kind: 'explore' }

export type Questionnaire = {
  id: string
  title: string
  project: string
  /** The chat that asked last: where the answers go. */
  chatId: string
  createdAt: string
  updatedAt: string
  rounds: { at: string; questions: Question[] }[]
  answers: Record<string, Answer>
  sent: { at: string; count: number }[]
}

const KINDS: readonly QuestionKind[] = ['single', 'multi', 'text', 'scale', 'color', 'files']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readOption(o: unknown): QuestionOption | null {
  if (typeof o === 'string') return { label: o }
  if (!isObject(o) || typeof o.label !== 'string') return null
  const out: QuestionOption = { label: o.label }
  if (typeof o.description === 'string') out.description = o.description
  if (o.suggested === true) out.suggested = true
  if (typeof o.why === 'string') out.why = o.why
  if (typeof o.icon === 'string') out.icon = o.icon
  if (typeof o.detail === 'string') out.detail = o.detail
  if (isObject(o.preview)) out.preview = o.preview as OptionPreview
  return out
}

/** Every question across every round, in the order they were asked. */
export function questionsOf(q: Questionnaire): Question[] {
  const out: Question[] = []
  for (const round of q.rounds ?? []) {
    for (const raw of round.questions ?? []) {
      if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.question !== 'string') continue
      const kind = KINDS.includes(raw.kind as QuestionKind) ? (raw.kind as QuestionKind) : 'text'
      const question: Question = { id: raw.id, question: raw.question, kind }
      if (typeof raw.section === 'string') question.section = raw.section
      if (typeof raw.chip === 'string') question.chip = raw.chip
      if (Array.isArray(raw.options)) question.options = raw.options.map(readOption).filter((o): o is QuestionOption => o !== null)
      if (isObject(raw.scale) && typeof raw.scale.min === 'number' && typeof raw.scale.max === 'number') {
        question.scale = raw.scale as Question['scale']
      }
      if (typeof raw.suggested === 'string') question.suggested = raw.suggested
      if (typeof raw.why === 'string') question.why = raw.why
      if (typeof raw.placeholder === 'string') question.placeholder = raw.placeholder
      if (raw.handBack === false || raw.handBack === 'decide') question.handBack = raw.handBack
      out.push(question)
    }
  }
  return out
}

/** Sections in the order their first question appears; unsectioned ones go under "Questions". */
export function sectionsOf(questions: Question[]): { name: string; questions: Question[] }[] {
  const order: string[] = []
  const by = new Map<string, Question[]>()
  for (const q of questions) {
    const s = q.section?.trim() || 'Questions'
    if (!by.has(s)) {
      by.set(s, [])
      order.push(s)
    }
    by.get(s)!.push(q)
  }
  return order.map((name) => ({ name, questions: by.get(name)! }))
}

/** Whether an answer actually says something. An empty pick or blank text does not. */
export function isAnswered(a: Answer | undefined): boolean {
  if (!a) return false
  if (a.kind === 'picked') return a.labels.length > 0
  if (a.kind === 'typed') return a.text.trim().length > 0
  if (a.kind === 'files') return a.files.length > 0
  return true
}

export function progressOf(q: Questionnaire): { answered: number; total: number } {
  const all = questionsOf(q)
  return { answered: all.filter((x) => isAnswered(q.answers?.[x.id])).length, total: all.length }
}

/** An answer in words, for the record and for Claude. */
export function answerText(question: Question, a: Answer | undefined): string | null {
  if (!isAnswered(a)) return null
  switch (a!.kind) {
    case 'picked':
      return a!.labels.join(', ')
    case 'typed':
      return a!.text.trim()
    case 'files':
      return a!.files.map((f) => f.path).join(' · ')
    case 'value': {
      const v = a!.value
      if (question.kind === 'scale' && typeof v === 'number') {
        const s = question.scale
        const unit = s?.unit ? ` ${s.unit}` : ''
        const range = s ? ` (on ${s.min}–${s.max}${s.minLabel || s.maxLabel ? `, ${s.minLabel ?? s.min} → ${s.maxLabel ?? s.max}` : ''})` : ''
        return `${v}${unit}${range}`
      }
      return String(v)
    }
    case 'decide':
      return 'Decide for me'
    case 'explore':
      return 'Explore options — draft a few directions, then ask about them in a new short questionnaire with an artboard preview for each'
  }
}

/**
 * What Claude receives when answers are sent: every question, its answer, and
 * which ones are left to it. Wrapped in a tag so it reads as data, not prose.
 */
export function formatAnswers(q: Questionnaire): string {
  const all = questionsOf(q)
  const lines: string[] = []
  const decide: string[] = []
  const unanswered: string[] = []
  for (const question of all) {
    const a = q.answers?.[question.id]
    const text = answerText(question, a)
    if (text === null) {
      unanswered.push(question.question)
      continue
    }
    if (a?.kind === 'decide') {
      decide.push(question.question)
      continue
    }
    const suggested = a?.kind === 'picked' && question.options?.some((o) => o.suggested && a.labels.includes(o.label))
    // Later lines of a long answer are indented, so they still read as part of
    // it — to Claude, and to `recordOf` putting the record back together.
    const [first, ...rest] = text.split('\n')
    lines.push(`${question.question} → ${first}${suggested ? ' (your suggestion)' : ''}`, ...rest.map((l) => `  ${l}`))
  }
  const { answered, total } = progressOf(q)
  const out = [`<questionnaire id="${q.id}" title="${q.title.replace(/"/g, "'")}" answered="${answered}" of="${total}">`, ...lines]
  if (decide.length) out.push(`Decide for me → ${decide.join(' · ')}`)
  if (unanswered.length) out.push(`Not answered (yours to decide) → ${unanswered.join(' · ')}`)
  if (all.some((x) => x.kind === 'files' && q.answers?.[x.id]?.kind === 'files')) {
    out.push('The files are copies Nyra keeps for this questionnaire. Read them.')
  }
  out.push('</questionnaire>')
  return out.join('\n')
}

/** The bubble's one line. */
export function sentLabel(q: Questionnaire): string {
  const { answered, total } = progressOf(q)
  const subject = q.title.replace(/ design system$/i, '')
  return answered === total ? `Answered ${total} questions about ${subject}` : `Answered ${answered} of ${total} questions about ${subject}`
}

/** Hex colours only: what a colour answer and a palette preview accept. */
export const isHex = (s: string): boolean => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim())
