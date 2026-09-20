import { composeAnswer, questionsOf } from './askBlocks'
import type { ToolCallMessage } from '../store/sessions'

/**
 * What pressing Enter in the composer actually means.
 *
 * The composer now has three jobs — send a message, answer a question, keep
 * planning — and which one it is doing depends on what else is on screen and on
 * which input you touched last. That decision is the whole of the new behaviour,
 * so it lives here as one pure function rather than spread through a 900-line
 * component where nothing can reach it.
 */
export type ComposerIntent =
  | { kind: 'message' }
  | { kind: 'answer'; toolId: string; answer: string }
  | { kind: 'keep-planning'; toolId: string; path?: string; note: string }
  /** A question is live but nothing has been said yet — Enter does nothing. */
  | { kind: 'none' }

export function composerIntent(opts: {
  text: string
  question: ToolCallMessage | null
  plan: ToolCallMessage | null
  /** Which input was touched last. See `useQuestionAnswerStore`. */
  mode: 'picked' | 'typed'
  picks: Record<number, string[]>
}): ComposerIntent {
  const { text, question, plan, mode, picks } = opts
  const typed = text.trim()

  // A question outranks a plan. They cannot both be live — a turn that ends by
  // asking something does not promote its plan — but if they ever were, the
  // question is the one holding the turn open.
  if (question) {
    const answer =
      mode === 'typed' && typed.length > 0 ? typed : composeAnswer(questionsOf(question.input), picks)
    return answer ? { kind: 'answer', toolId: question.tool_id, answer } : { kind: 'none' }
  }

  // While a plan waits, anything typed here means "not yet". That is why there
  // is no "Keep planning" button: it existed only to reveal a text field two
  // inches below the one already in front of you.
  if (plan && typed.length > 0) {
    const path = typeof plan.input.path === 'string' ? plan.input.path : undefined
    return { kind: 'keep-planning', toolId: plan.tool_id, path, note: typed }
  }

  return { kind: 'message' }
}
