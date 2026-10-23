/**
 * Messages sent from outside the composer, and what they carry beyond their text.
 *
 * The questionnaire's Send, a comment on a design and a flow run reporting back
 * all post into a chat without going through the composer. `Chat.tsx` receives
 * them and sends at once, or queues behind a running turn — the same as typing.
 */
import type { MessageContext } from '../store/sessions'
import { useAnnotationsStore } from '../store/annotations'
import { useSideQuestionsStore } from '../store/sideQuestions'
import { annotationContext } from './chatAnnotations'
import { sideContext } from './sideQuestions'

export type SendToChat = { sessionId: string; text: string; context?: MessageContext[] }

type Receiver = (detail: SendToChat) => void
let receiver: Receiver | null = null
/** Sent while no chat view was mounted, delivered when one is. */
const held: SendToChat[] = []

/**
 * Post into a chat.
 *
 * Held when nothing is listening rather than dropped. This used to be a window
 * event, and `Chat` unmounts while the Flows view is open — so a run that
 * paused for a chat while you watched it on the canvas told nobody.
 */
export function sendToChat(detail: SendToChat): void {
  if (receiver) receiver(detail)
  else held.push(detail)
}

/** Become the one place messages from outside the composer arrive. */
export function receiveSendToChat(fn: Receiver): () => void {
  receiver = fn
  for (const detail of held.splice(0)) fn(detail)
  return () => {
    if (receiver === fn) receiver = null
  }
}

/**
 * The prompt Claude receives: the text, then each context's body. The bubble
 * stores the text alone and shows each context as its one-line label.
 */
export function withContext(prompt: string, context: MessageContext[] | undefined): string {
  if (!context?.length) return prompt
  return [prompt.trim(), ...context.map((c) => c.body.trim())].filter(Boolean).join('\n\n')
}

/**
 * What goes with the next thing sent in a chat: its pending annotations and the
 * side answers kept for it. Left where they are — see `takePendingContext`.
 */
export function pendingContext(sessionId: string): MessageContext[] | undefined {
  const annotations = useAnnotationsStore.getState().bySession[sessionId] ?? []
  const kept = useSideQuestionsStore.getState().kept[sessionId] ?? []
  const context = [
    ...(annotations.length > 0 ? [annotationContext(annotations)] : []),
    ...(kept.length > 0 ? [sideContext(kept)] : [])
  ]
  return context.length > 0 ? context : undefined
}

/**
 * The same, handed over: the trays empty.
 *
 * An answer to one of Claude's questions is something sent too. Only a plain
 * message used to take these, so annotations made to explain an answer stayed
 * in the tray while the answer went without them.
 */
export function takePendingContext(sessionId: string): MessageContext[] | undefined {
  const context = pendingContext(sessionId)
  if (context) {
    useAnnotationsStore.getState().take(sessionId)
    useSideQuestionsStore.getState().take(sessionId)
  }
  return context
}
