import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ResolvedArtboard, Theme } from '@nyra/design'
import { cn } from 'cn'
import Artboard from './Artboard'
import {
  centre,
  clampZoom,
  extent,
  fitZoom,
  frame,
  layout,
  TITLE_SPACE,
  zoomAbout
} from './layout'

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
  onContextMenu
}: {
  artboards: ResolvedArtboard[]
  theme: Theme
  selected: string | null
  onSelect: (id: string | null) => void
  /** Frame this artboard instead of fitting everything. Set when a chip
   *  pointed at one, so "see the Protocol panel" lands on the Protocol panel. */
  focus?: string | null
  onContextMenu?: (artboardId: string, at: { x: number; y: number }) => void
}): React.ReactElement {
  const viewport = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null)
  /** Refit when the design changes, but never again — refitting on every
   *  resize would yank the view out from under someone mid-inspection. */
  const fitted = useRef<string | null>(null)

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
    const want = `${signature}::${focus ?? ''}`
    if (fitted.current === want) return
    fitted.current = want

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
    onSelect(null)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const from = dragging.current
    if (!from) return
    setPan({ x: from.pan.x + (e.clientX - from.x), y: from.pan.y + (e.clientY - from.y) })
  }

  const endDrag = (): void => {
    dragging.current = null
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={viewport}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-muted/40',
          dragging.current ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="absolute origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {placed.map(({ artboard, x, y }) => (
            <div key={artboard.id} className="absolute" style={{ left: x, top: y }}>
              <button
                type="button"
                data-artboard-frame={artboard.id}
                onClick={() => onSelect(artboard.id)}
                className={cn(
                  'absolute left-0 truncate text-left',
                  selected === artboard.id ? 'text-primary' : 'text-muted-foreground'
                )}
                style={{
                  // Counter-scaled so a label stays readable at any zoom, which
                  // is the whole reason it is not part of the artboard.
                  bottom: `calc(100% + ${8 / zoom}px)`,
                  fontSize: `${13 / zoom}px`,
                  maxWidth: artboard.size.width
                }}
              >
                {artboard.name}
              </button>
              <div
                data-artboard-frame={artboard.id}
                onClick={() => onSelect(artboard.id)}
                onContextMenu={(e) => {
                  if (!onContextMenu) return
                  e.preventDefault()
                  onSelect(artboard.id)
                  onContextMenu(artboard.id, { x: e.clientX, y: e.clientY })
                }}
                className="bg-background"
                style={{
                  outline:
                    selected === artboard.id
                      ? `${Math.max(1, 2 / zoom)}px solid var(--primary)`
                      : `${Math.max(0.5, 1 / zoom)}px solid var(--border)`
                }}
              >
                <Artboard artboard={artboard} theme={theme} onMeasure={measure} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-accent"
          onClick={() => setZoom((z) => clampZoom(z / 1.25))}
        >
          −
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-accent"
          onClick={() => setZoom((z) => clampZoom(z * 1.25))}
        >
          +
        </button>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={fit}>
          Fit
        </button>
        <span className="ml-auto truncate">
          {artboards.length} artboard{artboards.length === 1 ? '' : 's'} · drag to pan · ⌘-scroll to
          zoom
        </span>
      </div>
    </div>
  )
}

export { TITLE_SPACE }
