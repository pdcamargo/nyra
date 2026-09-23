import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { McpHealthEntry } from '../lib/api-types'

/**
 * What `claude mcp list` said about each directory's servers.
 *
 * A chat only learns its servers' status from the CLI's init event, which
 * arrives with the first message — so before that, every row was "not started"
 * and the list was empty outside a chat. This is the same answer asked for
 * ahead of time: warmed at launch, cached per directory, and overridden by the
 * chat's own report the moment it has one.
 *
 * The last answer is kept across launches, and only the answer — names and
 * statuses, which is all the check returns. Without it the list opened on the
 * five servers a config file names and then grew by twenty connectors a few
 * seconds later. With it the whole list is there at once, as last seen, and the
 * launch's own check corrects it. `checkedAt` is not kept, so every launch
 * still checks.
 */

export type McpHealthCheck = {
  servers: McpHealthEntry[]
  checkedAt: number | null
  loading: boolean
  error?: string
}

/** How old a check can be before opening the list asks again. Each check
 *  connects to every server once, so this is not free. */
export const MCP_HEALTH_STALE_MS = 5 * 60 * 1000

const EMPTY_CHECK: McpHealthCheck = { servers: [], checkedAt: null, loading: false }

type McpHealthState = {
  byCwd: Record<string, McpHealthCheck>
  /** Check `cwd` unless a check is already running, or one finished within
   *  `maxAgeMs`. `Infinity` means "only if never checked" this launch. */
  warm: (cwd: string, maxAgeMs?: number) => void
}

export const useMcpHealthStore = create<McpHealthState>()(
  persist(
    (set, get) => ({
      byCwd: {},

      warm: (cwd, maxAgeMs = MCP_HEALTH_STALE_MS) => {
        if (!cwd) return
        const current = get().byCwd[cwd]
        if (current?.loading) return
        if (current?.checkedAt != null && Date.now() - current.checkedAt < maxAgeMs) return

        const put = (patch: Partial<McpHealthCheck>): void => {
          set((state) => ({
            byCwd: { ...state.byCwd, [cwd]: { ...(state.byCwd[cwd] ?? EMPTY_CHECK), ...patch } }
          }))
        }

        put({ loading: true })
        void window.api.mcp
          .health(cwd)
          .then((result) =>
            result.ok
              ? put({ servers: result.servers, checkedAt: Date.now(), loading: false, error: undefined })
              : put({ checkedAt: Date.now(), loading: false, error: result.error })
          )
          .catch((error: unknown) =>
            put({ checkedAt: Date.now(), loading: false, error: String(error) })
          )
      }
    }),
    {
      name: 'nyra-mcp-health',
      partialize: (state) => ({
        byCwd: Object.fromEntries(
          Object.entries(state.byCwd)
            .filter(([, check]) => check.servers.length > 0)
            .map(([cwd, check]) => [cwd, { ...EMPTY_CHECK, servers: check.servers }])
        )
      })
    }
  )
)
