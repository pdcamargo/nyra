import React, { useEffect, useState } from 'react'
import { PenTool, X } from 'lucide-react'
import { cn } from 'cn'
import ScaledArtboard from './ScaledArtboard'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { designsFor, isLive, useDesignActivityStore } from '../../store/designActivity'
import { sameDesign } from '../../lib/designPaths'
import { useBrowserStore } from '../../store/browser'
import { useRunningStore } from '../../store/running'
import { useSessionsStore } from '../../store/sessions'
import { useDesignEntries } from '../../hooks/useDesignWatch'
import { openDesignInPanel } from '../../lib/openFile'

/** Inside the 308px column, less the stage's padding. */
const STAGE_WIDTH = 284
const STAGE_HEIGHT = 170

export function updatedAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) return 'Updated just now'
  if (s < 60) return `Updated ${s}s ago`
  if (s < 3600) return `Updated ${Math.round(s / 60)}m ago`
  return `Updated ${Math.round(s / 3600)}h ago`
}

/**
 * The design this chat is working on, drawn live over the conversation.
 *
 * It shows the artboard that changed last rather than the first one in the
 * file: the question it answers is "what did Claude just do", and the answer
 * is almost never page one. Clicking opens the canvas framed on it, and
 * counts as having looked, so the "changed" marks clear.
 */
export default function DesignPip(): React.JSX.Element | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const latest = useDesignActivityStore((s) => designsFor(s, sessionId)[0] ?? null)
  const watch = useDesignActivityStore((s) => (latest ? s.watches[latest.path] : undefined))
  const running = useRunningStore((s) => Boolean(sessionId && s.running[sessionId]))
  const dismissPip = useBrowserStore((s) => s.dismissPip)
  const entries = useDesignEntries()
  const live = latest ? isLive(latest, running, true) : false

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (live) return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [live])

  if (!sessionId || !latest || !watch?.doc || !watch.theme) return null
  const { doc, theme } = watch

  const changedIds = watch.changed.map((c) => c.id)
  const focusId = changedIds[0] ?? latest.artboard ?? doc.artboards[0]?.id
  const focus = doc.artboards.find((a) => a.id === focusId) ?? doc.artboards[0]
  if (!focus) return null
  const others = watch.changed
    .slice(1)
    .flatMap((c) => doc.artboards.find((a) => a.id === c.id) ?? [])
  const name = entries.find((e) => sameDesign(e.path, latest.path))?.name ?? doc.name
  const isChanged = changedIds.includes(focus.id)

  const open = (artboardId: string): void => {
    void openDesignInPanel(`${latest.path}#${artboardId}`)
    useDesignActivityStore.getState().acknowledge(latest.path)
  }

  return (
    <div className="pointer-events-auto min-h-0 shrink-[4] overflow-hidden rounded-lg border border-border/70 bg-background/85 shadow-panel backdrop-blur-xl backdrop-saturate-150 dark:border-border dark:bg-card/85">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <PenTool className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Design
        </span>
        <span className="flex size-3 items-center justify-center">
          <span className={cn('size-1.5 rounded-full', live ? 'bg-info nyra-breathe' : 'bg-success')} />
        </span>
        <span className={cn('flex-1 truncate text-[10px]', live ? 'text-info' : 'text-muted-foreground')}>
          {live ? 'Claude is editing' : updatedAgo(latest.at, now)}
        </span>
        {changedIds.length > 1 && (
          <span className="rounded-sm bg-accent/60 px-1 py-px text-[9px] font-medium text-muted-foreground">
            {changedIds.length} changed
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="Hide design preview"
              onClick={() => dismissPip(sessionId, true)}
              className="rounded-at-4 p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide — bring it back from the Summary</TooltipContent>
        </Tooltip>
      </div>

      <button
        type="button"
        onClick={() => open(focus.id)}
        title={`${name} · ${focus.name}\nClick to open in the panel`}
        className="block w-full cursor-default text-left transition-opacity hover:opacity-90"
      >
        <span className="flex items-center justify-center bg-muted/50 p-3" style={{ minHeight: 96 }}>
          <ScaledArtboard
            artboard={focus}
            theme={theme}
            maxWidth={STAGE_WIDTH}
            maxHeight={STAGE_HEIGHT}
            className={cn('shadow-sm', isChanged ? 'ring-2 ring-info' : 'ring-1 ring-border')}
          />
        </span>
        <span className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1 last:border-b-0">
          <span className="flex-1 truncate text-[10px] text-muted-foreground">
            {name} · {focus.name}
          </span>
          {isChanged && (
            <span className="rounded-full bg-info/12 px-1.5 py-px text-[9px] font-medium text-info">
              Changed
            </span>
          )}
        </span>
      </button>

      {others.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-2.5 py-1.5">
          {others.map((a) => (
            <button
              key={a.id}
              type="button"
              title={`${a.name}\nClick to open in the panel`}
              onClick={() => open(a.id)}
              className="flex size-10 shrink-0 cursor-default items-center justify-center rounded-sm bg-muted/50 transition-opacity hover:opacity-80"
            >
              <ScaledArtboard artboard={a} theme={theme} maxWidth={36} maxHeight={36} className="ring-1 ring-border" />
            </button>
          ))}
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">Newest first</span>
        </div>
      )}
    </div>
  )
}
