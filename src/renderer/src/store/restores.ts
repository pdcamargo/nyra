import { create } from 'zustand'

/**
 * How a restore went, shown under the message it was asked from until it is
 * dismissed or the chat moves on. Only kept when there is something to say:
 * a restore that brought everything back says nothing.
 */
export type RestoreReport = {
  /** The message it shows under. */
  at: string
  /** Whose files came back, by version number; null for "before this turn". */
  version: number | null
  /** Files that held changes Claude's edits don't account for, which the
   *  restore replaced. */
  overwritten: string[]
  /** The version their copy is kept with. */
  savedWith: number | null
  /** Shell commands whose changes nothing could undo. */
  commands: string[]
  /** Set when nothing was restored at all. */
  error?: string
}

/**
 * File restores under way, and the reports they leave.
 *
 * Not persisted, for the reason `running.ts` gives: a restore does not survive
 * a reload, and a report about one is only worth reading right after it.
 */
interface RestoresState {
  /** Chat id → the message whose restore is under way. */
  busy: Record<string, string>
  reports: Record<string, RestoreReport>
  start: (sessionId: string, at: string) => void
  finish: (sessionId: string, report: RestoreReport | null) => void
  dismiss: (sessionId: string) => void
}

export const useRestoresStore = create<RestoresState>((set) => ({
  busy: {},
  reports: {},

  start: (sessionId, at) =>
    set((state) => {
      const { [sessionId]: _gone, ...reports } = state.reports
      return { busy: { ...state.busy, [sessionId]: at }, reports }
    }),

  finish: (sessionId, report) =>
    set((state) => {
      const { [sessionId]: _done, ...busy } = state.busy
      return { busy, reports: report ? { ...state.reports, [sessionId]: report } : state.reports }
    }),

  dismiss: (sessionId) =>
    set((state) => {
      if (!state.reports[sessionId]) return state
      const { [sessionId]: _gone, ...reports } = state.reports
      return { reports }
    })
}))

export function isRestoring(sessionId: string): boolean {
  return sessionId in useRestoresStore.getState().busy
}
