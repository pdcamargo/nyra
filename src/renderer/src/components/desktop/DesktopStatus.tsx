import React, { useEffect } from 'react'
import { MousePointerClick, Square, X } from 'lucide-react'
import { EMPTY_DESKTOP, useDesktopStore } from '../../store/desktop'
import { IconButton } from '../ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/** How often to check whether a missing permission has been granted. */
const RECHECK_MS = 2000

/**
 * Over the composer: what Claude is controlling right now, or the permission
 * it found missing. One line each — a chip, not a card.
 *
 * The permission button reads its label and what it opens from Rust's neutral
 * entry, so this never learns what a settings pane is.
 */
export default function DesktopStatus({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const chat = useDesktopStore((s) => s.bySession[sessionId] ?? EMPTY_DESKTOP)
  const setBlocked = useDesktopStore((s) => s.setBlocked)
  const blocked = chat.blocked

  // Granted in System Settings while this was showing: take it down on its own
  // rather than leaving a button that no longer does anything.
  useEffect(() => {
    if (!blocked) return
    const kind = blocked.kind
    const timer = window.setInterval(() => {
      void window.api.desktop.permissions().then((entries) => {
        if (entries.find((e) => e.kind === kind)?.granted) setBlocked(sessionId, null)
      })
    }, RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [blocked, sessionId, setBlocked])

  if (!chat.controlling && !blocked) return null

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {blocked && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/6 px-3 py-1.5">
          <p className="min-w-0 flex-1 text-c-xs text-warning">{blocked.reason}.</p>
          {blocked.fix && (
            <button
              type="button"
              onClick={() => void window.api.desktop.fixPermission(blocked.kind)}
              className="shrink-0 rounded-md border border-warning/30 px-2 py-0.5 text-c-xs text-warning transition-colors hover:bg-warning/10"
            >
              {blocked.fix.label}
            </button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setBlocked(sessionId, null)}
                className="shrink-0 rounded-at-4 p-0.5 text-warning transition-colors hover:bg-warning/10"
              >
                <X className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Dismiss</TooltipContent>
          </Tooltip>
        </div>
      )}
      {chat.controlling && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 dark:border-muted dark:bg-muted">
          <MousePointerClick className="size-3.5 shrink-0 text-info" />
          <span className="min-w-0 flex-1 truncate text-c-xs text-foreground">
            Claude is using {chat.controlling}
            <span className="text-muted-foreground"> · press Esc anywhere to stop</span>
          </span>
          <IconButton
            label="Stop desktop control"
            command="desktop.stop"
            onClick={() => void window.api.desktop.stop()}
            className="shrink-0 text-muted-foreground"
          >
            <Square className="size-3" />
          </IconButton>
        </div>
      )}
    </div>
  )
}
