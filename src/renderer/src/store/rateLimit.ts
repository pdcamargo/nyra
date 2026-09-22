import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** One of the account's rolling limits. */
export type RateLimitWindow = {
  status: string // 'allowed' | 'throttled' | ...
  resetsAt: number // Unix seconds
  rateLimitType: string // 'five_hour' | 'seven_day'
  /**
   * 0..1, the share of the window spent.
   *
   * Optional because the top-level rate_limit_event carries a status and a
   * reset and nothing else; the number arrives with `unifiedWindows`, and only
   * once a turn has actually run. Absent means unknown, which is not zero — a
   * window drawn at 0% before the first reply is a lie about a fresh quota.
   */
  utilization?: number
}

/** What the CLI reports under `rate_limit_info.unifiedWindows`. */
export type UnifiedWindows = Record<string, { resetsAt: number; utilization: number }>

type RateLimitStore = {
  windows: Record<string, RateLimitWindow> // keyed by rateLimitType
  updatedAt: number | null
  setWindow: (window: RateLimitWindow) => void
  setUnified: (windows: UnifiedWindows) => void
  clear: () => void
}

/**
 * Forget any window that has since rolled over.
 *
 * A reading is only true until its own `resetsAt`. Past that the window started
 * again from nothing and the stored number describes a quota that no longer
 * exists — showing last night's 42% as this morning's weekly is worse than
 * admitting we have not heard yet.
 */
export function dropExpired(
  windows: Record<string, RateLimitWindow>,
  now: number = Date.now()
): Record<string, RateLimitWindow> {
  const live: Record<string, RateLimitWindow> = {}
  for (const [type, w] of Object.entries(windows)) {
    if (w.resetsAt * 1000 > now) live[type] = w
  }
  return live
}

/**
 * The account's limits, as last reported.
 *
 * Persisted, which is the only way this is ever populated when you open the
 * app. The numbers ride the CLI's event stream during a turn — there is no
 * usage subcommand to call and nothing cached on disk to read — so without
 * keeping the last reading the panel would say "nothing reported yet" every
 * launch until you happened to send a message. What is kept is stamped and
 * expired on load, so it is a reading with a time on it rather than a claim
 * about now.
 */
export const useRateLimitStore = create<RateLimitStore>()(
  persist(
    (set) => ({
      windows: {},
      updatedAt: null,
      setWindow: (window) =>
        set((state) => ({
          windows: { ...state.windows, [window.rateLimitType]: window },
          updatedAt: Date.now()
        })),
      /**
       * Merge rather than replace: the unified block names every window but
       * only the top-level event says which one is throttling, so a window
       * already marked throttled must not be reset to 'allowed' by the next
       * utilization tick that happens not to mention it.
       */
      setUnified: (windows) =>
        set((state) => {
          const next = { ...state.windows }
          for (const [type, w] of Object.entries(windows)) {
            next[type] = {
              status: next[type]?.status ?? 'allowed',
              rateLimitType: type,
              resetsAt: w.resetsAt,
              utilization: w.utilization
            }
          }
          return { windows: next, updatedAt: Date.now() }
        }),
      clear: () => set({ windows: {}, updatedAt: null })
    }),
    {
      name: 'nyra-rate-limits',
      partialize: (s) => ({ windows: s.windows, updatedAt: s.updatedAt }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<RateLimitStore>
        const windows = dropExpired(p.windows ?? {})
        return {
          ...current,
          windows,
          updatedAt: Object.keys(windows).length > 0 ? (p.updatedAt ?? null) : null
        }
      }
    }
  )
)
