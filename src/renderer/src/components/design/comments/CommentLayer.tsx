import { useEffect, useRef, useState } from 'react'
import type { ResolvedArtboard } from '@nyra/design'
import { Check, Crosshair, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { cn } from 'cn'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { relocate, since, threadOf, type Box, type DesignComment } from '../../../lib/designComments'
import { formatChord } from '../../../lib/keys'
import { accountLabel, useAccountsStore } from '../../../store/accounts'

/** What is outlined while the menu or the composer is open. A null box is
 *  the whole artboard. */
export type Highlight = {
  bounds: Box | null
  tag: string | null
  pin: { x: number; y: number } | null
  /** The number the pin being written will get. */
  n?: number
}

/** Pin size on screen, whatever the zoom. */
const PIN = 24

/**
 * The comments on one artboard, and the outline of what a right-click landed on.
 *
 * Laid over the artboard in its own pixels, inside the canvas transform, so
 * pins pan with it; sizes are divided by the zoom so a pin is the same size on
 * screen at 10% as at 200%.
 *
 * Each pin is placed from its element's live box, read out of the shadow root
 * after the artboard draws — so when Claude moves the button, the pin moves
 * with it. An element that is gone falls back to the point it was pinned at.
 */
export default function CommentLayer({
  artboard,
  zoom,
  comments,
  activeId,
  onActive,
  highlight,
  onResolve,
  onReopen,
  onReply,
  onDelete
}: {
  artboard: ResolvedArtboard
  zoom: number
  comments: DesignComment[]
  activeId: string | null
  onActive: (id: string | null) => void
  highlight: Highlight | null
  onResolve: (c: DesignComment) => void
  onReopen: (c: DesignComment) => void
  /** Write back on a comment: saved to its thread, then sent to Claude. */
  onReply: (c: DesignComment, text: string) => Promise<void>
  onDelete: (c: DesignComment) => void
}): React.ReactElement {
  const layer = useRef<HTMLDivElement | null>(null)
  const [places, setPlaces] = useState<Record<string, { x: number; y: number; gone: boolean }>>({})

  useEffect(() => {
    const host = layer.current?.parentElement?.querySelector<HTMLElement>(
      `[data-artboard-host="${artboard.id.replace(/["\\]/g, '\\$&')}"]`
    )
    if (!host) return
    const measure = (): void => {
      const root = host.shadowRoot
      const hostBox = host.getBoundingClientRect()
      const scale = host.offsetWidth > 0 ? hostBox.width / host.offsetWidth : 1
      const byId = new Map<string, Element>()
      root?.querySelectorAll('[data-node]').forEach((el) => byId.set(el.getAttribute('data-node') ?? '', el))
      const next: Record<string, { x: number; y: number; gone: boolean }> = {}
      for (const c of comments) {
        const id = relocate(artboard, c.anchor)
        const el = id ? byId.get(id) : undefined
        if (!el) {
          next[c.id] = { ...c.anchor.point, gone: true }
          continue
        }
        const box = el.getBoundingClientRect()
        next[c.id] = {
          x: (box.left - hostBox.left + c.anchor.offset.x * box.width) / scale,
          y: (box.top - hostBox.top + c.anchor.offset.y * box.height) / scale,
          gone: false
        }
      }
      setPlaces(next)
    }
    measure()
    // Fonts and images settle after the first draw, and an `auto` artboard
    // grows with them; either moves what a pin points at.
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [artboard, comments])

  const pin = PIN / zoom
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-10">
      {highlight && (
        <>
          <div
            className="absolute"
            style={{
              ...(highlight.bounds
                ? {
                    left: highlight.bounds.x,
                    top: highlight.bounds.y,
                    width: highlight.bounds.width,
                    height: highlight.bounds.height
                  }
                : { inset: 0 }),
              outline: `${2 / zoom}px solid var(--design-accent)`,
              outlineOffset: 1 / zoom,
              borderRadius: 4 / zoom
            }}
          />
          {highlight.tag && highlight.bounds && (
            <span
              className="absolute bg-design-accent px-1 font-mono whitespace-nowrap text-design-accent-foreground"
              style={{
                left: highlight.bounds.x,
                top: highlight.bounds.y - 20 / zoom,
                fontSize: `${11.5 / zoom}px`,
                lineHeight: `${16 / zoom}px`,
                borderRadius: 4 / zoom
              }}
            >
              {highlight.tag}
            </span>
          )}
          {highlight.pin && (
            <span
              className="absolute flex items-center justify-center rounded-full border-background bg-design-accent font-medium text-design-accent-foreground tabular-nums shadow-panel"
              style={{
                left: highlight.pin.x - pin / 2,
                top: highlight.pin.y - pin / 2,
                width: pin,
                height: pin,
                borderWidth: 2 / zoom,
                fontSize: `${11.5 / zoom}px`
              }}
            >
              {highlight.n}
            </span>
          )}
        </>
      )}
      {comments.map((c) => {
        const at = places[c.id]
        if (!at) return null
        const resolved = c.status === 'resolved'
        const active = activeId === c.id
        return (
          <Popover key={c.id} open={active} onOpenChange={(open) => onActive(open ? c.id : null)}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Comment ${c.n}${resolved ? ', resolved' : ''}`}
                // A press on a pin is not the start of a pan.
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  'pointer-events-auto absolute flex items-center justify-center rounded-full font-medium tabular-nums transition-shadow',
                  resolved ? 'border-input bg-background text-success opacity-85' : 'border-transparent bg-design-accent text-design-accent-foreground shadow-panel',
                  active && 'border-background! shadow-panel'
                )}
                style={{
                  left: at.x - pin / 2,
                  top: at.y - pin / 2,
                  width: pin,
                  height: pin,
                  borderWidth: (active ? 2 : 1) / zoom,
                  fontSize: `${11.5 / zoom}px`
                }}
              >
                {resolved ? <Check style={{ width: 12 / zoom, height: 12 / zoom }} /> : c.n}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="start"
              sideOffset={12}
              // Re-placed every frame: the pin lives under the canvas
              // transform, and a pan moves it without anything resizing.
              updatePositionStrategy="always"
              className="w-[280px] gap-2 rounded-[12px] p-3 shadow-panel"
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <CommentCard
                comment={c}
                gone={at.gone}
                onResolve={() => onResolve(c)}
                onReopen={() => onReopen(c)}
                onReply={(text) => onReply(c, text)}
                onDelete={() => onDelete(c)}
              />
            </PopoverContent>
          </Popover>
        )
      })}
    </div>
  )
}

/** The first letter of the signed-in account's name, for "You". */
function useYourInitial(): string {
  const name = useAccountsStore((s) => Object.values(s.byWorkspace).map(accountLabel).find(Boolean) ?? null)
  return name?.trim().charAt(0).toUpperCase() || 'Y'
}

function Avatar({ by }: { by: 'you' | 'claude' }): React.ReactElement {
  const initial = useYourInitial()
  return by === 'claude' ? (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-design-accent/10" aria-hidden="true">
      <Sparkles className="size-[11px] text-design-accent" />
    </span>
  ) : (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[11.5px] font-medium text-background"
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

/**
 * One comment, as its pin's popover shows it: a thread.
 *
 * Your comment first, then every round after it — Claude's note when it acted,
 * and what you said back. The box at the bottom writes the next round: it is
 * saved to the thread and sent to Claude together, so Reopen on its own never
 * sends anything; it only says the last round did not settle it.
 */
export function CommentCard({
  comment: c,
  gone,
  onResolve,
  onReopen,
  onReply,
  onDelete
}: {
  comment: DesignComment
  gone: boolean
  onResolve: () => void
  onReopen: () => void
  onReply: (text: string) => Promise<void>
  onDelete: () => void
}): React.ReactElement {
  const resolved = c.status === 'resolved'
  const thread = threadOf(c)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement | null>(null)

  const send = async (): Promise<void> => {
    const words = reply.trim()
    if (!words || busy) return
    setBusy(true)
    setError(null)
    try {
      await onReply(words)
      setReply('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <div className="flex items-center gap-2">
        <Avatar by="you" />
        <span className="font-[550]">You</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-muted-foreground">{since(c.createdAt)}</span>
        <button
          type="button"
          onClick={() => {
            if (resolved) {
              onReopen()
              box.current?.focus()
            } else onResolve()
          }}
          className="flex items-center gap-1 rounded-[4px] border px-2 py-px text-[11.5px] font-medium hover:bg-muted/60"
        >
          {resolved ? <RotateCcw className="size-3 text-muted-foreground" /> : <Check className="size-3 text-muted-foreground" />}
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete comment"
              className="rounded-[4px] p-0.5 text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="size-[13px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete comment</TooltipContent>
        </Tooltip>
      </div>
      <p className="leading-[1.5] whitespace-pre-wrap">{c.text}</p>
      <div className="flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground">
        <Crosshair className="size-[11px] shrink-0" />
        <span className="min-w-0 truncate">
          {gone && c.anchor.resolvedId ? `${c.anchor.label} — no longer on the artboard` : `${c.anchor.label} · ${c.artboardName}`}
        </span>
      </div>

      {thread.map((r) => (
        <div key={r.id} className="flex flex-col gap-1 border-t pt-2">
          <div className="flex items-center gap-2">
            <Avatar by={r.by} />
            <span className="font-[550]">{r.by === 'claude' ? 'Claude' : 'You'}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-muted-foreground">{since(r.at)}</span>
          </div>
          <p className="leading-[1.5] whitespace-pre-wrap">{r.text}</p>
        </div>
      ))}
      {resolved && thread.at(-1)?.by !== 'claude' && (
        <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
          <Check className="size-3 text-success" />
          {c.resolution?.by === 'claude' ? 'Claude' : 'You'} resolved it {c.resolution ? since(c.resolution.at) : ''}
        </p>
      )}

      <textarea
        ref={box}
        value={reply}
        rows={1}
        disabled={busy}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder={resolved ? 'Not quite? Say what to change…' : 'Reply…'}
        aria-label="Reply"
        className="field-sizing-content max-h-32 min-h-8 resize-none rounded-[8px] border bg-background p-2 leading-[1.5] outline-none focus-visible:border-design-accent focus-visible:ring-1 focus-visible:ring-design-accent"
      />
      {reply.trim() && (
        <span className="text-[11.5px] font-medium text-muted-foreground">
          {formatChord('enter')} sends it to Claude{resolved ? ' and reopens the comment' : ''}
        </span>
      )}
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
    </div>
  )
}
