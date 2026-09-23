/**
 * How many pixels to ask Chromium for.
 *
 * Measured against a real Chromium rather than reasoned about, because the
 * obvious guess is wrong: `Page.startScreencast` is capped at the page's CSS
 * viewport and `maxWidth` only ever downscales. `deviceScaleFactor` raises the
 * raster and the page's own `devicePixelRatio`, but it does *not* raise
 * screencast resolution — a 400x300 viewport at dsf 3 still screencasts
 * 400x300, while `Page.captureScreenshot` on the same page returns 1200x900.
 *
 * So the ceiling here is `viewport.width`, never `viewport.width * dsf`, and a
 * frame sharper than the CSS viewport has to come from a screenshot instead.
 *
 * What that leaves is the bug this file exists to fix: the panel asked for its
 * width in *CSS* pixels and then drew the result onto a Retina canvas, so every
 * frame was upscaled by the device pixel ratio before anybody saw it.
 */

export type EmulatedViewport = {
  width: number
  height: number
  /** What the page sees as `devicePixelRatio`. Irrelevant to screencast size;
   *  it decides what a still screenshot comes back at. */
  deviceScaleFactor: number
}

/** A ceiling on the wire, not on the page. A very wide panel on a 3x display
 *  would otherwise ask for a frame that costs more to decode than to look at. */
export const MAX_CAPTURE_WIDTH = 2048

/** A tall phone blows the pixel count long before it blows the width. */
export const MAX_CAPTURE_PIXELS = 2_000_000

/** Requested widths move in steps, so dragging the panel does not restart the
 *  stream once per mousemove. Restarting is the only way to resize a
 *  screencast, so every distinct value costs a stop and a start. */
export const CAPTURE_STEP = 64

/** Under this, a box has not been laid out yet. Sending it would be worse than
 *  skipping — Chromium reads a width of 0 as "clear the override". */
export const MIN_RESPONSIVE_DIMENSION = 200

/** The most Chromium will give us for this page, whatever we ask. */
export function captureCeiling(viewport: EmulatedViewport): number {
  const aspect = Math.max(viewport.height / viewport.width, 0.01)
  const budget = Math.floor(Math.sqrt(MAX_CAPTURE_PIXELS / aspect))
  return Math.max(64, Math.min(viewport.width, MAX_CAPTURE_WIDTH, budget))
}

/** Round a raw pixel want up to a step and clamp it to what Chromium can give.
 *  Surfaces measure themselves and the hub reduces across them, so both sides
 *  need the same rule — this is it. */
export function stepCapture(wantedPx: number, viewport: EmulatedViewport): number {
  const ceiling = captureCeiling(viewport)
  const stepped = Math.ceil(Math.max(wantedPx, 1) / CAPTURE_STEP) * CAPTURE_STEP
  return Math.max(64, Math.min(stepped, ceiling))
}

/**
 * Device pixels to request for a surface that occupies `cssWidth` CSS pixels.
 *
 * `pixelRatio` is measured off the element rather than read from
 * `window.devicePixelRatio` — see `dpr.ts` for why.
 */
export function capturePx(
  cssWidth: number,
  viewport: EmulatedViewport,
  pixelRatio: number
): number {
  return stepCapture(Math.max(cssWidth, 1) * Math.max(pixelRatio, 1), viewport)
}

/**
 * Keep an oversized stream rather than restart it for a few pixels.
 *
 * Asking for slightly more than the box needs is invisible — `drawImage`
 * downsamples. Asking for slightly less is visibly soft. So the bias is upward,
 * and a stream only shrinks once it is two full steps too big.
 */
export function holdCapture(next: number, current: number | null): number {
  if (current === null) return next
  if (current >= next && current - next < CAPTURE_STEP * 2) return current
  return next
}

/** Frame height for a requested width, preserving the page's aspect. `ceil` so
 *  rounding never makes height the binding constraint and silently narrows the
 *  frame. */
export function captureHeight(px: number, viewport: EmulatedViewport): number {
  return Math.ceil((px * viewport.height) / viewport.width)
}

/**
 * JPEG quality: cheap for a thumbnail, generous for a page being read.
 *
 * Asked rather than inferred. This used to be a width threshold, which was
 * calibrated when the panel always rendered a 1280-wide page and so always
 * asked for more than the threshold. Responsive mode made the panel ask for its
 * own width instead — often under 480 — and a perfectly ordinary narrow panel
 * silently started streaming at thumbnail quality. Whether something is a
 * preview is a fact about the surface, not about how many pixels it happens to
 * be at the moment.
 */
export function captureQuality(preview: boolean): number {
  return preview ? 40 : 72
}

/**
 * Display scale for a viewport that has to fit a box.
 *
 * Clamped at 1: a 402-wide phone blown up to 3x on a wide panel looks broken,
 * and "fit" means "make it fit", not "fill the space".
 */
export function fitScale(
  box: { width: number; height: number },
  viewport: { width: number; height: number }
): number {
  if (box.width <= 0 || box.height <= 0) return 1
  return Math.min(1, box.width / viewport.width, box.height / viewport.height)
}
