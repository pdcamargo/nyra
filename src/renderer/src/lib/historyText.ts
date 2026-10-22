import type { Message, Session, TextMessage } from '../store/sessions'
import { PROVIDER_LABEL, anchorFor } from './providers'
import type { Provider } from '@shared/types'

/**
 * The conversation so far as plain text, for a process that has none of it.
 *
 * Only for that. A process resumed or forked from the CLI's own transcript
 * already holds every one of these turns, and handing it this as well sends the
 * conversation twice. It is the fallback for messages sent before Nyra recorded
 * where each one sat in that transcript — and for a chat moving to another CLI,
 * which has no transcript of it at all.
 */
export function historyText(messages: Message[], heading = 'Previous conversation'): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') parts.push(`User: ${(m as TextMessage).text}`)
    else if (m.role === 'assistant') parts.push(`Assistant: ${(m as TextMessage).text}`)
  }
  return parts.length > 0 ? `[${heading}]\n${parts.join('\n')}\n\n` : ''
}

type RecapSource = Pick<Session, 'provider' | 'providerSessionIds' | 'providerSeenThrough' | 'needsRecap' | 'resumeFrom' | 'messages'>

/**
 * What goes ahead of the next prompt so the chat's CLI knows what it missed.
 *
 * A chat that has only ever run on one CLI gets nothing here beyond the old
 * fork fallback: its process already holds the conversation. One that has run
 * on another since gets the messages after the last one this CLI saw — not the
 * whole chat again — under a heading that says another assistant wrote them.
 * Prose only: tool calls and their output stay behind, which is most of what a
 * transcript costs.
 */
export function recapFor(session: RecapSource): string {
  if (session.needsRecap) return historyText(session.messages)
  const seen = session.providerSeenThrough ?? {}
  const other = (Object.keys(seen) as Provider[]).find((p) => p !== session.provider)
  if (!other) {
    // A fork whose cut is in the other CLI's transcript: the history it was
    // going to fork is all this one can have.
    const stranded = session.resumeFrom && !anchorFor(session, session.resumeFrom) && !session.providerSessionIds[session.provider]
    return stranded ? historyText(session.messages) : ''
  }
  const mine = seen[session.provider]
  const from = mine ? session.messages.findIndex((m) => m.id === mine) + 1 : 0
  return historyText(session.messages.slice(from), `Earlier in this chat, with ${PROVIDER_LABEL[other]}`)
}
