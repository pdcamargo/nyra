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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'

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

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/**
 * Local image paths as data URIs.
 *
 * `setContent` puts the document on about:blank, where `./hero.png` resolves to
 * nothing. The document's own folder is what the author meant, so that is where
 * it is read from; a path that is not there is left alone and reported by the
 * caller as a missing image rather than failing the whole export.
 */
export function inlineImages(html, baseDir) {
  if (!baseDir) return html
  return html.replace(/(<img\b[^>]*?\ssrc=")(\.{0,2}\/(?!\/)[^"]+)"/g, (whole, head, src) => {
    const raw = src.replace(/&amp;/g, '&')
    const candidates = raw.startsWith('/') ? [raw, join(baseDir, raw)] : [resolve(baseDir, raw)]
    for (const file of candidates) {
      try {
        if (!existsSync(file) || !statSync(file).isFile()) continue
        const mime = MIME[extname(file).slice(1).toLowerCase()]
        if (!mime) continue
        return `${head}data:${mime};base64,${readFileSync(file).toString('base64')}"`
      } catch {
        // Unreadable is the same as missing: report it, keep going.
      }
    }
    return whole
  })
}

/**
 * Several artboards to one PDF, written straight to `out`.
 *
 * A page of its own rather than the raster page, so an export never waits on
 * or disturbs a raster in flight. Every page is measured after layout and given
 * a named `@page` of exactly that size, which is what lets a phone screen and
 * a desktop screen share a document without either being letterboxed.
 */
export async function printPdf(browser, { html, pages, out, baseDir }, log) {
  if (!out) throw new Error('printPdf needs an output path')
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('printPdf needs at least one page')

  const ctx = await ensureContext(browser, log)
  const p = await ctx.newPage()
  try {
    const widest = Math.max(...pages.map((pg) => pg.width))
    await p.setViewportSize({ width: Math.max(320, Math.ceil(widest)), height: 800 })
    await p.setContent(inlineImages(html, baseDir), { waitUntil: 'load' })

    const measured = await p.$$eval('[data-pdf-page]', (els) =>
      els.map((el) => {
        const inner = el.querySelector('[data-artboard]') ?? el
        const box = inner.getBoundingClientRect()
        const broken = [...el.querySelectorAll('img')]
          .filter((img) => img.complete && img.naturalWidth === 0)
          .map((img) => img.getAttribute('src') ?? '')
        return { width: box.width, height: box.height, broken }
      })
    )

    const rules = measured
      .map((m, i) => {
        const w = Math.ceil(m.width || pages[i].width)
        const h = Math.ceil(m.height || (typeof pages[i].height === 'number' ? pages[i].height : 800))
        return `@page p${i}{size:${w}px ${h}px;margin:0}[data-pdf-page="${i}"]{height:${h}px}`
      })
      .join('')
    await p.addStyleTag({ content: rules })

    const buffer = await p.pdf({ printBackground: true, preferCSSPageSize: true })
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, buffer)

    const missing = measured.flatMap((m, i) =>
      m.broken.map((src) => ({ page: i, id: pages[i].id, src: src.startsWith('data:') ? 'embedded image' : src }))
    )
    log?.(`design: printed ${pages.length} page(s) to ${out}${missing.length ? `, ${missing.length} image(s) missing` : ''}`)
    return { path: out, pages: pages.length, bytes: buffer.length, missing }
  } finally {
    await p.close().catch(() => {})
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
