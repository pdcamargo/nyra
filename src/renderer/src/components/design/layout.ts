import type { ResolvedArtboard } from '@nyra/design'

export type Placed = {
  artboard: ResolvedArtboard
  x: number
  y: number
  width: number
  /** Measured for an `auto` artboard, so the canvas can reserve the row. */
  height: number
}

/** Room for the title above each artboard, and between neighbours. */
export const GUTTER = 72
export const TITLE_SPACE = 28
/** What an `auto` artboard is assumed to be until it has been measured. */
const ASSUMED_HEIGHT = 720

/**
 * Where the artboards sit.
 *
 * An artboard with a `position` is placed there, full stop — that is the
 * document's answer and the canvas does not second-guess it. Everything else is
 * flowed into rows, left to right, wrapping at `maxWidth`.
 *
 * Flow is deliberately not written back here. A canvas that silently rewrote
 * positions on open would turn "I have not placed this yet" into a decision
 * nobody made; the write-back belongs to a drag, as a `moveArtboard` patch.
 */
export function layout(
  artboards: ResolvedArtboard[],
  maxWidth = 2400,
  /** Measured heights for `auto` artboards, by id. Absent until the first
   *  render has laid the content out. */
  measured: Record<string, number> = {}
): Placed[] {
  const placed: Placed[] = []
  let rowX = 0
  let rowY = 0
  let rowHeight = 0

  for (const artboard of artboards) {
    const width = artboard.size.width
    const height =
      artboard.size.height === 'auto'
        ? (measured[artboard.id] ?? ASSUMED_HEIGHT)
        : artboard.size.height

    if (artboard.position) {
      placed.push({ artboard, x: artboard.position.x, y: artboard.position.y, width, height })
      continue
    }

    // Wrap before placing, so the first artboard in a row always starts at x=0
    // even when it is wider than maxWidth on its own.
    if (rowX > 0 && rowX + width > maxWidth) {
      rowX = 0
      rowY += rowHeight + GUTTER + TITLE_SPACE
      rowHeight = 0
    }
    placed.push({ artboard, x: rowX, y: rowY, width, height })
    rowX += width + GUTTER
    rowHeight = Math.max(rowHeight, height)
  }

  return placed
}

/** The box every artboard fits inside, including the space titles need. */
export function extent(placed: Placed[]): { width: number; height: number } {
  if (placed.length === 0) return { width: 0, height: 0 }
  return {
    width: Math.max(...placed.map((p) => p.x + p.width)),
    height: Math.max(...placed.map((p) => p.y + p.height))
  }
}

export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 4

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/**
 * The zoom that fits everything, with a margin, capped at 1.
 *
 * Never zooms *in* to fill the panel: a 280px mobile artboard blown up to 3x
 * looks like a design decision and is not one.
 */
export function fitZoom(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 64
): number {
  if (content.width <= 0 || content.height <= 0) return 1
  const available = {
    width: Math.max(1, viewport.width - margin * 2),
    height: Math.max(1, viewport.height - margin * 2 - TITLE_SPACE)
  }
  return clampZoom(Math.min(1, available.width / content.width, available.height / content.height))
}

/**
 * Zoom about a point, keeping what is under the cursor under the cursor.
 *
 * The arithmetic is worth doing properly: zooming about the top-left instead
 * makes the canvas feel like it is fighting you, which is the single thing
 * people notice about a bad one.
 */
export function zoomAbout(
  pan: { x: number; y: number },
  zoom: number,
  nextZoom: number,
  point: { x: number; y: number }
): { x: number; y: number } {
  const world = { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom }
  return { x: point.x - world.x * nextZoom, y: point.y - world.y * nextZoom }
}

/** Centre the content in the viewport at a given zoom. */
export function centre(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  zoom: number
): { x: number; y: number } {
  return {
    x: (viewport.width - content.width * zoom) / 2,
    y: (viewport.height - content.height * zoom) / 2 + TITLE_SPACE * zoom
  }
}

/**
 * Pan and zoom that frames one artboard.
 *
 * The same arithmetic as fitting everything, pointed at a single box — which
 * is why there is no second implementation. Capped at 1 for the same reason
 * `fitZoom` is: a 280px mobile screen magnified to fill a panel reads as a
 * design decision and is not one.
 */
export function frame(
  placed: Placed,
  viewport: { width: number; height: number },
  margin = 48
): { zoom: number; pan: { x: number; y: number } } {
  const zoom = fitZoom({ width: placed.width, height: placed.height }, viewport, margin)
  return {
    zoom,
    pan: {
      x: (viewport.width - placed.width * zoom) / 2 - placed.x * zoom,
      y: (viewport.height - placed.height * zoom) / 2 - placed.y * zoom + TITLE_SPACE * zoom
    }
  }
}

/**
 * The artboards worth drawing: those within reach of the viewport.
 *
 * World space is the viewport undone by pan and zoom, grown by `margin` of a
 * viewport on every side so an artboard is drawn just before it scrolls in
 * rather than as it does. Everything else is an outline at its real size,
 * which is what lets a design with hundreds of artboards open at all.
 */
export function visibleArtboards(
  placed: Placed[],
  viewport: { width: number; height: number },
  pan: { x: number; y: number },
  zoom: number,
  margin = 0.5
): Set<string> {
  const seen = new Set<string>()
  if (viewport.width === 0 || zoom <= 0) return seen
  const w = viewport.width / zoom
  const h = viewport.height / zoom
  const left = -pan.x / zoom - w * margin
  const top = -pan.y / zoom - h * margin
  const right = left + w * (1 + 2 * margin)
  const bottom = top + h * (1 + 2 * margin)
  for (const p of placed) {
    const inside = p.x < right && p.x + p.width > left && p.y - TITLE_SPACE < bottom && p.y + p.height > top
    if (inside) seen.add(p.artboard.id)
  }
  return seen
}

/**
 * A length that stays the same on screen at any zoom: `n` screen pixels,
 * plus `offset` in the artboard's own pixels.
 *
 * Divided by `--z`, which the canvas writes onto its transformed layer as the
 * zoom changes — so labels, outlines and pins are counter-scaled by the style
 * engine on the frame the zoom lands, with no React render behind each step.
 * `1` outside a canvas, where nothing is scaled.
 */
export const screenPx = (n: number, offset = 0): string =>
  offset === 0 ? `calc(${n}px / var(--z, 1))` : `calc(${offset}px + ${n}px / var(--z, 1))`
