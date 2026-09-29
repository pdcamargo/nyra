/**
 * Claude operating other apps, per chat: what it is controlling right now, the
 * questions it is waiting on, and a permission it found missing.
 *
 * Not persisted. All of it describes a turn in flight; none of it means
 * anything after a restart. What does persist — the apps answered "always" —
 * lives in settings, because Rust reads it from there.
 */
import { create } from 'zustand'
import type { DesktopFix, DesktopPermissionKind } from '../lib/tauri-api'

export type DesktopAnswer = 'chat' | 'always' | 'no'

export type DesktopAsk = {
  key: string
  app: { id: string; name: string }
  /** What allowing this app means, for the broad ones (Finder, editors). */
  warning: string | null
  resolve: (answer: DesktopAnswer | 'dismissed') => void
}

export type DesktopBlock = {
  kind: DesktopPermissionKind
  reason: string
  fix: DesktopFix | null
}

export type ChatDesktop = {
  controlling: string | null
  asks: DesktopAsk[]
  blocked: DesktopBlock | null
}

export const EMPTY_DESKTOP: ChatDesktop = { controlling: null, asks: [], blocked: null }

type DesktopStore = {
  bySession: Record<string, ChatDesktop>
  setControlling: (sessionId: string, app: string | null) => void
  pushAsk: (sessionId: string, ask: DesktopAsk) => void
  /** Settle and remove one question. Settling twice is a no-op. */
  settleAsk: (sessionId: string, key: string, answer: DesktopAnswer | 'dismissed') => void
  setBlocked: (sessionId: string, blocked: DesktopBlock | null) => void
}

const patch = (
  state: DesktopStore,
  sessionId: string,
  next: Partial<ChatDesktop>
): Pick<DesktopStore, 'bySession'> => ({
  bySession: {
    ...state.bySession,
    [sessionId]: { ...(state.bySession[sessionId] ?? EMPTY_DESKTOP), ...next }
  }
})

export const useDesktopStore = create<DesktopStore>()((set, get) => ({
  bySession: {},
  setControlling: (sessionId, controlling) => set((s) => patch(s, sessionId, { controlling })),
  pushAsk: (sessionId, ask) =>
    set((s) => patch(s, sessionId, { asks: [...(s.bySession[sessionId]?.asks ?? []), ask] })),
  settleAsk: (sessionId, key, answer) => {
    const ask = get().bySession[sessionId]?.asks.find((a) => a.key === key)
    if (!ask) return
    set((s) =>
      patch(s, sessionId, { asks: (s.bySession[sessionId]?.asks ?? []).filter((a) => a.key !== key) })
    )
    ask.resolve(answer)
  },
  setBlocked: (sessionId, blocked) => set((s) => patch(s, sessionId, { blocked }))
}))
