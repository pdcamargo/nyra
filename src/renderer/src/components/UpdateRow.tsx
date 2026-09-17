import React, { useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; version: string }
  | { kind: 'installing' }
  | { kind: 'failed'; message: string }

/**
 * The version, and a way to move off it.
 *
 * Deliberately manual rather than a check on every launch: an app that reaches
 * out on its own should say so, and this one is opened dozens of times a day.
 *
 * A failure is shown rather than swallowed. A typo in the endpoint and a
 * genuinely unreachable network look identical from in here, and reporting
 * "you're up to date" for both is how an updater quietly stops updating.
 */
export default function UpdateRow(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    void window.api.updates.version().then(setVersion).catch(() => setVersion(''))
  }, [])

  const check = async (): Promise<void> => {
    setState({ kind: 'checking' })
    try {
      const result = await window.api.updates.check()
      setState(
        result.available ? { kind: 'available', version: result.version } : { kind: 'current' }
      )
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const install = async (): Promise<void> => {
    setState({ kind: 'installing' })
    try {
      // Succeeds by never returning — the app restarts into the new version.
      await window.api.updates.install()
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-foreground/80">
        Nyra <span className="font-mono text-muted-foreground">{version || '…'}</span>
        {state.kind === 'current' && (
          <span className="text-muted-foreground/70"> — up to date</span>
        )}
        {state.kind === 'available' && (
          <span className="text-info"> — {state.version} is available</span>
        )}
        {state.kind === 'failed' && (
          <span className="text-danger/80"> — {state.message}</span>
        )}
      </span>

      {state.kind === 'available' ? (
        <button
          onClick={install}
          className="shrink-0 rounded-lg bg-info px-3 py-1.5 text-xs font-medium text-info-foreground transition-opacity hover:opacity-85"
        >
          Update and restart
        </button>
      ) : (
        <button
          onClick={check}
          disabled={state.kind === 'checking' || state.kind === 'installing'}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-accent disabled:opacity-50"
        >
          {state.kind === 'checking' || state.kind === 'installing' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {state.kind === 'installing' ? 'Installing…' : 'Check for updates'}
        </button>
      )}
    </div>
  )
}
