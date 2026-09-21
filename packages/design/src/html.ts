import { renderToStaticMarkup } from 'react-dom/server'
import { renderArtboard } from './pipeline/emit'
import type { ResolvedArtboard } from './pipeline/types'
import type { Theme } from './theme/types'

/**
 * An artboard as markup, with no document around it.
 *
 * This is what the live panel puts inside a shadow root. Using the same string
 * the rasteriser wraps is the point: the picture in the panel and the PNG
 * Claude looks at come from one code path, so the only difference between them
 * is the font hinting of two engines — which the spec accepts — and never a
 * second renderer's opinion.
 *
 * A shadow root is also what makes the reset safe. `ARTBOARD_RESET` opens with
 * `*{…}`, which in the page would reset Nyra itself; inside a shadow root it
 * reaches exactly as far as the artboard, and nothing of Nyra's reaches in.
 */

/**
 * An artboard as a self-contained HTML document.
 *
 * This is the seam between the two engines. Headless Chromium never loads a
 * server, a bundle or React: it is handed this string through `setContent` and
 * screenshots the `[data-artboard]` element. That is only possible because the
 * emitter produces plain DOM with inline styles and draws icons as raw SVG
 * rather than as lucide-react components — a decision made for exactly this.
 *
 * Verified self-contained by a test: no `<script>`, and no external reference
 * that is not a `data:` URI.
 */
export function artboardMarkup(artboard: ResolvedArtboard, theme: Theme): string {
  return renderToStaticMarkup(renderArtboard(artboard, theme))
}

export function artboardHtml(artboard: ResolvedArtboard, theme: Theme): string {
  const body = artboardMarkup(artboard, theme)
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(artboard.name)}</title>`,
    // The page itself contributes nothing. Every pixel inside the artboard
    // comes from the document; this only stops the UA margin shifting it.
    '<style>html,body{margin:0;padding:0;background:transparent}</style>',
    '</head><body>',
    body,
    '</body></html>'
  ].join('')
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/**
 * What a rasteriser needs to know to produce, name and cache one image.
 *
 * The hash is over the *resolved* artboard, not the source file, so reformatting
 * a document or renaming something it does not reference leaves every existing
 * raster valid. `scale` is in the key because a thumbnail and a full-size render
 * are different images of the same artboard — which is what makes LOD a cache
 * concern later rather than a re-render.
 */
export type RasterRequest = {
  html: string
  width: number
  /** `auto` artboards are measured from the rendered element. */
  height: number | 'auto'
  scale: number
  key: string
}

export function rasterRequest(
  artboard: ResolvedArtboard,
  theme: Theme,
  scale = 2
): RasterRequest {
  const html = artboardHtml(artboard, theme)
  return {
    html,
    width: artboard.size.width,
    height: artboard.size.height,
    scale,
    key: `${hash(html)}-${scale}x`
  }
}

/** FNV-1a. Not cryptographic, and does not need to be — this names a cache
 *  entry, and a collision costs one wrong picture, not a security boundary. */
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
