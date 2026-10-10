/**
 * An artboard as a picture, for places that show it too small to read.
 *
 * A 36 px thumbnail drawn live is the whole artboard's DOM — a timeline screen
 * is some 1,300 nodes — laid out at full size and scaled down, and the chat
 * miniature showed one per changed board: two dozen live trees over the
 * conversation, restyled with everything around them. Here the same markup is
 * drawn once into an SVG image and kept, so the miniature holds bitmaps.
 *
 * Kept by markup hash, so a reload that leaves a board alone hands back the
 * same URL and the `<img>` does not even decode again. Not for anything meant
 * to be read: an SVG image cannot reach Nyra's loaded web fonts, so text falls
 * back to a system face — invisible at thumbnail size, wrong at full size.
 */
import type { ResolvedArtboard, Theme } from '@nyra/design'
import { drawnOf } from './designMarkup'

/** A picture, and the size it was made for: it is drawn at exactly that. */
export type Thumbnail = { url: string; width: number; height: number }
/** The box a picture is fitted into, never enlarged. */
export type ThumbBox = { maxWidth: number; maxHeight: number }

const thumbs = new Map<string, Thumbnail>()
/** Thumbnails are small and cheap to keep; this bounds a long session. */
const MAX_THUMBS = 300

const keyOf = (artboard: ResolvedArtboard, theme: Theme, box: ThumbBox): string =>
  `${drawnOf(artboard, theme).hash}:${artboard.size.width}:${box.maxWidth}x${box.maxHeight}`

/** The picture, if it has been made. Never does any work. */
export function thumbnailNow(artboard: ResolvedArtboard, theme: Theme, box: ThumbBox): Thumbnail | null {
  const key = keyOf(artboard, theme, box)
  const hit = thumbs.get(key)
  if (!hit) return null
  thumbs.delete(key)
  thumbs.set(key, hit)
  return hit
}

/**
 * The height an `auto` artboard comes to, laid out once off screen.
 *
 * An SVG image has to be given its size, and an `auto` artboard only has one
 * after layout. A hidden shadow root, the same one `Artboard` uses, measured
 * and thrown away: one layout per markup, against one per frame it was shown.
 */
function measure(markup: string, width: number): number {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;visibility:hidden;pointer-events:none`
  document.body.appendChild(host)
  try {
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = markup
    const inner = root.querySelector('[data-artboard]')
    return inner instanceof HTMLElement ? inner.offsetHeight : 0
  } finally {
    host.remove()
  }
}

function build(artboard: ResolvedArtboard, theme: Theme, box: ThumbBox): Thumbnail | null {
  const { markup } = drawnOf(artboard, theme)
  const full = artboard.size.width
  const fullHeight = artboard.size.height === 'auto' ? measure(markup, full) : artboard.size.height
  if (!(fullHeight > 0)) return null
  const scale = Math.min(1, box.maxWidth / full, box.maxHeight / fullHeight)
  const width = Math.max(1, Math.round(full * scale))
  const height = Math.max(1, Math.round(fullHeight * scale))
  // An SVG image is parsed as XML, and the markup is HTML — `<br>`, unquoted
  // booleans. Parsing it as HTML and serialising it as XHTML is the
  // conversion, and the browser's own parser is the one that agrees with it.
  const body = new DOMParser().parseFromString(markup, 'text/html').body
  const serializer = new XMLSerializer()
  const xhtml = Array.from(body.childNodes, (n) => serializer.serializeToString(n)).join('')
  // Made at the size it is shown, and shrunk by a transform inside. WebKit
  // does not scale `foreignObject` content with a viewBox, nor with the
  // image's CSS size — either one crops the artboard instead of shrinking it.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${scale});transform-origin:0 0;width:${full}px">` +
    `${xhtml}</div></foreignObject></svg>`
  return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), width, height }
}

function keep(key: string, thumb: Thumbnail): void {
  thumbs.set(key, thumb)
  for (const [k, t] of thumbs) {
    if (thumbs.size <= MAX_THUMBS) break
    thumbs.delete(k)
    URL.revokeObjectURL(t.url)
  }
}

/**
 * Pictures waiting to be made, one per frame.
 *
 * Making one is a parse, a serialise and — for an `auto` board — a layout. A
 * strip of two dozen asking at once would be the stall this exists to avoid,
 * so they queue, and whoever stops wanting one before its turn is skipped.
 */
type Job = { key: string; artboard: ResolvedArtboard; theme: Theme; box: ThumbBox; waiting: Set<(t: Thumbnail | null) => void> }
const queue = new Map<string, Job>()
let scheduled = false

function pump(): void {
  scheduled = false
  const next = queue.values().next()
  if (next.done) return
  const job = next.value
  queue.delete(job.key)
  if (job.waiting.size > 0) {
    const made = thumbs.get(job.key) ?? build(job.artboard, job.theme, job.box)
    if (made) keep(job.key, made)
    for (const done of job.waiting) done(made)
  }
  if (queue.size > 0) schedule()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(pump)
}

/** Asks for the picture. Calls back once it exists (null if it cannot), and
 *  returns a cancel for when the asker goes away first. */
export function requestThumbnail(
  artboard: ResolvedArtboard,
  theme: Theme,
  box: ThumbBox,
  done: (t: Thumbnail | null) => void
): () => void {
  const key = keyOf(artboard, theme, box)
  const job = queue.get(key) ?? { key, artboard, theme, box, waiting: new Set() }
  job.waiting.add(done)
  queue.set(key, job)
  schedule()
  return () => job.waiting.delete(done)
}
