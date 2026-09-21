/**
 * Raster artboards to PNGs and print their paths.
 *
 * This is the whole design loop's missing link, and it is a command rather than
 * an MCP tool on purpose: Nyra already teaches every session to display a PNG by
 * writing `![alt](/absolute/path.png)` (`IMAGE_CONVENTION` in claude.rs). So
 * Claude needs a way to *make* the file, not a new way to show it.
 *
 *   design-raster <file.nyui.json>              every artboard
 *   design-raster <file.nyui.json> <artboardId> one of them
 *   design-raster <file.nyui.json> --scale 1    half-size, for a thumbnail
 *
 * Rendering goes through a sidecar process rather than launching Chromium here,
 * because the sidecar already knows how to find a usable one — it prefers the
 * Chrome the user has and falls back to Playwright's build, and duplicating that
 * probe is how the two drift.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { rasterRequest } from '../src/html'
import { compile } from '../src/pipeline'
import { PipelineError } from '../src/pipeline/types'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const rest = args.filter((a) => a !== file && !a.startsWith('--'))
const wanted = rest[0]
const scaleAt = args.indexOf('--scale')
const scale = scaleAt === -1 ? 2 : Number(args[scaleAt + 1])

if (!file) {
  console.error('usage: design-raster <file.nyui.json> [artboardId] [--scale 1|2]')
  process.exit(2)
}

/** Per-pid, per the {name}-{pid} rule. A shared scratch directory is what broke
 *  attachments across two running instances once already. */
const OUT = join(tmpdir(), `nyra-designs-${process.pid}`)

let doc
let theme
try {
  const compiled = compile(JSON.parse(readFileSync(resolve(file), 'utf8')))
  doc = compiled.doc
  theme = compiled.theme
  for (const i of compiled.issues) {
    console.error(`${i.severity}: ${i.code}: ${i.message}${i.at ? ` @ ${i.at.scope}#${i.at.id}` : ''}`)
  }
} catch (e) {
  // A design that does not compile is the most useful thing to report clearly:
  // this text is what Claude reads to fix its own document.
  console.error(`${resolve(file)} did not compile`)
  for (const i of (e as PipelineError).issues ?? []) {
    console.error(`  ${i.severity}: ${i.code}: ${i.message}${i.path ? ` @ ${i.path.join('.')}` : ''}`)
  }
  if (!(e instanceof PipelineError)) console.error(`  ${(e as Error).message}`)
  process.exit(1)
}

const targets = wanted ? doc.artboards.filter((a) => a.id === wanted) : doc.artboards
if (targets.length === 0) {
  console.error(`no artboard "${wanted}" — have: ${doc.artboards.map((a) => a.id).join(', ')}`)
  process.exit(1)
}

const sidecar = spawn(process.execPath, ['index.mjs'], {
  cwd: resolve(import.meta.dirname, '../../../sidecar'),
  stdio: ['pipe', 'pipe', 'pipe']
})
let sidecarNoise = ''
sidecar.stderr.on('data', (b) => {
  sidecarNoise += String(b)
})

let id = 0
const pending = new Map<number, (v: unknown) => void>()
createInterface({ input: sidecar.stdout }).on('line', (line) => {
  try {
    const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.error ? { __error: msg.error } : msg.result)
      pending.delete(msg.id)
    }
  } catch {
    // Not a response line. The sidecar also pushes events nobody asked for.
  }
})

const call = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res as (v: unknown) => void)
    sidecar.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`)
  })

const run = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true })
  let failed = false

  for (const artboard of targets) {
    const req = rasterRequest(artboard, theme, scale)
    const got = await call('design.raster', req)
    if (got?.__error) {
      console.error(`${artboard.id}: ${JSON.stringify(got.__error)}`)
      if (sidecarNoise.includes('missing')) console.error(sidecarNoise.trim())
      failed = true
      continue
    }
    // Copy out of the sidecar's per-pid directory, which it removes on exit.
    const out = join(OUT, `${artboard.id}@${scale}x.png`)
    copyFileSync(got.path, out)
    console.log(`${out}`)
    console.error(`  ${artboard.name} — ${got.width}x${got.height} @${scale}x`)
  }

  sidecar.kill()
  process.exit(failed ? 1 : 0)
}

void run()
