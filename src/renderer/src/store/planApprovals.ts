import { create } from 'zustand'

type PlanApprovalStore = {
  /** tool_id → the session whose stream is parked on that plan. */
  pending: Record<string, string | undefined>
  /**
   * tool_id → session, for a plan file written but not yet offered for approval.
   *
   * Claude Code's plan workflow tells the model to build a plan up by writing and
   * re-editing one file, so the write that produces a plan is almost never the
   * write that finishes it. Landing straight in `pending` made the card announce
   * "Awaiting your approval" over a half-written skeleton.
   */
  drafting: Record<string, string | undefined>
  add: (toolId: string, sessionId: string | undefined) => void
  draft: (toolId: string, sessionId: string | undefined) => void
  /** Everything this session has drafted now wants an answer. */
  promote: (sessionId: string) => void
  resolve: (toolId: string) => void
  clearSession: (sessionId: string) => void
}

type Owners = Record<string, string | undefined>

const without = (map: Owners, toolId: string): Owners => {
  const next = { ...map }
  delete next[toolId]
  return next
}

const notSession = (map: Owners, sessionId: string): Owners =>
  Object.fromEntries(Object.entries(map).filter(([, sid]) => sid !== sessionId))

/**
 * Plans awaiting a yes or no.
 *
 * ExitPlanMode deliberately bypasses the permission modal: a plan is something
 * you read, and a 384px dialog over the conversation is the wrong shape for
 * reading. It renders as a card in the transcript instead, and this is how that
 * card knows it still owes an answer — and which session's stream is waiting.
 *
 * `pending` means "owes an answer" and nothing else, which is what lets the
 * pinned card, the sidebar badge and `PlanCard`'s own `isPending` read it without
 * having to know that drafting exists at all.
 */
export const usePlanApprovalStore = create<PlanApprovalStore>()((set) => ({
  pending: {},
  drafting: {},
  add: (toolId, sessionId) => set((s) => ({ pending: { ...s.pending, [toolId]: sessionId } })),
  draft: (toolId, sessionId) => set((s) => ({ drafting: { ...s.drafting, [toolId]: sessionId } })),
  promote: (sessionId) =>
    set((s) => {
      const owed = Object.entries(s.drafting).filter(([, sid]) => sid === sessionId)
      if (owed.length === 0) return s
      return {
        pending: { ...s.pending, ...Object.fromEntries(owed) },
        drafting: notSession(s.drafting, sessionId)
      }
    }),
  resolve: (toolId) =>
    set((s) => ({ pending: without(s.pending, toolId), drafting: without(s.drafting, toolId) })),
  clearSession: (sessionId) =>
    set((s) => ({
      pending: notSession(s.pending, sessionId),
      drafting: notSession(s.drafting, sessionId)
    }))
}))
