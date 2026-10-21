import type { MessageContext } from '../store/sessions'
import type { SideThread } from '../store/sideQuestions'

/** `/btw <question>`: the CLI's own name for a side question, so the habit carries over. */
const BTW = /^\/btw(?:\s+([\s\S]*))?$/i

/** The question in a `/btw` line, `''` for a bare `/btw`, or null when it is not one. */
export function btwQuestion(text: string): string | null {
  const m = BTW.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}

const quoted = (text: string): string =>
  text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')

/**
 * Kept side threads as the context a message carries.
 *
 * Claude answered these in a process the main conversation never saw, so the
 * body says as much: without it, "as you said on the side" reads as a memory
 * the model does not have.
 */
export function sideContext(threads: SideThread[]): MessageContext {
  const entries = threads.map((t) => {
    const parts: string[] = []
    if (t.quote) parts.push(`About ${t.quote.source === 'user' ? 'my earlier message' : 'your reply'}:`, quoted(t.quote.quote))
    for (const turn of t.turns) parts.push(`Q: ${turn.question.trim()}`, `A: ${turn.answer.trim()}`)
    return parts.join('\n')
  })
  const first = threads[0]?.turns[0]?.question.trim() ?? ''
  return {
    kind: 'side-question',
    label: threads.length === 1 ? `Side answer: ${first}` : `${threads.length} side answers`,
    body: [
      '<side_questions>',
      "I asked these on the side while you worked. They were answered in a separate thread forked from this conversation, which you can't see, so here is what was said:",
      '',
      entries.join('\n\n'),
      '</side_questions>'
    ].join('\n')
  }
}

/**
 * The prompt the side process gets. Read-only by construction (its tools are
 * cut down at spawn), and told so, so it does not offer to make the change.
 */
export function sidePrompt(question: string, quote?: SideThread['quote']): string {
  const lead =
    'This is a side question, asked in a throwaway fork of our conversation. Answer it briefly and directly. Do not change any files or start work; the main thread is carrying on without this.'
  if (!quote) return `${lead}\n\n${question.trim()}`
  const where = quote.source === 'user' ? 'my earlier message' : 'your reply'
  return `${lead}\n\nAbout this part of ${where}:\n${quoted(quote.quote)}\n\n${question.trim()}`
}
