import React, { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useUpdatesStore } from '../store/updates'

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'failed'; message: string }

/**
 * The version, and a way to move off it.
 *
 * Checking is this row's own business. What happens to a release once one is
 * found — downloading, staged for quit, failed to install — lives in the
 * updates store, so this row and the toast can never disagree about it.
 *
 * A failure is shown rather than swallowed. A typo in the endpoint and a
 * genuinely unreachable network look identical from in here, and reporting
 * "you're up to date" for both is how an updater quietly stops updating.
 */
export default function UpdateRow(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [check, setCheck] = useState<Check>({ kind: 'idle' })
  const phase = useUpdatesStore((s) => s.phase)

  useEffect(() => {
    void window.api.updates.version().then(setVersion).catch(() => setVersion(''))
  }, [])

  const runCheck = async (): Promise<void> => {
    setCheck({ kind: 'checking' })
    try {
      const result = await window.api.updates.check()
      if (result.available) {
        setCheck({ kind: 'idle' })
        useUpdatesStore.getState().found(result.version)
      } else {
        setCheck({ kind: 'current' })
      }
    } catch (err) {
      setCheck({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const install = (): void => void useUpdatesStore.getState().install()
  const installing = phase.kind === 'downloading' && phase.mode === 'restart'
  const offer = phase.kind === 'available' || phase.kind === 'ready'

  let status: React.ReactNode = null
  if (phase.kind === 'available') {
    status = <span className="text-info"> — {phase.version} is available</span>
  } else if (phase.kind === 'downloading') {
    status = <span className="text-muted-foreground"> — downloading {phase.version}</span>
  } else if (phase.kind === 'ready') {
    status = <span className="text-info"> — {phase.version} installs when you quit</span>
  } else if (phase.kind === 'failed') {
    status = <span className="text-danger"> — {phase.message}</span>
  } else if (check.kind === 'current') {
    status = <span className="text-muted-foreground"> — up to date</span>
  } else if (check.kind === 'failed') {
    status = <span className="text-danger"> — {check.message}</span>
  }

  const busy = check.kind === 'checking' || installing

  return (
    <div className="flex items-center justify-between gap-3 border-b border-separator py-2.5">
      <span className="text-xs text-foreground/80">
        Nyra <span className="font-mono text-muted-foreground">{version || '…'}</span>
        {status}
      </span>

      {offer ? (
        <button
          type="button"
          onClick={install}
          className="shrink-0 rounded-lg bg-info px-3 py-1.5 text-xs font-medium text-info-foreground transition-opacity hover:opacity-85"
        >
          {phase.kind === 'ready' ? 'Restart now' : 'Update and restart'}
        </button>
      ) : (
        <button
          type="button"
          onClick={runCheck}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className="size-3.5" />
          {/* The label carries the state, so checking says so — it used to keep
              reading "Check for updates" with only a spinner to say otherwise. */}
          <span className={busy ? 'nyra-shimmer' : undefined}>
            {installing ? 'Installing…' : check.kind === 'checking' ? 'Checking…' : 'Check for updates'}
          </span>
        </button>
      )}
    </div>
  )
}
