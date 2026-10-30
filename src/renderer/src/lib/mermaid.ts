import type { Mermaid } from 'mermaid'
import type { ResolvedTheme } from '../hooks/useResolvedTheme'

/**
 * ```mermaid fences, drawn as the diagram they describe.
 *
 * Mermaid is a few megabytes of parser and layout, so it loads the first time a
 * diagram is on screen, the way Shiki does for code.
 */
let mermaidPromise: Promise<Mermaid> | null = null
function getMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  return mermaidPromise
}

// `initialize` sets one global config and `render` reads it later, so a light
// render and a dark one in flight together could each paint in the other's
// theme. One at a time, configured right before each.
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

// SVG by theme and source, null for source that does not draw. The transcript is
// virtualised; without this every diagram re-rendered — and re-measured, height
// and all — each time it scrolled back into view.
const diagrams = new Map<string, string | null>()
const DIAGRAM_CACHE_LIMIT = 200

const cacheKey = (code: string, theme: ResolvedTheme): string => `${theme}\0${code}`

/** The settled result for this source: SVG, null if it failed, undefined if never tried. */
export function cachedDiagram(code: string, theme: ResolvedTheme): string | null | undefined {
  return diagrams.get(cacheKey(code, theme))
}

/** SVG markup for `code`, or null when it does not parse or lay out. */
export function renderDiagram(code: string, theme: ResolvedTheme): Promise<string | null> {
  const key = cacheKey(code, theme)
  if (diagrams.has(key)) return Promise.resolve(diagrams.get(key) ?? null)

  const run = async (): Promise<string | null> => {
    const mermaid = await getMermaid()
    mermaid.initialize({
      startOnLoad: false,
      // Claude writes the source. Strict keeps it from reaching script, click
      // handlers or raw HTML, and an `%%{init}%%` directive cannot lift it.
      securityLevel: 'strict',
      theme: theme === 'light' ? 'default' : 'dark',
      // Plain SVG text rather than HTML in a foreignObject, so the same markup
      // still has its labels when the lightbox shows it as an <img>.
      htmlLabels: false,
      fontFamily: getComputedStyle(document.body).fontFamily,
      // Failure falls back to the source; mermaid's own error graphic is a bomb.
      suppressErrorRendering: true
    })
    if (!(await mermaid.parse(code, { suppressErrors: true }))) return null
    const { svg } = await mermaid.render(`nyra-mermaid-${nextId++}`, code)
    return svg
  }

  const result = queue.then(run).catch(() => null)
  queue = result
  return result.then((svg) => {
    if (diagrams.size >= DIAGRAM_CACHE_LIMIT) diagrams.delete(diagrams.keys().next().value as string)
    diagrams.set(key, svg)
    return svg
  })
}

/**
 * The diagram as an image the lightbox can open.
 *
 * Mermaid sizes its SVG to fill its container (`width="100%"` and a max-width),
 * which as an <img> has nothing to fill, so a size from the viewBox is written
 * back in. Twice the natural size, or enlarging a small diagram would open it at
 * exactly the size it already had; the lightbox caps it to the window.
 */
export function diagramImageUrl(svg: string): string {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
  const sized = box
    ? svg
        .replace(/<svg([^>]*?) width="100%"/, `<svg$1 width="${Number(box[1]) * 2}" height="${Number(box[2]) * 2}"`)
        .replace(/max-width:\s*[\d.]+px;?/, '')
    : svg
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`
}
