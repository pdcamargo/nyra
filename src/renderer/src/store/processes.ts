import { create } from 'zustand'

export type BgProcess = BgProcessRow

export const EMPTY_PROCESSES: BgProcess[] = []

/**
 * Still going, as far as the registry knows.
 *
 * Untracked means its pid was never found, not that it stopped — on Windows the
 * hunt misses often, and a call announced late (queued behind a permission
 * prompt) misses its window every time. Orphaned means its Claude went away
 * while it did not. Reading only `running` hid those from the composer and the
 * summary while they were still working.
 */
export function stillRunning(proc: BgProcess | undefined): boolean {
  return proc?.status === 'running' || proc?.status === 'untracked' || proc?.status === 'orphaned'
}

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
