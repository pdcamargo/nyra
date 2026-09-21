/**
 * Artboards to PNGs.
 *
 * The sidecar's half of the design renderer, and deliberately the dumb half: it
 * is handed a complete HTML string and gives back an image. It knows nothing
 * about the schema, the registry, the pipeline or React — all of that lives in
 * `@nyra/design`, on the renderer side, which is also where the live artboard
 * will eventually draw. Keeping the split here means the sidecar never grows a
 * second copy of the vocabulary to drift from the first.
 *
 * Two integration details the spec called cheap now and painful later, both
 * honoured here:
 *
 *   - A context of its own, which nothing adopts pages from. `chats` is what
 *     the tab strip is built from and the render context is not in it, so a
 *     render never appears as a tab in front of the user.
 *   - Rasters live in `$TMPDIR/nyra-designs-{pid}`, per the `{name}-{pid}`
 *     rule. A shared scratch directory is what broke attachments across two
 *     running instances once already.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = join(tmpdir(), `nyra-designs-${process.pid}`)

/** Rasters are cheap to remake and awkward to grow without bound. */
const MAX_ENTRIES = 400

let context = null
let page = null
/** key -> absolute path, for the entries this process has written. */
const cache = new Map()

export function rasterDir() {
  return DIR
}

export function designStats() {
  return { dir: DIR, cached: cache.size, open: Boolean(context) }
}

async function ensureContext(browser, log) {
  if (context) return context
  // deviceScaleFactor 2 is the raster's own concern, not the host's: these
  // images feed Claude's eyes and a chat preview, both of which want the crisp
  // one regardless of what screen the user happens to be on.
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2
  })
  context.on('close', () => {
    context = null
    page = null
  })
  log?.('design: render context opened (not a chat, never adopted as a tab)')
  return context
}

async function ensurePage(browser, log) {
  const ctx = await ensureContext(browser, log)
  if (page && !page.isClosed()) return page
  page = await ctx.newPage()
  return page
}

function evict(log) {
  if (cache.size <= MAX_ENTRIES) return
  // Oldest first by mtime, which is also least-recently-written. Rasters are
  // regenerated on demand, so evicting the wrong one costs a re-render.
  const entries = [...cache.entries()]
    .map(([key, path]) => {
      try {
        return { key, path, at: statSync(path).mtimeMs }
      } catch {
        return { key, path, at: 0 }
      }
    })
    .sort((a, b) => a.at - b.at)
  for (const e of entries.slice(0, entries.length - MAX_ENTRIES)) {
    rmSync(e.path, { force: true })
    cache.delete(e.key)
  }
  log?.(`design: evicted ${entries.length - MAX_ENTRIES} raster(s)`)
}

/**
 * HTML in, PNG path out.
 *
 * `key` is the caller's content hash — of the *resolved* artboard, so a
 * reformatted document reuses its rasters. A hit never touches the browser.
 */
export async function rasterize(browser, { html, key, width, height, scale = 2 }, log) {
  if (!key) throw new Error('rasterize needs a key')

  const hit = cache.get(key)
  if (hit && existsSync(hit)) return { path: hit, cached: true, width, height, scale }

  mkdirSync(DIR, { recursive: true })
  const p = await ensurePage(browser, log)

  // A fixed viewport wide enough for the artboard; the screenshot is clipped to
  // the element, so the viewport only has to avoid forcing a reflow narrower
  // than the design.
  await p.setViewportSize({
    width: Math.max(320, Math.ceil(width)),
    height: typeof height === 'number' ? Math.max(240, Math.ceil(height)) : 800
  })
  await p.setContent(html, { waitUntil: 'load' })

  const el = await p.$('[data-artboard]')
  if (!el) throw new Error('rendered html has no [data-artboard] element')
  const box = await el.boundingBox()

  const path = join(DIR, `${key}.png`)
  await el.screenshot({ path, scale: 'device' })
  cache.set(key, path)
  evict(log)

  return {
    path,
    cached: false,
    width: Math.round(box?.width ?? width),
    height: Math.round(box?.height ?? (typeof height === 'number' ? height : 0)),
    scale
  }
}

export async function closeDesign() {
  try {
    await context?.close()
  } catch {
    // A context that is already gone is the state we wanted.
  }
  context = null
  page = null
}

/** Called on exit. The directory is per-pid, so nothing else can want it. */
export function cleanupRasters() {
  try {
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true })
  } catch {
    // Best effort: a leftover temp directory is tidied by the OS.
  }
  cache.clear()
}

/** For tests and diagnostics — what this process has on disk right now. */
export function listRasters() {
  try {
    return readdirSync(DIR).sort()
  } catch {
    return []
  }
}
