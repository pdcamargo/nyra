import React, { useCallback, useEffect, useState } from 'react'
import type { CodexAccount } from '../lib/tauri-api'
import type { ConfigDir } from '../lib/api-types'
import { useCodexModels } from '../store/codexModels'

/**
 * A workspace's Codex account: who it is signed in as, and the way in or out.
 *
 * The sign-in is Codex's own browser flow, under the workspace's Codex home —
 * so Work's Codex and Personal's are two logins, as their Claude accounts are.
 * The browser says when it is done; until then this waits.
 */
export default function CodexAccountRow({ configDir }: { configDir: ConfigDir }): React.JSX.Element {
  const [account, setAccount] = useState<CodexAccount | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.api.codex.account(configDir).catch((e: unknown) => ({ available: false as const, error: String(e) }))
    setAccount(next)
    // What the picker offers is the account's, so it is asked again.
    useCodexModels.getState().reload(configDir)
  }, [configDir])

  useEffect(() => {
    void window.api.codex
      .account(configDir)
      .then(setAccount)
      .catch((e: unknown) => setAccount({ available: false, error: String(e) }))
  }, [configDir])

  useEffect(() => {
    if (!waiting) return
    return window.api.codex.onLogin((event) => {
      if (event.loginId !== waiting) return
      setWaiting(null)
      if (!event.success) setError(event.error ?? 'The sign-in did not finish.')
      void refresh()
    })
  }, [waiting, refresh])

  const signIn = async (): Promise<void> => {
    setError(null)
    try {
      const { loginId, authUrl } = await window.api.codex.login(configDir)
      setWaiting(loginId)
      await window.api.system.openExternal(authUrl)
    } catch (e) {
      setWaiting(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const signOut = async (): Promise<void> => {
    setError(null)
    await window.api.codex.logout(configDir).catch((e: unknown) => setError(String(e)))
    await refresh()
  }

  const status =
    account === null
      ? 'Checking…'
      : !account.available
        ? account.error
        : waiting
          ? 'Finish signing in in your browser…'
          : account.signedIn
            ? `Signed in as ${account.email ?? account.kind ?? 'an account'}${account.planType ? ` · ${account.planType}` : ''}`
            : 'Not signed in'

  const action =
    account?.available && !waiting
      ? account.signedIn
        ? { label: 'Sign out', run: signOut }
        : { label: 'Sign in', run: signIn }
      : null

  return (
    // min-w-0: a grid item, which otherwise sizes the modal to the full status
    // line and pushes its buttons out past the edge.
    <div className="flex min-w-0 items-center gap-3 border-t border-border/55 px-5 py-3">
      <div className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">Codex</span>
        <span className="block truncate text-xs text-foreground/80" title={status}>
          {status}
        </span>
        {error && <span className="block truncate text-xs text-danger">{error}</span>}
      </div>
      {action && (
        <button
          type="button"
          onClick={() => void action.run()}
          className="shrink-0 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
