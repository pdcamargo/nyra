/**
 * Which files the viewer can draw instead of quoting.
 *
 * One list, in one place, because two surfaces ask the question and a second
 * copy is a second answer: the preview asks "can I render this?", and the Rust
 * side asks "may I hand these bytes over?" — `fs_read_image` allows what it
 * allows, and anything it refuses falls back to the placeholder.
 *
 * SVG is deliberately absent, here and there: it is a script-execution surface
 * inside an `<img>`, and it needs its own decision about sanitising rather than
 * a place on a list of extensions.
 */

/** Raster formats, lower-case extensions and all. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path))
}

/** Extensions that get the rendered markdown viewer. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path))
}
