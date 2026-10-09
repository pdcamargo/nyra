import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  /** Drawn over each artboard, in its pixels: comment pins, a highlight. */
  overlay?: (artboard: ResolvedArtboard, zoom: number) => React.ReactNode
}): React.ReactElement {
  const viewport = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
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
   * Drawn once, kept drawn.
   *
   * Only what is near the viewport is drawn at all, so a design with hundreds
   * of artboards opens as outlines and fills in where you look. Once drawn an
   * artboard stays — panning back and forth should not re-run its markup — and
   * the set is keyed by id, so a reload keeps it.
   */
  const near = useMemo(() => visibleArtboards(placed, size, pan, zoom), [placed, size, pan, zoom])
  const [drawn, setDrawn] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setDrawn((prev) => {
      let grew = false
      for (const id of near) if (!prev.has(id)) grew = true
      if (!grew) return prev
      const next = new Set(prev)
      for (const id of near) next.add(id)
      return next
    })
  }, [near])

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
    const next = fitZoom(content, size)
    setZoom(next)
    setPan(centre(content, size, next))
  }, [content, size])

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
      const framed = frame(target, size)
      setZoom(framed.zoom)
      setPan(framed.pan)
      onSelect(target.artboard.id)
      return
    }
    fit()
  }, [fit, signature, size, content.width, focus, placed, onSelect])

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      moved.current = true
      const box = viewport.current?.getBoundingClientRect()
      const point = { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) }

      // The platform convention: a pinch arrives as ctrl-wheel, and cmd-wheel
      // is what people reach for deliberately.
      if (e.ctrlKey || e.metaKey) {
        const next = clampZoom(zoom * Math.exp(-e.deltaY / 240))
        setPan(zoomAbout(pan, zoom, next, point))
        setZoom(next)
        return
      }
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
    },
    [pan, zoom]
  )

  const onPointerDown = (e: React.PointerEvent): void => {
    // Only a drag on the background pans; a drag starting on an artboard is a
    // selection, and will be a move once dragging writes a patch back.
    if ((e.target as HTMLElement).closest('[data-artboard-frame]')) return
    dragging.current = { x: e.clientX, y: e.clientY, pan }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const from = dragging.current
    if (!from) return
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) >= CLICK_SLOP) moved.current = true
    setPan({ x: from.pan.x + (e.clientX - from.x), y: from.pan.y + (e.clientY - from.y) })
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
          className="absolute origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {placed.map(({ artboard, x, y, height }) => {
            const order = selected.indexOf(artboard.id)
            const isSelected = order >= 0
            const isDrawn = drawn.has(artboard.id) || near.has(artboard.id)
            return (
            <div key={artboard.id} className="absolute" style={{ left: x, top: y }}>
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
                  bottom: `calc(100% + ${4 / zoom}px)`,
                  fontSize: `${11.5 / zoom}px`,
                  maxWidth: artboard.size.width
                }}
              >
                {artboard.name}
              </button>
              {/* The pick order, shown once there is an order to show. It is the
                  export's default page order, so it is worth seeing before
                  the dialog says so. Counter-scaled like the title. */}
              {isSelected && selected.length > 1 && (
                <span
                  className="pointer-events-none absolute z-10 flex items-center justify-center rounded-full bg-design-accent font-medium text-design-accent-foreground tabular-nums ring-2 ring-background"
                  style={{
                    top: -10 / zoom,
                    right: -10 / zoom,
                    width: 20 / zoom,
                    height: 20 / zoom,
                    fontSize: `${11 / zoom}px`
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
                  if (!selected.includes(artboard.id)) onSelect(artboard.id)
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
                    ? `${2 / zoom}px solid ${SELECTED}`
                    : isDrawn
                      ? `${Math.max(0.5, 1 / zoom)}px solid var(--border)`
                      : 'none',
                  outlineOffset: isSelected ? 2 / zoom : 0
                }}
              >
                {isDrawn ? (
                  <Artboard artboard={artboard} theme={theme} onMeasure={measure} />
                ) : (
                  <ArtboardOutline artboard={artboard} height={height} zoom={zoom} />
                )}
              </div>
              {overlay && isDrawn && overlay(artboard, zoom)}
            </div>
            )
          })}
        </div>
      </div>

      {/* Floating over the canvas rather than a bar under it: the canvas
          keeps the whole height, and this is all the chrome it needs. */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-at-8 border bg-background px-2 py-0.5 text-[12.5px] leading-[1.5]">
        <ZoomButton label="Zoom out" onClick={() => { moved.current = true; setZoom((z) => clampZoom(z / 1.25)) }}>
          <Minus className="size-3" />
        </ZoomButton>
        <span className="text-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
        <ZoomButton label="Zoom in" onClick={() => { moved.current = true; setZoom((z) => clampZoom(z * 1.25)) }}>
          <Plus className="size-3" />
        </ZoomButton>
        <button type="button" className="pl-2 text-muted-foreground hover:text-foreground" onClick={() => { moved.current = true; fit() }}>
          Fit
        </button>
      </div>
    </div>
  )
}

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
  height,
  zoom
}: {
  artboard: ResolvedArtboard
  height: number | undefined
  zoom: number
}): React.ReactElement {
  return (
    <div
      data-artboard-outline={artboard.id}
      className="border-dashed border-border-strong"
      style={{
        borderWidth: 1 / zoom,
        width: artboard.size.width,
        height: artboard.size.height === 'auto' ? (height ?? 720) : artboard.size.height
      }}
    />
  )
}

export { TITLE_SPACE }
