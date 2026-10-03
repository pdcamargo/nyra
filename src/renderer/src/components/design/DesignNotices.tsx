import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleArrowUp, CircleCheck, Circle, FileJson, LoaderCircle, X } from 'lucide-react'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import { formatBytes, type DesignLoadPhase } from '../../lib/designLoad'
import { DESIGN_PRIMARY } from './designAccent'

/** Before this much of a read has been watched, a rate is a guess. */
const ESTIMATE_AFTER_MS = 400

/**
 * Seconds left in a read, from how fast it has gone since `from`; null while
 * there is not enough of it to say.
 */
export function remainingSeconds(
  from: { at: number; loaded: number },
  now: { at: number; loaded: number },
  total: number
): number | null {
  const elapsed = now.at - from.at
  const read = now.loaded - from.loaded
  if (elapsed < ESTIMATE_AFTER_MS || read <= 0 || total <= 0) return null
  return Math.max(0, total - now.loaded) / (read / elapsed) / 1000
}

/** "about 2 s", "about 3 min". Never "about 0 s": a read that is nearly done
 *  still has a second left as far as anyone watching can tell. */
export function formatRemaining(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`
  return `about ${Math.round(seconds / 60)} min`
}

/**
 * Opening a design that takes long enough to notice.
 *
 * There is no size limit, so there has to be a loading state instead: how much
 * has been read, which step it is on, and — once the read has gone on long
 * enough to measure — about how long is left.
 */
export function OpeningCard({
  fileName,
  phase,
  onCancel
}: {
  fileName: string
  phase: DesignLoadPhase
  onCancel: () => void
}): React.ReactElement {
  const total = phase.total
  const loaded = phase.phase === 'reading' ? phase.loaded : total
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0

  // Measured from the first progress this card saw, not from the open: the
  // card only appears once the open is slow, and the rate is what matters.
  const origin = useRef<{ at: number; loaded: number } | null>(null)
  const [eta, setEta] = useState<number | null>(null)
  useEffect(() => {
    if (phase.phase !== 'reading') {
      setEta(null)
      return
    }
    const now = { at: performance.now(), loaded: phase.loaded }
    if (origin.current === null) {
      origin.current = now
      return
    }
    setEta(remainingSeconds(origin.current, now, phase.total))
  }, [phase])

  const step = (name: string, state: 'done' | 'now' | 'next'): React.ReactElement => (
    <span className="flex items-center gap-1">
      {state === 'done' ? (
        <CircleCheck className="size-3 text-success" />
      ) : state === 'now' ? (
        <LoaderCircle className="size-3 animate-spin text-design-accent" />
      ) : (
        <Circle className="size-3 text-muted-foreground" />
      )}
      <span className={state === 'now' ? 'text-foreground' : 'text-muted-foreground'}>{name}</span>
    </span>
  )
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
      <div
        role="status"
        className="pointer-events-auto flex w-[360px] max-w-full flex-col gap-3 rounded-[12px] border bg-popover p-4 text-[12.5px] leading-[1.5] shadow-panel"
      >
        <div className="flex items-center gap-2">
          <FileJson className="size-[15px] shrink-0 text-muted-foreground" />
          {/* A long file name is cut: `title` discloses the rest. */}
          <span className="min-w-0 flex-1 truncate font-[550]" title={fileName}>
            Opening {fileName}
          </span>
          <IconButton label="Stop opening" onClick={onCancel}>
            <X className="size-[13px]" />
          </IconButton>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-design-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between gap-3 tabular-nums">
          <span>
            {phase.phase === 'reading'
              ? `Reading ${formatBytes(loaded)} of ${formatBytes(total)}`
              : `Checking ${formatBytes(total)}`}
          </span>
          {eta !== null && <span className="text-muted-foreground">{formatRemaining(eta)}</span>}
        </div>
        <div className="flex gap-4">
          {step('Reading', phase.phase === 'reading' ? 'now' : 'done')}
          {step('Checking', phase.phase === 'checking' ? 'now' : 'next')}
          {step('Drawing', 'next')}
        </div>
      </div>
    </div>
  )
}

/** The banner's two buttons: the mockup's small button, 12px a side. */
const BANNER_BUTTON = 'h-auto rounded-[8px] px-3 py-1 text-[12.5px] leading-[1.5] font-[550]'

/**
 * The file is an older format: drawn from its upgraded copy, untouched on disk
 * until someone says to write it.
 */
export function UpgradeBanner({
  busy,
  error,
  label = 'Upgrade file',
  onUpgrade,
  onDismiss
}: {
  busy: boolean
  error: string | null
  /** "Upgrade system" inside a design system, which upgrades every file. */
  label?: string
  onUpgrade: () => void
  onDismiss: () => void
}): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-3 bg-info/10 px-3 py-2 text-[12.5px] leading-[1.5]">
      <CircleArrowUp className="size-[15px] shrink-0 text-info" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">Older format.</span> This file was made with an earlier version
        of Nyra Design. Upgrade it to remove this warning.
        {error && <span className="ml-1 text-danger">{error}</span>}
      </p>
      <Button variant="ghost" size="sm" className={`${BANNER_BUTTON} text-muted-foreground`} onClick={onDismiss}>
        Not now
      </Button>
      <Button size="sm" className={`${BANNER_BUTTON} ${DESIGN_PRIMARY}`} onClick={onUpgrade} disabled={busy}>
        {busy ? 'Upgrading…' : label}
      </Button>
    </div>
  )
}

/** A file from a later Nyra. Refused whole: never drawn half right. */
export function NewerFormatNotice({ message }: { message: string }): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <CircleAlert className="size-5 text-warning" />
      <p className="text-sm font-medium">Made with a newer Nyra</p>
      <p className="max-w-sm text-xs text-muted-foreground">{message}</p>
    </div>
  )
}
