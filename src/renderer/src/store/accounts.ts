import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AccountStatus } from '../lib/api-types'
import { configDirOf } from './workspaces'
import { useSettingsStore } from './settings'

/** Who a workspace is signed in as, when we last asked. */
export type AccountInfo = Pick<
  AccountStatus,
  'loggedIn' | 'loginMethod' | 'organization' | 'email' | 'displayName' | 'subscriptionType' | 'configDirectory'
> & { fetchedAt: number }

type AccountsState = {
  byWorkspace: Record<string, AccountInfo>
  /** Workspaces with an `auth status` in flight, so a burst of refreshes asks once. */
  loading: Record<string, true>
  refresh: (workspaceId: string) => Promise<AccountInfo | null>
  /** Keep an answer someone else already asked for — a sign-in confirming itself. */
  record: (workspaceId: string, status: AccountStatus) => AccountInfo
  forget: (workspaceId: string) => void
}

function toInfo(status: AccountStatus): AccountInfo {
  return {
    loggedIn: status.loggedIn,
    loginMethod: status.loginMethod,
    organization: status.organization,
    email: status.email,
    displayName: status.displayName,
    subscriptionType: status.subscriptionType,
    configDirectory: status.configDirectory,
    fetchedAt: Date.now()
  }
}

/**
 * Each workspace's account, cached.
 *
 * Asked of `claude auth status` for that workspace's config dir when it becomes
 * active — launch included — and again after a sign-in completes. Kept across
 * launches so the usage row has a name the moment the window opens; the
 * refresh that follows corrects it if the login changed while Nyra was closed.
 */
export const useAccountsStore = create<AccountsState>()(
  persist(
    (set, get) => ({
      byWorkspace: {},
      loading: {},

      refresh: async (workspaceId) => {
        if (get().loading[workspaceId]) return get().byWorkspace[workspaceId] ?? null
        set((s) => ({ loading: { ...s.loading, [workspaceId]: true } }))
        try {
          const binary = useSettingsStore.getState().claudeBinaryPath
          const status = await window.api.claude.accountStatus(binary, configDirOf(workspaceId))
          // Could not ask (no binary, a timeout): keep what we knew rather than
          // claiming a signed-in account is signed out.
          if (status.error) return get().byWorkspace[workspaceId] ?? null
          return get().record(workspaceId, status)
        } catch {
          return get().byWorkspace[workspaceId] ?? null
        } finally {
          set((s) => {
            const loading = { ...s.loading }
            delete loading[workspaceId]
            return { loading }
          })
        }
      },

      record: (workspaceId, status) => {
        const info = toInfo(status)
        set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: info } }))
        return info
      },

      forget: (workspaceId) =>
        set((s) => {
          if (!(workspaceId in s.byWorkspace)) return s
          const byWorkspace = { ...s.byWorkspace }
          delete byWorkspace[workspaceId]
          return { byWorkspace }
        })
    }),
    {
      name: 'nyra-accounts',
      partialize: (s) => ({ byWorkspace: s.byWorkspace })
    }
  )
)

/** What to call an account in one line: its name, else its email. */
export function accountLabel(info: AccountInfo | null | undefined): string | null {
  if (!info?.loggedIn) return null
  return info.displayName?.trim() || info.email?.trim() || null
}
