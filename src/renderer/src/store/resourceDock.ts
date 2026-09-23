import { create } from 'zustand'

export type ResourceDockKind = 'mcp' | 'status'

type ResourceDockStore = {
  bySession: Record<string, ResourceDockKind | undefined>
  open: (sessionId: string, kind: ResourceDockKind) => void
  close: (sessionId: string) => void
  forget: (sessionId: string) => void
}

/** Ephemeral, per-chat views that share the composer outline. */
export const useResourceDockStore = create<ResourceDockStore>()((set) => ({
  bySession: {},
  open: (sessionId, kind) =>
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: kind } })),
  close: (sessionId) =>
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: undefined } })),
  forget: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySession)) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession }
    })
}))
