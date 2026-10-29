/**
 * Secrets Claude is waiting on, per chat. See `lib/secretRequest.ts`.
 *
 * Not persisted, and never holds a value: what you type stays in the dock's
 * own state until it is handed to Rust. This only says what was asked and how
 * to answer it.
 */
import { create } from 'zustand'

export type SecretSpec = {
  name: string
  label: string
  reason: string
  placeholder: string
}

export type SecretOutcome = { outcome: 'done' | 'cancelled'; skipped: number[] }

export type SecretAsk = {
  requestId: string
  secrets: SecretSpec[]
  save: 'env' | 'file'
  /** The `.env` it goes into, or the folder for private files. */
  target: string
  resolve: (outcome: SecretOutcome) => void
}

type SecretsStore = {
  bySession: Record<string, SecretAsk[]>
  push: (sessionId: string, ask: SecretAsk) => void
  /** Answer and remove one request. Settling twice is a no-op. */
  settle: (sessionId: string, requestId: string, outcome: SecretOutcome) => void
}

export const useSecretsStore = create<SecretsStore>()((set, get) => ({
  bySession: {},
  push: (sessionId, ask) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: [...(s.bySession[sessionId] ?? []), ask] } })),
  settle: (sessionId, requestId, outcome) => {
    const ask = get().bySession[sessionId]?.find((a) => a.requestId === requestId)
    if (!ask) return
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: (s.bySession[sessionId] ?? []).filter((a) => a.requestId !== requestId)
      }
    }))
    ask.resolve(outcome)
  }
}))
