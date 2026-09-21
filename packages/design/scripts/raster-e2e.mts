/**
 * End to end against a real sidecar process: document -> HTML -> RPC -> PNG.
 * Proves the parts that only a live sidecar can: the render context never
 * becomes a tab, the cache returns hits, and the files land in the per-pid dir.
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { compile } from '../src/pipeline'
import { rasterRequest } from '../src/html'

const sidecar = spawn(process.execPath, ['index.mjs'], {
  cwd: new URL('../../../sidecar/', import.meta.url).pathname,
  stdio: ['pipe', 'pipe', 'pipe']
})
sidecar.stderr.on('data', (b) => {
  const s = String(b).trim()
  if (/design:|error/i.test(s)) console.log(`  [sidecar] ${s}`)
})

let id = 0
const pending = new Map<number, (v: unknown) => void>()
createInterface({ input: sidecar.stdout }).on('line', (line) => {
  let msg: { id?: number; result?: unknown; error?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.error ? { __error: msg.error } : msg.result)
    pending.delete(msg.id)
  }
})

const call = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res as (v: unknown) => void)
    sidecar.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`)
  })

const file = process.argv[2]
const { doc, theme } = compile(JSON.parse(readFileSync(file, 'utf8')))

const run = async (): Promise<void> => {
  const before = await call('status')
  console.log(`chats before: ${JSON.stringify(before?.chats ?? before?.__error)}`)

  for (const artboard of doc.artboards) {
    const req = rasterRequest(artboard, theme, 2)
    const t0 = Date.now()
    const cold = await call('design.raster', req)
    if (cold?.__error) {
      console.log(`FAILED ${artboard.id}: ${JSON.stringify(cold.__error)}`)
      continue
    }
    const t1 = Date.now()
    const warm = await call('design.raster', req)
    const bytes = statSync(cold.path).size

    console.log(
      `${artboard.id}: ${cold.width}x${cold.height} @${cold.scale}x — ` +
        `cold ${t1 - t0}ms, warm ${Date.now() - t1}ms (cached: ${warm.cached}), ${Math.round(bytes / 1024)}kb`
    )
  }

  const after = await call('status')
  console.log(`chats after:  ${JSON.stringify(after.chats)}   <- a render must never create one`)
  console.log(`raster dir:   ${after.design.dir}`)
  const stats = await call('design.stats')
  console.log(`files:        ${stats.files.join(', ')}`)

  // Copy out before the sidecar exits: it removes its own per-pid directory on
  // the way down, which is the behaviour we want and awkward for inspection.
  const keep = process.argv[3]
  if (keep) {
    const { copyFileSync } = await import('node:fs')
    const req = rasterRequest(doc.artboards[0], theme, 2)
    const hit = await call('design.raster', req)
    copyFileSync(hit.path, keep)
    console.log(`kept:         ${keep}`)
  }

  sidecar.kill()
}

void run()
