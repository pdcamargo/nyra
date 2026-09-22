import { composeAnswer, questionsOf } from './askBlocks'
import type { ToolCallMessage } from '../store/sessions'

/**
 * What pressing Enter in the composer actually means.
 *
 * The composer now has three jobs — send a message, answer a question, keep
 * planning — and which one it is doing depends on what else is on screen and on
 * what has been answered so far. That decision is the whole of the new
 * behaviour, so it lives here as one pure function rather than spread through a
 * 900-line component where nothing can reach it.
 */
export type ComposerIntent =
  | { kind: 'message' }
  | { kind: 'answer'; toolId: string; answer: string }
  /**
   * A set of questions, and this is not the last one: Enter takes what is in the
   * composer as *this* question's answer and moves to the next, rather than
   * ending the whole set. Typing on question 1 used to submit immediately and
   * throw away every other answer.
   */
  | { kind: 'next-question'; toolId: string; page: number }
  | { kind: 'keep-planning'; toolId: string; path?: string; note: string }
  /** A question is live but nothing has been said yet — Enter does nothing. */
  | { kind: 'none' }

export function composerIntent(opts: {
  text: string
  question: ToolCallMessage | null
  plan: ToolCallMessage | null
  /** Question index → labels ticked. See `useQuestionAnswerStore`. */
  picks: Record<number, string[]>
  /** Question index → your own words, for the questions you typed on. */
  typed?: Record<number, string>
  /** Which question is on screen. */
  page?: number
}): ComposerIntent {
  const { text, question, plan, picks, typed = {}, page = 0 } = opts
  const typedNow = text.trim()

  // A question outranks a plan. They cannot both be live — a turn that ends by
  // asking something does not promote its plan — but if they ever were, the
  // question is the one holding the turn open.
  if (question) {
    const questions = questionsOf(question.input)
    // The composer is the truth for the question on screen — except where that
    // question has been ticked since, which clears its typed answer in the
    // store. Reading the live box unconditionally would resurrect words the
    // tick had already overruled, and the tick would silently not count.
    const overruled = (picks[page] ?? []).length > 0
    const answers = overruled ? typed : { ...typed, [page]: text }
    const answeredHere = overruled || typedNow.length > 0

    if (page < questions.length - 1) {
      return answeredHere ? { kind: 'next-question', toolId: question.tool_id, page } : { kind: 'none' }
    }

    const answer = composeAnswer(questions, picks, answers)
    return answer ? { kind: 'answer', toolId: question.tool_id, answer } : { kind: 'none' }
  }

  // While a plan waits, anything typed here means "not yet". That is why there
  // is no "Keep planning" button: it existed only to reveal a text field two
  // inches below the one already in front of you.
  if (plan && typedNow.length > 0) {
    const path = typeof plan.input.path === 'string' ? plan.input.path : undefined
    return { kind: 'keep-planning', toolId: plan.tool_id, path, note: typedNow }
  }

  return { kind: 'message' }
}
