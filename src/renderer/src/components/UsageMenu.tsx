import React, { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { dropExpired, useRateLimitStore } from '../store/rateLimit'
import { useSessionsStore, activeSession as activeSessionSelector } from '../store/sessions'

/** The context window the app bills a conversation against. */
const CONTEXT_LIMIT = 1_000_000

const WINDOWS: { type: string; label: string }[] = [
  { type: 'five_hour', label: 'Session · 5 hours' },
  { type: 'seven_day', label: 'Weekly' }
]

/** "3h 19m", "5m 22s", "2d 4h" — the largest two units that still say something. */
function until(resetsAtSec: number, now: number): string | null {
  const ms = resetsAtSec * 1000 - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

const pct = (n: number): number => Math.min(100, Math.max(0, Math.round(n * 100)))

/** How long ago a reading was taken, said the way a person would. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** A window's share spent, as a bar and a number. */
function Meter({
  label,
  used,
  detail,
  tone
}: {
  label: string
  used: number | null
  detail: string
  tone: 'normal' | 'warning' | 'danger'
}): React.JSX.Element {
  const fill =
    tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-foreground/45'
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.85em] text-foreground/80">{label}</span>
        <span className="font-mono text-[0.8em] text-muted-foreground">
          {used === null ? '—' : `${used}%`}
        </span>
      </div>
      {/* The track is always drawn. A window with nothing reported yet shows an
          empty track and an em dash rather than a confident 0%. */}
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-accent">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
          style={{ width: `${used ?? 0}%` }}
        />
      </div>
      <p className="mt-1 text-[0.78em] text-muted-foreground">{detail}</p>
    </div>
  )
}

/**
 * What is left of the account's limits, and of this chat's context.
 *
 * Lives in the rail's footer rather than under the composer. The line it
 * replaces sat below the conversation reading `opus 108 tokens · 0% 5h: resets
 * 3h 19m`, which put two unrelated numbers side by side: the tokens and the
 * percentage were *this chat's* context, the reset was the *account's* five
 * hour window, and nothing said so. The window's own utilisation — the number
 * anyone actually wants — was in the CLI's payload the whole time and never
 * reached the screen.
 *
 * Collapsed to a word, because none of it is worth a permanent line of chrome;
 * it is worth knowing where to look.
 *
 * There is no fetch behind it, and not for want of looking: the CLI has no
 * usage subcommand, keeps nothing on disk to read, and reports the windows only
 * on the event stream while a turn is running. Asking for a number costs a
 * turn, which is the one thing a usage meter must not do. So the last reading
 * is persisted and stamped instead, and any window past its own reset is
 * dropped rather than shown — a stale figure with a time on it is useful, a
 * stale figure presented as now is not.
 */
export default function UsageMenu(): React.JSX.Element {
  const stored = useRateLimitStore((s) => s.windows)
  const updatedAt = useRateLimitStore((s) => s.updatedAt)
  const session = useSessionsStore(activeSessionSelector)
  const [now, setNow] = useState(() => Date.now())

  // Only while the menu can be read. A countdown nobody is looking at is a
  // render a second for the life of the app.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])

  // Again at render, not only on load: a window can roll over while the app
  // sits open, and the moment it does the number it carried stops being true.
  const windows = dropExpired(stored, now)
  const five = windows['five_hour']
  const headline = five?.utilization !== undefined ? `${pct(five.utilization)}%` : null
  const throttled = Object.values(windows).some((w) => w.status === 'throttled')

  const usage = session?.usage ?? null
  const contextTokens = usage ? usage.inputTokens + usage.outputTokens : null
  const contextPct = contextTokens === null ? null : pct(contextTokens / CONTEXT_LIMIT)

  // Only when there is a reading to stamp. With nothing to say, each window
  // already says "Nothing reported yet" — a second line explaining the same
  // silence is the panel apologising for itself.
  const reported =
    updatedAt !== null && Object.keys(windows).length > 0
      ? `Last reported ${ago(updatedAt, now)}`
      : null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[0.85em] transition-colors hover:bg-accent/50 aria-expanded:bg-accent ${
          throttled ? 'text-danger' : 'text-muted-foreground hover:text-foreground/80'
        }`}
      >
        <Gauge className="size-3.5 shrink-0" />
        <span>Usage</span>
        {headline && (
          <span className="ml-auto flex items-baseline gap-1">
            {/* Which window the number is. It is the five-hour one — the limit
                that bites mid-session — and unlabelled it could as easily have
                been the weekly, which is a different number entirely. */}
            <span className="text-[0.8em] uppercase tracking-wide">5h</span>
            <span className="font-mono text-[0.92em] tabular-nums">{headline}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      {/* As wide as the button that opened it. A panel narrower than its own
          trigger reads as a misalignment, and the rail's width is the one
          measure both of them already share. */}
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        <DropdownMenuLabel>Limits</DropdownMenuLabel>
        {WINDOWS.map(({ type, label }) => {
          const w = windows[type]
          const used = w?.utilization === undefined ? null : pct(w.utilization)
          const left = w ? until(w.resetsAt, now) : null
          return (
            <Meter
              key={type}
              label={label}
              used={used}
              tone={
                w?.status === 'throttled' || (used !== null && used >= 90)
                  ? 'danger'
                  : used !== null && used >= 70
                    ? 'warning'
                    : 'normal'
              }
              detail={
                w?.status === 'throttled'
                  ? left
                    ? `Limit reached — resets in ${left}`
                    : 'Limit reached'
                  : left
                    ? `Resets in ${left}`
                    : 'Nothing reported yet'
              }
            />
          )
        })}
        {reported && (
          <p className="px-2 pb-1 text-[0.78em] text-muted-foreground">{reported}</p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>This chat</DropdownMenuLabel>
        <Meter
          label="Context"
          used={contextPct}
          tone={contextPct !== null && contextPct >= 90 ? 'danger' : contextPct !== null && contextPct >= 70 ? 'warning' : 'normal'}
          detail={
            contextTokens === null
              ? 'Nothing sent yet'
              : `${contextTokens.toLocaleString()} of ${CONTEXT_LIMIT.toLocaleString()} tokens`
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
