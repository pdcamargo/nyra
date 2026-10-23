/**
 * "None of these — let me just tell you."
 *
 * Claude's questions are an offer, not a gate. Before this, a question it
 * stopped for took the composer over — anything typed became its answer — and
 * the only way to say something else was to answer first. Ignoring drops every
 * open question in the chat at once and hands the composer back.
 */
import { useSessionsStore, type ToolCallMessage } from '../store/sessions'
import { useQuestionAnswerStore } from '../store/questionAnswer'

/** Whether a chat has a question that is still waiting: one Claude stopped
 *  for, or one it carried on past and nobody has settled. */
export function hasOpenQuestions(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
  return (session?.messages ?? []).some((m) => {
    if (m.role !== 'tool_call') return false
    const tc = m as ToolCallMessage
    if (tc.tool_name !== 'AskUserQuestion') return false
    if (tc.deferred) return tc.deferred === 'open'
    return tc.result === undefined && !tc.denied && !tc.ignored
  })
}

export function ignoreQuestions(sessionId: string): void {
  useSessionsStore.getState().ignoreQuestions(sessionId)
  // Picks made on the docked question go with it. What is in the composer
  // stays: half an answer is often the start of what you meant to say instead.
  useQuestionAnswerStore.getState().clear()
}
