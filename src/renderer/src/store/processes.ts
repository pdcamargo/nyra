import { create } from 'zustand'

export type BgProcess = BgProcessRow

export const EMPTY_PROCESSES: BgProcess[] = []

interface ProcessesState {
  bySession: Record<string, BgProcess[]>
  setForSession: (nyraSessionId: string, processes: BgProcess[]) => void
  clearSession: (nyraSessionId: string) => void
}

export const useProcessesStore = create<ProcessesState>((set) => ({
  bySession: {},
  setForSession: (nyraSessionId, processes) =>
    set((state) => ({
      bySession: { ...state.bySession, [nyraSessionId]: processes }
    })),
  clearSession: (nyraSessionId) =>
    set((state) => {
      const next = { ...state.bySession }
      delete next[nyraSessionId]
      return { bySession: next }
    })
}))

export function processesForSession(state: ProcessesState, nyraSessionId: string | null): BgProcess[] {
  if (!nyraSessionId) return []
  return state.bySession[nyraSessionId] ?? []
}
