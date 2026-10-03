/**
 * Messages sent from outside the composer, and what they carry beyond their text.
 *
 * The questionnaire's Send and a comment on a design both post into a chat
 * without going through the composer. They dispatch `SEND_TO_CHAT`; `Chat.tsx`
 * sends it at once, or queues it behind a running turn — the same as typing it.
 */
import type { MessageContext } from '../store/sessions'

export const SEND_TO_CHAT = 'nyra:send-to-chat'

export type SendToChat = { sessionId: string; text: string; context?: MessageContext[] }

export function sendToChat(detail: SendToChat): void {
  window.dispatchEvent(new CustomEvent<SendToChat>(SEND_TO_CHAT, { detail }))
}

/**
 * The prompt Claude receives: the text, then each context's body. The bubble
 * stores the text alone and shows each context as its one-line label.
 */
export function withContext(prompt: string, context: MessageContext[] | undefined): string {
  if (!context?.length) return prompt
  return [prompt.trim(), ...context.map((c) => c.body.trim())].filter(Boolean).join('\n\n')
}
