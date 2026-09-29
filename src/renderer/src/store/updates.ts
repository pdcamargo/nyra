import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSettingsStore } from './settings'

/**
 * Where the next Nyra is, from "someone published it" to "it installs on quit".
 *
 * `restart` and `stage` are the two ways of taking it. `restart` is the button:
 * download, install, restart now, with the toast showing progress. `stage` is
 * "Update automatically": download quietly and let Rust install it on the way
 * out, so nothing restarts under a running Claude turn. A background download
 * shows no toast until it is ready — nobody asked to watch it.
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'available'; version: string }
  | {
      kind: 'downloading'
      version: string
      received: number
      total: number | null
      mode: 'restart' | 'stage'
    }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; version: string; message: string; mode: 'restart' | 'stage' }

type UpdatesStore = {
  phase: UpdatePhase
  /** The version whose toast was waved away with Later or ×. Not persisted:
   *  Later means "not this launch", not "never tell me about this one". */
  dismissed: string | null
  /** The version this install last opened as. Drives "What's new". */
  lastSeenVersion: string | null
  /** A check found `version`. Starts the background download when auto-update
   *  is on. */
  found: (version: string) => void
  install: () => Promise<void>
  stage: () => Promise<void>
  /** Try again the way it failed: a background download stays one. */
  retry: () => void
  progress: (p: { version: string; received: number; total: number | null }) => void
  dismiss: () => void
  setLastSeenVersion: (version: string) => void
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const useUpdatesStore = create<UpdatesStore>()(
  persist(
    (set, get) => ({
      phase: { kind: 'idle' },
      dismissed: null,
      lastSeenVersion: null,

      found: (version) => {
        const { phase } = get()
        // Already moving, or already staged: a second check reporting the same
        // release must not knock the toast back to "available".
        if (phase.kind !== 'idle' && phase.kind !== 'failed' && phase.version === version) return
        set({ phase: { kind: 'available', version } })
        if (useSettingsStore.getState().autoUpdate) void get().stage()
      },

      install: async () => {
        const { phase } = get()
        if (phase.kind === 'downloading' && phase.mode === 'restart') return
        const version = phase.kind === 'idle' ? '' : phase.version
        // A staged update installs from what is already on disk, so there is
        // nothing to show progress for — but the toast still says it is busy.
        set({
          phase: { kind: 'downloading', version, received: 0, total: null, mode: 'restart' },
          dismissed: null
        })
        try {
          // Succeeds by never returning — the app restarts into the new version.
          await window.api.updates.install()
        } catch (err) {
          set({
            phase: { kind: 'failed', version, message: message(err), mode: 'restart' },
            dismissed: null
          })
        }
      },

      stage: async () => {
        const { phase } = get()
        if (phase.kind !== 'available') return
        const { version } = phase
        set({ phase: { kind: 'downloading', version, received: 0, total: null, mode: 'stage' } })
        try {
          const staged = await window.api.updates.stage()
          // Pressing Update mid-download moves the phase on; don't undo that.
          const now = get().phase
          if (now.kind === 'downloading' && now.mode === 'stage') {
            set({ phase: { kind: 'ready', version: staged } })
          }
        } catch (err) {
          const now = get().phase
          if (now.kind === 'downloading' && now.mode === 'stage') {
            set({ phase: { kind: 'failed', version, message: message(err), mode: 'stage' } })
          }
        }
      },

      retry: () => {
        const { phase } = get()
        if (phase.kind !== 'failed') return
        if (phase.mode === 'restart') {
          void get().install()
          return
        }
        set({ phase: { kind: 'available', version: phase.version }, dismissed: null })
        void get().stage()
      },

      progress: ({ received, total }) => {
        const { phase } = get()
        if (phase.kind !== 'downloading') return
        set({ phase: { ...phase, received, total } })
      },

      dismiss: () => {
        const { phase } = get()
        if (phase.kind !== 'idle') set({ dismissed: phase.version })
      },

      setLastSeenVersion: (lastSeenVersion) => set({ lastSeenVersion })
    }),
    {
      name: 'nyra-updates',
      partialize: (s) => ({ lastSeenVersion: s.lastSeenVersion })
    }
  )
)

/** The version a toast or badge would name, or null when there is nothing. */
export function pendingVersion(phase: UpdatePhase): string | null {
  return phase.kind === 'idle' ? null : phase.version
}
