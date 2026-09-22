/**
 * Claude asking the user something, in a GUI that can actually offer buttons.
 *
 * `AskUserQuestion` only exists in the interactive CLI — headless Claude has no
 * such tool, so the questionnaire card had nothing to render. This is the
 * substitute: a fenced ```nyra-ask block the system prompt teaches, lifted out of
 * the reply and turned into the same shape the card already expects.
 *
 * Markdown rather than JSON on purpose. A model emits `- OAuth — no secrets to
 * store` reliably; it fumbles quoting and trailing commas often enough to matter,
 * and when it does the whole question is lost. This format also fails softly: a
 * block we cannot parse, or one from an older reply, still reads as a plain list.
 */

export type AskOption = { label: string; description?: string }

export type AskQuestion = {
  question: string
  header?: string
  options: AskOption[]
  multiSelect?: boolean
}

/** ```nyra-ask … ``` — tolerant of indentation and of a missing closing fence. */
const ASK_FENCE = /^[ \t]*```[ \t]*nyra-ask[ \t]*\n([\s\S]*?)(?:^[ \t]*```[ \t]*$|$(?![\s\S]))/gm

const HEADING = /^[ \t]*#{1,6}[ \t]+(.*)$/
const BULLET = /^[ \t]*[-*][ \t]+(.*)$/
/** `label — description`, in any of the dashes a model reaches for. */
const LABEL_SPLIT = /\s+(?:—|–|--|-)\s+/
/** A `(multi)` / `(multiple)` marker anywhere in the heading. */
const MULTI = /\((?:multi|multiple|multi-select|multiselect)\)/i
/** An optional `[Short label]` chip at the head of the question. */
const HEADER = /^\[([^\]]{1,24})\]\s*/

function parseOption(line: string): AskOption | null {
  const text = line.trim()
  if (!text) return null
  const [label, ...rest] = text.split(LABEL_SPLIT)
  const description = rest.join(' ').trim()
  if (!label.trim()) return null
  return description ? { label: label.trim(), description } : { label: label.trim() }
}

/** Questions out of one block's body. A heading with no options is not a question. */
export function parseAskBlock(body: string): AskQuestion[] {
  const questions: AskQuestion[] = []
  let current: AskQuestion | null = null

  const flush = (): void => {
    if (current && current.options.length > 0) questions.push(current)
    current = null
  }

  for (const line of body.split('\n')) {
    const heading = line.match(HEADING)
    if (heading) {
      flush()
      let text = heading[1].trim()
      const multiSelect = MULTI.test(text)
      text = text.replace(MULTI, '').trim()
      const header = text.match(HEADER)?.[1]
      if (header) text = text.replace(HEADER, '').trim()
      current = {
        question: text,
        options: [],
        ...(header ? { header } : {}),
        ...(multiSelect ? { multiSelect: true } : {})
      }
      continue
    }
    const bullet = line.match(BULLET)
    if (bullet && current) {
      const option = parseOption(bullet[1])
      if (option) current.options.push(option)
    }
  }
  flush()
  return questions
}

/**
 * Split a reply into what the user reads and what the card renders.
 *
 * Every block is taken out of the text, whether or not it parsed — a fence the
 * user was never meant to see is noise either way, and leaving it in while also
 * showing the card would ask the same thing twice.
 */
export function extractAskBlocks(reply: string): { text: string; questions: AskQuestion[] } {
  const questions: AskQuestion[] = []
  const text = reply.replace(ASK_FENCE, (_match, body: string) => {
    questions.push(...parseAskBlock(body))
    return ''
  })
  // Collapse the hole the fence left behind rather than leaving a gap mid-reply.
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), questions }
}

/** The questions off a synthesized `AskUserQuestion` tool call. */
export function questionsOf(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (q): q is AskQuestion =>
      !!q && typeof q === 'object' && 'question' in q && Array.isArray((q as AskQuestion).options)
  )
}

/**
 * One reply out of a set of answered questions.
 *
 * Shared by the dock and the transcript card, so the wording cannot drift
 * between the two places a question can be answered. A question with nothing
 * ticked is left out rather than sent blank, and with more than one question the
 * question text goes in front — "Postgres" on its own is not something the reader
 * on the other end can make sense of.
 */
/**
 * Read a composed answer back into one answer per question.
 *
 * The record a card shows once a question is answered used to be every option
 * of every question, bordered, with nothing marking the one that was picked —
 * and a typed answer appeared nowhere at all, because it is not an option. The
 * answer is on the message as the string `composeAnswer` built, so this is that
 * function run backwards.
 *
 * Only for display. An answer that does not parse falls back to being shown
 * whole rather than being dropped.
 */
export function parseAnswer(
  result: string | undefined,
  questions: AskQuestion[]
): (string | null)[] {
  const blank = questions.map(() => null as string | null)
  const text = (result ?? '').trim()
  if (!text || questions.length === 0) return blank
  // One question is composed as the bare answer — there is no prefix to find.
  if (questions.length === 1) return [text]

  const out = [...blank]
  let current = -1
  for (const line of text.split('\n')) {
    // Longest match, so a question that is a prefix of another does not win.
    let best = -1
    for (let i = 0; i < questions.length; i++) {
      const prefix = questions[i].question
      if (!line.startsWith(prefix)) continue
      if (best === -1 || prefix.length > questions[best].question.length) best = i
    }
    if (best !== -1) {
      current = best
      out[best] = line.slice(questions[best].question.length).trim()
    } else if (current !== -1) {
      // A typed answer can run to several lines; they belong to the question
      // whose prefix opened them.
      out[current] = `${out[current]}\n${line}`
    }
  }
  return out.some((a) => a !== null) ? out : blank
}

/**
 * Which of a question's options an answer names, and whether it is free text.
 *
 * A multi-select is composed as `A, B`, and free text can contain a comma too —
 * so the split only counts when *every* part is an option. Anything else is
 * your own words, kept whole.
 */
export function readAnswer(
  answer: string | null,
  options: AskOption[]
): { picked: string[]; typed: string | null } {
  const text = (answer ?? '').trim()
  if (!text) return { picked: [], typed: null }
  const labels = new Set(options.map((o) => o.label))
  if (labels.has(text)) return { picked: [text], typed: null }
  const parts = text.split(', ').map((p) => p.trim())
  if (parts.length > 1 && parts.every((p) => labels.has(p))) return { picked: parts, typed: null }
  return { picked: [], typed: text }
}

export function composeAnswer(
  questions: AskQuestion[],
  picks: Record<number, string[]>,
  /**
   * Question index → your own words, where you gave them instead of ticking.
   *
   * Free text used to replace the whole reply: one sentence went to Claude and
   * every tick on every other question was dropped. A question you answered in
   * your own words is still one answer among several, so it takes its place in
   * the list like any other.
   */
  typed: Record<number, string> = {}
): string {
  return questions
    .map((q, i) => {
      const own = (typed[i] ?? '').trim()
      const chosen = (picks[i] ?? []).filter(Boolean)
      const answer = own || chosen.join(', ')
      if (!answer) return null
      return questions.length > 1 ? `${q.question} ${answer}` : answer
    })
    .filter((line): line is string => line !== null)
    .join('\n')
}
