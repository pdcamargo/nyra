import { create } from 'zustand'

type PlanApprovalStore = {
  /** tool_id → the session whose stream is parked on that plan. */
  pending: Record<string, string | undefined>
  add: (toolId: string, sessionId: string | undefined) => void
  resolve: (toolId: string) => void
  clearSession: (sessionId: string) => void
}

/**
 * Plans awaiting a yes or no.
 *
 * ExitPlanMode deliberately bypasses the permission modal: a plan is something
 * you read, and a 384px dialog over the conversation is the wrong shape for
 * reading. It renders as a card in the transcript instead, and this is how that
 * card knows it still owes an answer — and which session's stream is waiting.
 */
export const usePlanApprovalStore = create<PlanApprovalStore>()((set) => ({
  pending: {},
  add: (toolId, sessionId) => set((s) => ({ pending: { ...s.pending, [toolId]: sessionId } })),
  resolve: (toolId) =>
    set((s) => {
      const next = { ...s.pending }
      delete next[toolId]
      return { pending: next }
    }),
  clearSession: (sessionId) =>
    set((s) => ({
      pending: Object.fromEntries(
        Object.entries(s.pending).filter(([, sid]) => sid !== sessionId)
      )
    }))
}))
