import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_WORKSPACE_ID } from './workspaces'

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

/** One account's readings. */
export type AccountLimits = {
  windows: Record<string, RateLimitWindow> // keyed by rateLimitType
  updatedAt: number | null
}

const NONE: AccountLimits = { windows: {}, updatedAt: null }

type RateLimitStore = {
  /** Keyed by workspace: every workspace is its own account with its own quota. */
  byWorkspace: Record<string, AccountLimits>
  setWindow: (workspaceId: string, window: RateLimitWindow) => void
  setUnified: (workspaceId: string, windows: UnifiedWindows) => void
  /** Forget one workspace's readings — it was deleted, or signed in as someone else. */
  clear: (workspaceId: string) => void
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

function expire(limits: AccountLimits, now: number): AccountLimits {
  const windows = dropExpired(limits.windows ?? {}, now)
  return { windows, updatedAt: Object.keys(windows).length > 0 ? (limits.updatedAt ?? null) : null }
}

/**
 * What was stored, per workspace and expired.
 *
 * Readings from before workspaces were one account's — the only one there was,
 * `~/.claude` — so they become Default's.
 */
export function migrateRateLimits(
  persisted: unknown,
  now: number = Date.now()
): Record<string, AccountLimits> {
  const p = (persisted ?? {}) as {
    byWorkspace?: Record<string, AccountLimits>
    windows?: Record<string, RateLimitWindow>
    updatedAt?: number | null
  }
  const byWorkspace: Record<string, AccountLimits> = { ...(p.byWorkspace ?? {}) }
  if (!p.byWorkspace && p.windows) {
    byWorkspace[DEFAULT_WORKSPACE_ID] = { windows: p.windows, updatedAt: p.updatedAt ?? null }
  }
  const out: Record<string, AccountLimits> = {}
  for (const [id, limits] of Object.entries(byWorkspace)) {
    const live = expire(limits, now)
    if (Object.keys(live.windows).length > 0) out[id] = live
  }
  return out
}

/**
 * Each account's limits, as last reported.
 *
 * Persisted, which is the only way this is ever populated when you open the
 * app. The numbers ride the CLI's event stream during a turn — there is no
 * usage subcommand to call and nothing cached on disk to read — so without
 * keeping the last reading the panel would say "nothing reported yet" every
 * launch until you happened to send a message. What is kept is stamped and
 * expired on load, so it is a reading with a time on it rather than a claim
 * about now.
 *
 * A reading comes from a chat's own event stream, so it is credited to that
 * chat's workspace — a turn in Work never moves Personal's meter.
 */
export const useRateLimitStore = create<RateLimitStore>()(
  persist(
    (set) => ({
      byWorkspace: {},
      setWindow: (workspaceId, window) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? NONE
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceId]: {
                windows: { ...current.windows, [window.rateLimitType]: window },
                updatedAt: Date.now()
              }
            }
          }
        }),
      /**
       * Merge rather than replace: the unified block names every window but
       * only the top-level event says which one is throttling, so a window
       * already marked throttled must not be reset to 'allowed' by the next
       * utilization tick that happens not to mention it.
       */
      setUnified: (workspaceId, windows) =>
        set((state) => {
          const next = { ...(state.byWorkspace[workspaceId] ?? NONE).windows }
          for (const [type, w] of Object.entries(windows)) {
            next[type] = {
              status: next[type]?.status ?? 'allowed',
              rateLimitType: type,
              resetsAt: w.resetsAt,
              utilization: w.utilization
            }
          }
          return {
            byWorkspace: { ...state.byWorkspace, [workspaceId]: { windows: next, updatedAt: Date.now() } }
          }
        }),
      clear: (workspaceId) =>
        set((state) => {
          if (!(workspaceId in state.byWorkspace)) return state
          const byWorkspace = { ...state.byWorkspace }
          delete byWorkspace[workspaceId]
          return { byWorkspace }
        })
    }),
    {
      name: 'nyra-rate-limits',
      partialize: (s) => ({ byWorkspace: s.byWorkspace }),
      merge: (persisted, current) => ({ ...current, byWorkspace: migrateRateLimits(persisted) })
    }
  )
)

/** One workspace's readings. Stable when it has none, so a selector can return it. */
export function limitsFor(state: Pick<RateLimitStore, 'byWorkspace'>, workspaceId: string): AccountLimits {
  return state.byWorkspace[workspaceId] ?? NONE
}
