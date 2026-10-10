/**
 * Each artboard's markup, built once per compile and then only read.
 *
 * `renderToStaticMarkup` over a 24-artboard screen is the most expensive thing
 * Nyra does with a design after parsing it, and it used to run on the main
 * thread three times per file change: once for the activity store's hashes,
 * once more when the panel acknowledged them, and once per drawn artboard just
 * to find out nothing had changed. Now the worker builds it beside the compile
 * and every reader comes here.
 *
 * Keyed by the artboard object, which a compile creates fresh, so an entry
 * lives exactly as long as the design it describes. The theme is checked as
 * well as stored: markup is only right for the theme it was drawn with, and a
 * caller passing a different one gets it drawn again rather than a stale answer.
 */
import { artboardMarkup, hash, type ResolvedArtboard, type ResolvedDocument, type Theme } from '@nyra/design'

export type Drawn = { markup: string; hash: string }

const drawn = new WeakMap<ResolvedArtboard, Drawn & { theme: Theme }>()

/**
 * Markup already built, by what it was built from: the resolved artboard and
 * the theme, as JSON. Lives in the worker, across compiles.
 *
 * A save changes one panel and recompiles the file, and every other artboard
 * resolves to exactly what it did before — so it is found here rather than
 * drawn again. Keyed by content rather than by file and id, so a board that
 * is renamed, moved between files or shared by two open designs still hits.
 */
const built = new Map<string, Drawn>()
let builtChars = 0
/** About 64 MB of UTF-16, past which the least recently used goes. */
const BUILT_BUDGET = 32 * 1024 * 1024

function cached(key: string, build: () => string): Drawn {
  const hit = built.get(key)
  if (hit) {
    // Re-inserted, so the Map's order is least recently used first.
    built.delete(key)
    built.set(key, hit)
    return hit
  }
  const markup = build()
  const fresh = { markup, hash: hash(markup) }
  built.set(key, fresh)
  builtChars += markup.length
  for (const [k, v] of built) {
    if (builtChars <= BUILT_BUDGET || k === key) break
    built.delete(k)
    builtChars -= v.markup.length
  }
  return fresh
}

/**
 * cyrb53: a 53-bit hash, for the cache key. The 32-bit FNV that names rasters
 * is fine where a collision costs a redraw; here it would show one panel's
 * picture in another's place, so the key gets the wider one.
 */
function hash53(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** What the worker sends back beside a compile: one entry per artboard, by id.
 *  Only the artboards whose content changed are drawn. */
export function drawAll(doc: ResolvedDocument, theme: Theme): Record<string, Drawn> {
  const themeKey = hash(JSON.stringify(theme))
  return Object.fromEntries(
    doc.artboards.map((a) => {
      const json = JSON.stringify(a)
      const key = `${themeKey}:${hash53(json)}:${json.length}`
      return [a.id, cached(key, () => artboardMarkup(a, theme))]
    })
  )
}

/** Files what the worker drew against the artboards it arrived with. */
export function remember(doc: ResolvedDocument, theme: Theme, all: Record<string, Drawn>): void {
  for (const a of doc.artboards) {
    const d = all[a.id]
    if (d) drawn.set(a, { ...d, theme })
  }
}

/** The artboard's markup and its hash, drawn here only if nothing has yet. */
export function drawnOf(artboard: ResolvedArtboard, theme: Theme): Drawn {
  const known = drawn.get(artboard)
  if (known && known.theme === theme) return known
  const markup = artboardMarkup(artboard, theme)
  const fresh = { markup, hash: hash(markup), theme }
  drawn.set(artboard, fresh)
  return fresh
}
