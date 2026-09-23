import React, { useEffect, useState } from 'react'
import { Info, X } from 'lucide-react'
import { useSessionsStore } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { useResourceDockStore } from '../store/resourceDock'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type AccountStatus = {
  loggedIn: boolean
  loginMethod: string | null
  organization: string | null
  email: string | null
  error: string | null
}

function StatusField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[11px] text-foreground" title={value}>{value}</dd>
    </div>
  )
}

/** A live status snapshot inside the existing composer outline. */
export default function StatusDock({ sessionId }: { sessionId: string }): React.JSX.Element {
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId))
  const binaryPath = useSettingsStore((state) => state.claudeBinaryPath)
  const close = useResourceDockStore((state) => state.close)
  const [version, setVersion] = useState<string | null>(null)
  const [account, setAccount] = useState<AccountStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.claude.checkBinary(binaryPath).then((result) => {
      if (!cancelled) setVersion(result.found ? result.version ?? null : null)
    }).catch(() => {
      if (!cancelled) setVersion(null)
    })
    void window.api.claude.accountStatus(binaryPath).then((result) => {
      if (!cancelled) setAccount(result)
    }).catch(() => {
      if (!cancelled) setAccount(null)
    })
    return () => { cancelled = true }
  }, [binaryPath])

  const display = (value: string | null | undefined): string => value || 'Unavailable'

  return (
    <section aria-label="Session status" className="mb-2 max-h-[min(42vh,320px)] overflow-y-auto border-b border-border/55 pb-3">
      <div className="mb-3 flex items-center gap-2">
        <Info className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground">Session status</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Close session status"
              onClick={() => close(sessionId)}
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close status</TooltipContent>
        </Tooltip>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 min-[460px]:grid-cols-2">
        <StatusField label="Claude Code" value={display(version)} />
        <StatusField label="Working directory" value={display(session?.cwd)} />
        <StatusField label="Session ID" value={session?.claudeSessionId ?? 'Not started'} />
        <StatusField label="Login method" value={account?.loggedIn ? display(account.loginMethod) : 'Not signed in'} />
        <StatusField label="Session kind" value="Local" />
        <StatusField label="Organization" value={display(account?.organization)} />
        <StatusField label="Peer address" value="Not applicable" />
        <StatusField label="Email" value={display(account?.email)} />
      </dl>
      {account?.error && <p className="mt-2 text-[10px] text-danger">{account.error}</p>}
    </section>
  )
}
