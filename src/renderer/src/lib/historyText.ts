import type { Message, TextMessage } from '../store/sessions'

/**
 * The conversation so far as plain text, for a process that has none of it.
 *
 * Only for that. A process resumed or forked from the CLI's own transcript
 * already holds every one of these turns, and handing it this as well sends the
 * conversation twice. It is the fallback for messages sent before Nyra recorded
 * where each one sat in that transcript.
 */
export function historyText(messages: Message[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') parts.push(`User: ${(m as TextMessage).text}`)
    else if (m.role === 'assistant') parts.push(`Assistant: ${(m as TextMessage).text}`)
  }
  return parts.length > 0 ? `[Previous conversation]\n${parts.join('\n')}\n\n` : ''
}
