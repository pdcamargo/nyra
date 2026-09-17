// @vitest-environment node
/**
 * The renderer's CDP code against a real Chromium.
 *
 * Everything risky about the browser panel lives below React: attaching a flat
 * session, pinning the viewport, keeping the screencast acked so it does not
 * stall after the first frame, and starting exactly one stream per tab at the
 * largest size anybody asked for. None of that is observable from a component
 * test, and all of it is the kind of thing that breaks silently.
 *
 * Opt-in — it launches a browser and takes a few seconds:
 *   NYRA_BROWSER_TESTS=1 npx vitest run src/__tests__/browser
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectCdp, type CdpConnection } from '../../renderer/src/lib/browser/cdp'
import { createScreencastHub, type ScreencastHub } from '../../renderer/src/lib/browser/screencast'

const ENABLED = Boolean(process.env.NYRA_BROWSER_TESTS)
const VIEWPORT = { width: 1280, height: 800 }
const SIDECAR = fileURLToPath(new URL('../../../sidecar/index.mjs', import.meta.url))

/** Node has no createImageBitmap. The hub only needs something with width,
 *  height and close(), and the test only needs to know bytes arrived. */
const decoded: number[] = []
;(globalThis as Record<string, unknown>).createImageBitmap = async (blob: Blob) => {
  decoded.push(blob.size)
  return { width: VIEWPORT.width, height: VIEWPORT.height, close: () => {} }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!ENABLED)('renderer CDP against a real Chromium', () => {
  let child: ChildProcessWithoutNullStreams
  let conn: CdpConnection
  let hub: ScreencastHub
  let targetId: string
  let nextId = 0
  const pending = new Map<number, (v: Record<string, unknown>) => void>()

  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise((resolve) => pending.set(id, resolve))
  }

  beforeAll(async () => {
    child = spawn('node', [SIDECAR], { stdio: ['pipe', 'pipe', 'pipe'] })
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id == null) return
      pending.get(message.id)?.(message.error ? { error: message.error } : message.result)
      pending.delete(message.id)
    })

    await rpc('configure', { patch: { allowedOrigins: ['http://localhost:1420'] } })
    const opened = await rpc('chat.open', { chatId: 'test' })
    const created = await rpc('tab.create', {
      chatId: 'test',
      // An animating page, so frames keep being produced and a stalled stream
      // is distinguishable from a still one.
      url:
        'data:text/html,' +
        encodeURIComponent(
          `<body style="margin:0;background:#111"><canvas id=c width=600 height=400></canvas>
           <script>const x=c.getContext('2d');let n=0;(function l(){n++;
           x.fillStyle='#111';x.fillRect(0,0,600,400);
           x.fillStyle='hsl('+(n*3%360)+',80%,60%)';x.fillRect(n*7%560,180,40,40);
           requestAnimationFrame(l)})()</script></body>`
        )
    })

    conn = await connectCdp(opened.cdpUrl as string)
    hub = createScreencastHub(conn, VIEWPORT)
    targetId = (created.tab as { targetId: string }).targetId
  }, 120_000)

  afterAll(async () => {
    hub?.dispose()
    conn?.close()
    child?.stdin.end()
  })

  it('pins the viewport, so a narrow panel never reflows the page', async () => {
    await hub.session(targetId)
    const sessionId = await hub.session(targetId)
    const metrics = await conn.send<{ cssLayoutViewport: { clientWidth: number } }>(
      'Page.getLayoutMetrics',
      {},
      sessionId
    )
    expect(metrics.cssLayoutViewport.clientWidth).toBe(VIEWPORT.width)
  })

  it('keeps the stream alive, which means the ack loop works', async () => {
    const frames: number[] = []
    const stop = hub.subscribe(targetId, { width: 800, everyNthFrame: 1 }, (_, meta) => {
      frames.push(meta.deviceWidth)
    })
    await settle(3000)
    stop()

    // Without Page.screencastFrameAck Chromium sends a couple of frames and
    // then waits forever, so this number is the whole assertion.
    expect(frames.length).toBeGreaterThan(20)
    expect(decoded.every((size) => size > 0)).toBe(true)
  }, 20_000)

  it('reports a metadata shape that makes the coordinate mapping a plain scale', async () => {
    let seen: { pageScaleFactor: number; offsetTop: number; deviceWidth: number } | null = null
    const stop = hub.subscribe(targetId, { width: 640 }, (_, meta) => {
      seen = meta
    })
    await settle(1500)
    stop()

    expect(seen).not.toBeNull()
    // The reason canvas->page needs no offsets: with device metrics pinned,
    // every term DevTools' ScreencastView has to correct for is the identity.
    expect(seen!.pageScaleFactor).toBe(1)
    expect(seen!.offsetTop).toBe(0)
    expect(seen!.deviceWidth).toBe(VIEWPORT.width)
  }, 20_000)

  it('stops streaming once the last surface goes away', async () => {
    let count = 0
    const stop = hub.subscribe(targetId, { width: 400 }, () => {
      count += 1
    })
    await settle(1200)
    expect(count).toBeGreaterThan(0)

    stop()
    await settle(600)
    const afterStop = count
    await settle(1200)
    // A frame already in flight may still land, but the stream is over.
    expect(count - afterStop).toBeLessThanOrEqual(1)
  }, 20_000)
})
