import type { Message } from '../store/sessions'

/**
 * A finished turn's working, folded behind one "Worked for 3m 38s" row: the
 * tool calls and the narration between the prompt and the reply that closes
 * the turn. What the turn came to is that reply, and it stays in view; so does
 * anything the caller says must (a plan, a question, an error).
 */
export type TurnFold = {
  /** The prompt's id, which the turn is remembered by when opened. */
  id: string
  /** The first message folded away: where the row goes. */
  first: string
  /** Prompt to reply, when both carry a time. */
  durationMs?: number
}

/**
 * Each folded message's fold, by message id. The turn still running has no
 * reply to close it yet and folds nothing, and neither does a turn that ended
 * without one (stopped mid-tool, say): there would be nothing left in view.
 */
export function turnFolds(
  messages: Message[],
  running: boolean,
  stays: (m: Message) => boolean
): Map<string, TurnFold> {
  const byMessage = new Map<string, TurnFold>()
  let start = messages.findIndex((m) => m.role === 'user')
  while (start >= 0) {
    let next = messages.findIndex((m, i) => i > start && m.role === 'user')
    if (next < 0) next = messages.length
    const last = next === messages.length
    if (!(last && running)) {
      let end = -1
      for (let i = next - 1; i > start; i--) {
        if (messages[i].role === 'assistant') {
          end = i
          break
        }
      }
      const folded = end > start ? messages.slice(start + 1, end).filter((m) => !stays(m)) : []
      if (folded.length > 0) {
        const prompt = messages[start]
        const reply = messages[end]
        const fold: TurnFold = {
          id: prompt.id,
          first: folded[0].id,
          ...(prompt.timestamp && reply.timestamp ? { durationMs: reply.timestamp - prompt.timestamp } : {})
        }
        for (const m of folded) byMessage.set(m.id, fold)
      }
    }
    start = next < messages.length ? next : -1
  }
  return byMessage
}
