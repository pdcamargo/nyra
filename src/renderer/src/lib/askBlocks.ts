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
