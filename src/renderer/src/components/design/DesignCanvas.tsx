import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { ResolvedArtboard, Theme } from '@nyra/design'
import { cn } from 'cn'
import Artboard from './Artboard'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { hitTest, type Hit } from '../../lib/designComments'
import {
  centre,
  clampZoom,
  extent,
  fitZoom,
  frame,
  layout,
  screenPx,
  TITLE_SPACE,
  visibleArtboards,
  zoomAbout
} from './layout'

/**
 * How a click changes the selection: a plain click replaces it, shift adds to
 * it, and cmd/ctrl toggles one artboard in or out — the file-manager rules,
 * because those are the ones people already have in their hands.
 */
export type SelectMode = 'replace' | 'add' | 'toggle'

export function nextSelection(current: string[], id: string | null, mode: SelectMode): string[] {
  if (id === null) return []
  if (mode === 'replace') return current.length === 1 && current[0] === id ? current : [id]
  if (current.includes(id)) return mode === 'toggle' ? current.filter((x) => x !== id) : current
  // Appended, never sorted: the order you clicked in is the page order an
  // export starts from, so it is kept exactly as it happened.
  return [...current, id]
}

/** How far a press may travel and still count as a click rather than a pan. */
const CLICK_SLOP = 4

/**
 * The selection colour: the design accent, rather than `--primary`, which in
 * the dark theme is a near-white that disappears against a light artboard.
 */
const SELECTED = 'var(--design-accent)'

/**
 * How many artboards stay live once they have scrolled away.
 *
 * Each one is a shadow root holding the whole artboard's DOM, and a screen of
 * two dozen near-identical boards panned across once used to leave all of them
 * in the page. Past this many, the one seen longest ago goes back to an
 * outline; drawing it again is an `innerHTML` of markup the worker already
 * built, not a render.
 */
const MAX_LIVE = 12

/**
 * How often a gesture tells React where the view is. The transform itself is
 * written straight to the layer on every event; React only needs the view to
 * decide what is near enough to draw and to update the zoom readout, and
 * neither needs it sixty times a second.
 */
const COMMIT_EVERY = 100
/** And once more when the gesture stops, so what is drawn matches where it ended. */
const SETTLE = 120

type View = { pan: { x: number; y: number }; zoom: number }

/** The artboards to keep live: everything near, then the most recently near,
 *  up to `MAX_LIVE`. Oldest first, so the front is what goes. */
export function keepDrawn(prev: string[], near: Set<string>, max = MAX_LIVE): string[] {
  const kept = prev.filter((id) => !near.has(id))
  const next = [...kept, ...near]
  const over = next.length - Math.max(max, near.size)
  const trimmed = over > 0 ? next.slice(over) : next
  return trimmed.length === prev.length && trimmed.every((id, i) => id === prev[i]) ? prev : trimmed
}

/**
 * How many artboards may start drawing in one frame.
 *
 * Drawing a board is WebKit parsing and laying out its whole shadow tree, and
 * zooming out on a screen of two dozen used to do all of them in one frame —
 * a 400 ms stall. Queued, they fill in a few at a time from the middle of the
 * view outwards. Fewer when the last frame ran long, so a heavy design paces
 * itself rather than stalling in smaller pieces.
 */
const DRAW_PER_FRAME = 3
const SLOW_FRAME = 32

/** The ids in `ids` nearest to `at` first. */
export function nearestFirst(ids: string[], placed: Map<string, { x: number; y: number; width: number; height: number }>, at: { x: number; y: number }): string[] {
  const distance = (id: string): number => {
    const p = placed.get(id)
    if (!p) return Infinity
    return Math.hypot(p.x + p.width / 2 - at.x, p.y + p.height / 2 - at.y)
  }
  return [...ids].sort((a, b) => distance(a) - distance(b))
}

const modeOf = (e: React.MouseEvent): SelectMode =>
  e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'add' : 'replace'

/**
 * The surface the artboards sit on.
 *
 * Pan with a drag or a wheel, zoom with cmd/ctrl-wheel or the buttons. One
 * transform on one container, rather than a node-graph library: `@xyflow/react`
 * is already in the app for Flows and is the wrong shape here — it models
 * edges and ports, and this has neither.
 *
 * Artboards are positioned in world space and the container is transformed, so
 * zooming costs nothing per artboard and the shadow roots are never re-created.
 */
export default function DesignCanvas({
  artboards,
  theme,
  selected,
  onSelect,
  focus,
  onContextMenu,
  overlay
}: {
  artboards: ResolvedArtboard[]
  theme: Theme
  /** In the order they were picked. */
  selected: string[]
  onSelect: (id: string | null, mode?: SelectMode) => void
  /** Frame this artboard instead of fitting everything. Set when a chip
   *  pointed at one, so "see the Protocol panel" lands on the Protocol panel. */
  focus?: string | null
  /** A right-click on an artboard: what it landed on, and where on screen.
   *  The event is left alone, so a context menu around the canvas opens. */
  onContextMenu?: (hit: Hit, at: { x: number; y: number }) => void
  /** Drawn over each artboard, in its pixels: comment pins, a highlight.
   *  Sizes that should not scale divide by `--z`; see `screenPx`. */
  overlay?: (artboard: ResolvedArtboard) => React.ReactNode
}): React.ReactElement {
  const viewport = useRef<HTMLDivElement | null>(null)
  const layer = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  /**
   * Where the view is, twice over.
   *
   * `live` is what is on screen, written straight to the layer on every wheel
   * and pointer event. `view` is what React last heard, throttled: it drives
   * culling and the zoom readout, and re-rendering the canvas for each event of
   * a gesture is what made panning a big design stutter.
   */
  const live = useRef<View>({ pan: { x: 0, y: 0 }, zoom: 1 })
  const [view, setView] = useState<View>(live.current)
  const lastCommit = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((next: View, commit: 'now' | 'throttled' = 'now') => {
    live.current = next
    const node = layer.current
    if (node) {
      node.style.transform = `translate(${next.pan.x}px, ${next.pan.y}px) scale(${next.zoom})`
      node.style.setProperty('--z', String(next.zoom))
    }
    if (settle.current) clearTimeout(settle.current)
    const now = performance.now()
    if (commit === 'now' || now - lastCommit.current >= COMMIT_EVERY) {
      lastCommit.current = now
      setView(next)
      return
    }
    settle.current = setTimeout(() => {
      settle.current = null
      lastCommit.current = performance.now()
      setView(live.current)
    }, SETTLE)
  }, [])
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current)
  }, [])

  const dragging = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null)
  /** Refit when the design changes, but never again — refitting on every
   *  resize would yank the view out from under someone mid-inspection. */
  const fitted = useRef<{ focus: string; signature: string } | null>(null)
  /** Set by a pan or zoom, cleared by a new focus. Once someone has moved the
   *  view it is theirs: an artboard measured on its first draw — which panning
   *  is what causes — must not frame the focused one again. */
  const moved = useRef(false)

  /**
   * Heights of the `auto` artboards, once rendered.
   *
   * The layout runs twice on purpose: an assumed height first so there is
   * something to draw, then the measured one. Without the second pass a tall
   * auto artboard overlaps whatever the flow put under it.
   */
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const measure = useCallback((id: string, height: number) => {
    setMeasured((m) => (m[id] === height ? m : { ...m, [id]: height }))
  }, [])

  const placed = useMemo(() => layout(artboards, 2400, measured), [artboards, measured])
  const content = useMemo(() => extent(placed), [placed])
  const signature = useMemo(
    () =>
      artboards
        .map((a) => `${a.id}:${a.size.height === 'auto' ? (measured[a.id] ?? '?') : a.size.height}`)
        .join('|'),
    [artboards, measured]
  )

  /**
   * Drawn near the view, kept a while after.
   *
   * Only what is near the viewport is drawn at all, so a design with hundreds
   * of artboards opens as outlines and fills in where you look. What scrolls
   * away stays drawn until `MAX_LIVE` newer ones push it out, so panning back
   * and forth over a few boards does not redraw them. Keyed by id, so a reload
   * keeps it.
   */
  const near = useMemo(() => visibleArtboards(placed, size, view.pan, view.zoom), [placed, size, view])
  const [drawn, setDrawn] = useState<string[]>([])
  useEffect(() => {
    setDrawn((prev) => keepDrawn(prev, near))
  }, [near])

  /**
   * What is actually drawn: `drawn`, reached a few boards per frame.
   *
   * Removals are immediate — an evicted board costs nothing to drop. Additions
   * queue, nearest the middle of the view first, so a zoom-out fills in over a
   * few frames instead of stopping the window for all of them at once.
   */
  const shownRef = useRef<Set<string>>(new Set())
  const [shown, setShown] = useState<Set<string>>(shownRef.current)
  useEffect(() => {
    const want = new Set(drawn)
    const kept = new Set([...shownRef.current].filter((id) => want.has(id)))
    const { pan, zoom } = live.current
    const middle = { x: (size.width / 2 - pan.x) / zoom, y: (size.height / 2 - pan.y) / zoom }
    const byId = new Map(placed.map((p) => [p.artboard.id, { x: p.x, y: p.y, width: p.width, height: p.height }]))
    const queue = nearestFirst(drawn.filter((id) => !kept.has(id)), byId, middle)
    let raf = 0
    let last = performance.now()
    const step = (): void => {
      const now = performance.now()
      const take = now - last > SLOW_FRAME ? 1 : DRAW_PER_FRAME
      last = now
      for (const id of queue.splice(0, take)) kept.add(id)
      shownRef.current = new Set(kept)
      setShown(shownRef.current)
      if (queue.length > 0) raf = requestAnimationFrame(step)
    }
    step()
    return () => cancelAnimationFrame(raf)
  }, [drawn, placed, size])

  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (size.width === 0 || content.width === 0) return
    const zoom = fitZoom(content, size)
    show({ zoom, pan: centre(content, size, zoom) })
  }, [content, size, show])

  useEffect(() => {
    if (size.width === 0 || content.width === 0) return
    const want = { focus: focus ?? '', signature }
    const last = fitted.current
    if (last && last.focus === want.focus && last.signature === want.signature) return
    fitted.current = want
    // A new focus is a request to look somewhere, and wins over any pan. A
    // changed signature alone only refines the framing nobody has touched yet.
    if (last && last.focus === want.focus && moved.current) return
    moved.current = false

    const target = focus === null || focus === undefined
      ? undefined
      : placed.find((p) => p.artboard.id === focus)
    if (target) {
      show(frame(target, size))
      onSelect(target.artboard.id)
      return
    }
    fit()
  }, [fit, signature, size, content.width, focus, placed, onSelect, show])

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      moved.current = true
      const { pan, zoom } = live.current
      const box = viewport.current?.getBoundingClientRect()
      const point = { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) }

      // The platform convention: a pinch arrives as ctrl-wheel, and cmd-wheel
      // is what people reach for deliberately.
      if (e.ctrlKey || e.metaKey) {
        const next = clampZoom(zoom * Math.exp(-e.deltaY / 240))
        show({ pan: zoomAbout(pan, zoom, next, point), zoom: next }, 'throttled')
        return
      }
      show({ pan: { x: pan.x - e.deltaX, y: pan.y - e.deltaY }, zoom }, 'throttled')
    },
    [show]
  )

  const zoomBy = (factor: number): void => {
    moved.current = true
    show({ ...live.current, zoom: clampZoom(live.current.zoom * factor) })
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    // Only a drag on the background pans; a drag starting on an artboard is a
    // selection, and will be a move once dragging writes a patch back.
    if ((e.target as HTMLElement).closest('[data-artboard-frame]')) return
    dragging.current = { x: e.clientX, y: e.clientY, pan: live.current.pan }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const from = dragging.current
    if (!from) return
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) >= CLICK_SLOP) moved.current = true
    show(
      { pan: { x: from.pan.x + (e.clientX - from.x), y: from.pan.y + (e.clientY - from.y) }, zoom: live.current.zoom },
      'throttled'
    )
  }

  /**
   * A click on the background clears the selection; a pan does not.
   *
   * Decided on release, because at pointer-down the two look the same — and
   * clearing there meant panning to reach the next artboard threw away the
   * three you had just picked.
   */
  const endDrag = (e: React.PointerEvent): void => {
    const from = dragging.current
    dragging.current = null
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) < CLICK_SLOP) onSelect(null)
  }

  const cancelDrag = (): void => {
    dragging.current = null
  }

  // Rendered from `live`, not `view`: a commit that lands mid-gesture must not
  // put the layer back to where React last heard it was.
  const { pan, zoom } = live.current
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={viewport}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-muted',
          dragging.current ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onContextMenu={(e) => {
          // Only an artboard has a menu. Anywhere else, neither the app's nor
          // the webview's.
          if (!(e.target as Element).closest('div[data-artboard-frame]')) e.preventDefault()
        }}
      >
        <div
          ref={layer}
          className="absolute origin-top-left"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            ['--z' as string]: zoom
          }}
        >
          {placed.map(({ artboard, x, y, height }) => (
            <ArtboardFrame
              key={artboard.id}
              artboard={artboard}
              theme={theme}
              x={x}
              y={y}
              height={height}
              order={selected.indexOf(artboard.id)}
              picked={selected.length}
              isDrawn={shown.has(artboard.id)}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              measure={measure}
              overlay={overlay}
            />
          ))}
        </div>
      </div>

      {/* Floating over the canvas rather than a bar under it: the canvas
          keeps the whole height, and this is all the chrome it needs. */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-at-8 border bg-background px-2 py-0.5 text-[12.5px] leading-[1.5]">
        <ZoomButton label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <Minus className="size-3" />
        </ZoomButton>
        <span className="text-foreground tabular-nums">{Math.round(view.zoom * 100)}%</span>
        <ZoomButton label="Zoom in" onClick={() => zoomBy(1.25)}>
          <Plus className="size-3" />
        </ZoomButton>
        <button type="button" className="pl-2 text-muted-foreground hover:text-foreground" onClick={() => { moved.current = true; fit() }}>
          Fit
        </button>
      </div>
    </div>
  )
}

/**
 * One artboard on the canvas: its title, its pick number, the board itself and
 * whatever the overlay draws on it.
 *
 * Memoised, and nothing in it depends on the zoom — every size that must stay
 * put on screen divides by `--z` instead. So a pan or zoom re-renders none of
 * these, and a selection change re-renders the boards whose state changed.
 */
const ArtboardFrame = memo(function ArtboardFrame({
  artboard,
  theme,
  x,
  y,
  height,
  order,
  picked,
  isDrawn,
  onSelect,
  onContextMenu,
  measure,
  overlay
}: {
  artboard: ResolvedArtboard
  theme: Theme
  x: number
  y: number
  height: number | undefined
  /** Its place in the selection, or -1. */
  order: number
  /** How many are selected: the pick number only shows past one. */
  picked: number
  isDrawn: boolean
  onSelect: (id: string | null, mode?: SelectMode) => void
  onContextMenu?: (hit: Hit, at: { x: number; y: number }) => void
  measure: (id: string, height: number) => void
  overlay?: (artboard: ResolvedArtboard) => React.ReactNode
}): React.ReactElement {
  const isSelected = order >= 0
  return (
    <div className="absolute" style={{ left: x, top: y }}>
      <button
        type="button"
        data-artboard-frame={artboard.id}
        onClick={(e) => onSelect(artboard.id, modeOf(e))}
        className={cn(
          'absolute left-0 truncate text-left leading-[1.4] font-medium',
          isSelected ? 'text-design-accent' : 'text-muted-foreground'
        )}
        style={{
          // Counter-scaled so a label stays readable at any zoom, which
          // is the whole reason it is not part of the artboard.
          bottom: `calc(100% + ${screenPx(4)})`,
          fontSize: screenPx(11.5),
          maxWidth: artboard.size.width
        }}
      >
        {artboard.name}
      </button>
      {/* The pick order, shown once there is an order to show. It is the
          export's default page order, so it is worth seeing before
          the dialog says so. Counter-scaled like the title. */}
      {isSelected && picked > 1 && (
        <span
          className="pointer-events-none absolute z-10 flex items-center justify-center rounded-full bg-design-accent font-medium text-design-accent-foreground tabular-nums ring-2 ring-background"
          style={{
            top: screenPx(-10),
            right: screenPx(-10),
            width: screenPx(20),
            height: screenPx(20),
            fontSize: screenPx(11)
          }}
        >
          {order + 1}
        </span>
      )}
      <div
        data-artboard-frame={artboard.id}
        onClick={(e) => onSelect(artboard.id, modeOf(e))}
        onContextMenu={(e) => {
          if (!onContextMenu) {
            e.preventDefault()
            return
          }
          // Right-clicking inside a selection acts on the selection;
          // outside it, on that one artboard — as in every file manager.
          if (!isSelected) onSelect(artboard.id)
          const host = e.currentTarget.querySelector<HTMLElement>('[data-artboard-host], [data-artboard-outline]')
          if (!host) return
          onContextMenu(hitTest(e.nativeEvent, host, artboard.id), { x: e.clientX, y: e.clientY })
        }}
        // A board not drawn yet is only its dashed outline: no fill,
        // and no second, solid edge around the dashes.
        className={isDrawn ? 'bg-background' : undefined}
        style={{
          // Sized in screen pixels, so a selection reads the same at
          // 10% as at 200%; the offset keeps it off the artboard's own
          // edge, where a light design would swallow it.
          outline: isSelected
            ? `${screenPx(2)} solid ${SELECTED}`
            : isDrawn
              ? `max(0.5px, ${screenPx(1)}) solid var(--border)`
              : 'none',
          outlineOffset: isSelected ? screenPx(2) : 0
        }}
      >
        {isDrawn ? (
          <Artboard artboard={artboard} theme={theme} onMeasure={measure} />
        ) : (
          <ArtboardOutline artboard={artboard} height={height} />
        )}
      </div>
      {overlay && isDrawn && overlay(artboard)}
    </div>
  )
})

/** An icon in the zoom pill. The negative margin keeps the pill's spacing to
 *  the icon itself while the target stays a few pixels larger. */
function ZoomButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="-m-0.5 flex items-center justify-center rounded-at-4 p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Where an artboard will be, before it has been drawn: a dashed edge in the
 * strong border tier, and nothing inside it. The edge is counter-scaled like
 * the label, so it stays one screen pixel at any zoom rather than vanishing
 * when the canvas is zoomed out to see everything.
 */
function ArtboardOutline({
  artboard,
  height
}: {
  artboard: ResolvedArtboard
  height: number | undefined
}): React.ReactElement {
  return (
    <div
      data-artboard-outline={artboard.id}
      className="border-dashed border-border-strong"
      style={{
        borderWidth: screenPx(1),
        width: artboard.size.width,
        height: artboard.size.height === 'auto' ? (height ?? 720) : artboard.size.height
      }}
    />
  )
}

export { TITLE_SPACE }
