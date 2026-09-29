import React, { useEffect, useState } from 'react'
import { AppWindow, X } from 'lucide-react'
import { EMPTY_DESKTOP, useDesktopStore } from '../../store/desktop'
import { useBrowserStore } from '../../store/browser'
import { useSessionsStore } from '../../store/sessions'
import { useLightboxStore } from '../../store/lightbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/** "seen 12s ago": coarse on purpose, and it only has to be right to the tick. */
export function seenAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) return 'seen just now'
  if (s < 60) return `seen ${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `seen ${m}m ago`
  return `seen ${Math.round(m / 60)}h ago`
}

/** A capture on disk, as something an `img` may load (the CSP allows `data:`). */
function useCapture(path: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!path) {
      setSrc(null)
      return
    }
    let cancelled = false
    void window.api.fs.readImage(path).then((r) => {
      if (!cancelled) setSrc(r.base64 ? `data:${r.mediaType ?? 'image/png'};base64,${r.base64}` : null)
    })
    return () => {
      cancelled = true
    }
  }, [path])
  return src
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
  return now
}

/**
 * The miniature, when the last thing this chat looked at was another app's
 * window: a still of it, never a stream. The latest screenshot, or the capture
 * taken beside a snapshot when Screen Recording was already allowed — nothing
 * here ever asks for it. With no picture it is the app's icon and the window's
 * title, rather than a grey box that says nothing.
 */
export default function DesktopPip(): React.JSX.Element | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const seen = useDesktopStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_DESKTOP).seen
  const dismissPip = useBrowserStore((s) => s.dismissPip)
  const openLightbox = useLightboxStore((s) => s.openLightbox)
  const src = useCapture(seen?.png ?? null)
  const now = useNow(5000)

  if (!sessionId || !seen) return null
  const title = seen.title || 'Untitled window'
  const icon = seen.icon ? (
    <img src={seen.icon} alt="" className="size-3 shrink-0 rounded-[3px]" />
  ) : (
    <AppWindow className="size-3 shrink-0 text-muted-foreground" />
  )

  return (
    <div className="pointer-events-auto min-h-0 shrink-[4] overflow-hidden rounded-lg border border-border/70 bg-background/85 shadow-panel backdrop-blur-xl backdrop-saturate-150 dark:border-border dark:bg-card/85">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        {icon}
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          {seen.app}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{seenAgo(seen.at, now)}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Hide preview"
              onClick={() => dismissPip(sessionId, true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide — bring it back from the Summary</TooltipContent>
        </Tooltip>
      </div>

      {src ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${seen.app}: ${title}. Open larger`}
              onClick={() => openLightbox({ src, name: `${seen.app} — ${title}` })}
              className="block w-full cursor-default text-left transition-opacity hover:opacity-90"
            >
              <img src={src} alt="" className="block h-auto w-full" />
              <span className="block truncate border-b border-border/40 px-2.5 py-1 text-[10px] text-muted-foreground">
                {title}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Open larger</TooltipContent>
        </Tooltip>
      ) : (
        <div className="flex items-center gap-2 px-2.5 pb-2 pt-0.5">
          {seen.icon ? (
            <img src={seen.icon} alt="" className="size-8 shrink-0 rounded-md" />
          ) : (
            <AppWindow className="size-8 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={title}>
            {title}
          </span>
        </div>
      )}
    </div>
  )
}
