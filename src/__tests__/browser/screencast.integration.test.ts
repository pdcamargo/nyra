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
import { buttonName, keyEventOf, pageFromCanvas } from '../../renderer/src/lib/browser/input'
import { createScreencastHub, type ScreencastHub } from '../../renderer/src/lib/browser/screencast'
import type { EmulatedViewport } from '../../renderer/src/lib/browser/viewport'

const ENABLED = Boolean(process.env.NYRA_BROWSER_TESTS)
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 2 }
const SIDECAR = fileURLToPath(new URL('../../../sidecar/index.mjs', import.meta.url))

/** Width and height straight out of the JPEG's own frame header.
 *
 *  Node has no createImageBitmap, and the shim that used to stand in for it
 *  returned the viewport size as a constant — which meant no test could see
 *  what size Chromium actually sent, and the capture math went unverified. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 2
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = bytes[i + 1]
    // SOF0..SOF15, minus the three in that range that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
    }
    i += 2 + view.getUint16(i + 2)
  }
  throw new Error('no SOF marker in frame')
}

/** The idle still is PNG rather than JPEG — lossless, because it is the frame
 *  someone actually reads. Without this the shim throws on it and the sharpen
 *  is swallowed by its own catch, leaving the test green and blind. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

const decoded: number[] = []
;(globalThis as Record<string, unknown>).createImageBitmap = async (blob: Blob) => {
  decoded.push(blob.size)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const png = PNG_MAGIC.every((byte, i) => bytes[i] === byte)
  return { ...(png ? pngSize(bytes) : jpegSize(bytes)), close: () => {} }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!ENABLED)('renderer CDP against a real Chromium', () => {
  let child: ChildProcessWithoutNullStreams
  let conn: CdpConnection
  let hub: ScreencastHub
  let targetId: string
  /** What the `tabs` broadcast would have told the store, for tabs a test resizes. */
  const resizedTo = new Map<string, EmulatedViewport>()
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
    const opened = await rpc('chat.open', { chatId: 'test', hostDpr: VIEWPORT.deviceScaleFactor })
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
    hub = createScreencastHub(conn, {
      viewportFor: (target) => resizedTo.get(target) ?? VIEWPORT,
      fallback: VIEWPORT,
      // What the app routes through Rust: the sidecar's own session, unclipped.
      stillFor: async (target) =>
        (await rpc('target.screenshot', { targetId: target })) as {
          data: string
          width: number
          height: number
        }
    })
    targetId = (created.tab as { targetId: string }).targetId
  }, 120_000)

  afterAll(async () => {
    hub?.dispose()
    conn?.close()
    child?.stdin.end()
  })

  it('takes the size the sidecar set, rather than setting one of its own', async () => {
    // This used to pass because the hub pinned the viewport itself. It now
    // passes because the *sidecar* did, and the hub attaches without touching
    // device metrics at all — so if this still reads 1280, ownership genuinely
    // moved. That is the whole point of the assertion.
    //
    // It has to be the sidecar: `deviceScaleFactor` is a Playwright context
    // option, and Playwright re-sends the context's copy from its own session
    // on every cross-process navigation, so anything written here would be
    // reverted by the first cross-origin click.
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
    const stop = hub.subscribe(targetId, { width: 800, devicePixels: 800, everyNthFrame: 1 }, (_, meta) => {
      frames.push(meta.deviceWidth)
    })
    await settle(3000)
    stop.stop()

    // Without Page.screencastFrameAck Chromium sends a couple of frames and
    // then waits forever, so this number is the whole assertion.
    expect(frames.length).toBeGreaterThan(20)
    expect(decoded.every((size) => size > 0)).toBe(true)
  }, 20_000)

  it('reports a metadata shape that makes the coordinate mapping a plain scale', async () => {
    let seen: { pageScaleFactor: number; offsetTop: number; deviceWidth: number } | null = null
    const stop = hub.subscribe(targetId, { width: 640, devicePixels: 640 }, (_, meta) => {
      seen = meta
    })
    await settle(1500)
    stop.stop()

    expect(seen).not.toBeNull()
    // The reason canvas->page needs no offsets: with device metrics pinned,
    // every term DevTools' ScreencastView has to correct for is the identity.
    expect(seen!.pageScaleFactor).toBe(1)
    expect(seen!.offsetTop).toBe(0)
    expect(seen!.deviceWidth).toBe(VIEWPORT.width)
  }, 20_000)

  it('captures device pixels, and cannot be asked past the CSS viewport', async () => {
    // Measured rather than assumed, because the obvious guess is wrong:
    // Chromium caps a screencast at the page's CSS viewport and `maxWidth` only
    // ever downscales. `deviceScaleFactor` raises the raster and the page's own
    // devicePixelRatio but not this. So a request above the viewport is clamped
    // to it, and one below is honoured exactly — which is what makes asking in
    // device pixels the fix, and asking in CSS pixels the bug.
    const wide: number[] = []
    const stopWide = hub.subscribe(targetId, { width: 640, devicePixels: 4000 }, (bitmap) => {
      wide.push(bitmap.width)
    })
    await settle(1500)
    stopWide.stop()
    expect(wide.at(-1)).toBe(VIEWPORT.width)

    const half: number[] = []
    const stopHalf = hub.subscribe(targetId, { width: 320, devicePixels: 640 }, (bitmap) => {
      half.push(bitmap.width)
    })
    await settle(1500)
    stopHalf.stop()
    expect(half.at(-1)).toBe(640)
  }, 30_000)

  it('sharpens to the full raster once the page holds still', async () => {
    // The point of the mechanism. A screencast is capped at the CSS viewport,
    // so on a Retina canvas it is always upscaled and responsive mode — where
    // the viewport *is* the panel box — can never be sharp on the stream alone.
    // `Page.captureScreenshot` has no such cap, so a still page gets one.
    const still = await rpc('tab.create', {
      chatId: 'test',
      // Static, unlike the animating tab the other tests share: a page that
      // never stops painting never goes idle, and correctly never sharpens.
      url: 'data:text/html,' + encodeURIComponent('<body style="margin:0">still</body>')
    })
    const stillTarget = (still.tab as { targetId: string }).targetId

    const widths: number[] = []
    const sub = hub.subscribe(
      stillTarget,
      { width: 600, devicePixels: 1200 },
      (bitmap) => widths.push(bitmap.width)
    )
    await settle(2500)
    sub.stop()

    // The stream itself cannot exceed the CSS viewport...
    expect(Math.min(...widths)).toBeLessThanOrEqual(VIEWPORT.width)
    // ...and the still that follows it is the whole device-pixel raster.
    expect(Math.max(...widths)).toBe(VIEWPORT.width * VIEWPORT.deviceScaleFactor)
  }, 30_000)

  it('leaves a preview alone, however long it sits still', async () => {
    // A miniature is not worth a quarter of a megabyte and fifty milliseconds,
    // and `preview` is declared rather than guessed from the width — guessing
    // is what made a merely narrow panel stream at thumbnail quality.
    const still = await rpc('tab.create', {
      chatId: 'test',
      url: 'data:text/html,' + encodeURIComponent('<body style="margin:0">quiet</body>')
    })
    const target = (still.tab as { targetId: string }).targetId

    const widths: number[] = []
    const sub = hub.subscribe(
      target,
      { width: 300, devicePixels: 600, preview: true },
      (bitmap) => widths.push(bitmap.width)
    )
    await settle(2000)
    sub.stop()
    expect(widths.length).toBeGreaterThan(0)
    // Its first frame after a start may be a 1x still — never the full raster.
    expect(Math.max(...widths)).toBeLessThanOrEqual(VIEWPORT.width)
  }, 30_000)

  it('resizes without restarting the stream once per pixel', async () => {
    // The regression this guards: resizing used to go through unsubscribe plus
    // subscribe, which takes the subscriber count to zero and stops the stream,
    // so dragging the panel stopped and started the screencast on every
    // mousemove. Responsive mode makes that continuous.
    const starts: number[] = []
    const realSend = conn.send.bind(conn)
    ;(conn as unknown as { send: typeof conn.send }).send = ((
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ) => {
      if (method === 'Page.startScreencast') starts.push(Date.now())
      return realSend(method, params as never, sessionId)
    }) as typeof conn.send

    const sub = hub.subscribe(targetId, { width: 400, devicePixels: 800 }, () => {})
    await settle(800)
    const afterFirst = starts.length

    // A drag's worth of updates, all inside one capture step.
    for (let i = 0; i < 20; i += 1) {
      sub.update({ width: 400 + i, devicePixels: 800 + i })
    }
    await settle(800)
    sub.stop()
    ;(conn as unknown as { send: typeof conn.send }).send = realSend

    expect(afterFirst).toBe(1)
    // Twenty resizes inside one 64px step must cost nothing.
    expect(starts.length).toBe(1)
  }, 30_000)

  it('follows a responsive drag on a static page, without restarting the stream', async () => {
    // The two measured facts the pacing rests on. A static page sends no stream
    // frame for a resize, so without the screenshot in `resized` these sizes
    // never land. And a stream whose limits were tied to the viewport's size
    // restarted on every one of them.
    const still = await rpc('tab.create', {
      chatId: 'test',
      url:
        'data:text/html,' +
        encodeURIComponent(`<body style="margin:0;font:16px system-ui">${'words '.repeat(600)}</body>`)
    })
    const { tabId, targetId: target } = still.tab as { tabId: string; targetId: string }
    const resize = async (width: number): Promise<void> => {
      await rpc('tab.setViewport', { chatId: 'test', tabId, id: 'responsive', width, height: 700 })
      resizedTo.set(target, { width, height: 700, deviceScaleFactor: VIEWPORT.deviceScaleFactor })
      hub.invalidate(target)
    }
    await resize(600)

    const starts: number[] = []
    const realSend = conn.send.bind(conn)
    ;(conn as unknown as { send: typeof conn.send }).send = ((
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ) => {
      if (method === 'Page.startScreencast') starts.push(Date.now())
      return realSend(method, params as never, sessionId)
    }) as typeof conn.send

    const drawn: string[] = []
    const sub = hub.subscribe(target, { width: 600, devicePixels: 1200 }, (_, meta) => {
      drawn.push(`${meta.deviceWidth}x${meta.deviceHeight}`)
    })
    await settle(800)
    const startsBefore = starts.length

    const STEPS = 15
    const began = Date.now()
    for (let i = 1; i <= STEPS; i += 1) {
      const width = 600 + i * 13
      await resize(width)
      await Promise.race([
        hub.resized(target, { width, height: 700 }),
        settle(1000).then(() => {
          throw new Error(`${width}x700 never reached the canvas`)
        })
      ])
    }
    const perStep = (Date.now() - began) / STEPS
    sub.stop()
    ;(conn as unknown as { send: typeof conn.send }).send = realSend

    expect(startsBefore).toBe(1)
    expect(starts.length).toBe(startsBefore)
    expect(drawn).toContain(`${600 + STEPS * 13}x700`)
    // Reported, not only asserted: this is the number the feature is for.
    process.stderr.write(`responsive drag: ${perStep.toFixed(1)} ms per step, ${(1000 / perStep).toFixed(0)}/s\n`)
    expect(perStep).toBeLessThan(120)
  }, 30_000)

  it('keeps the page at its pixel ratio through an idle sharpen', async () => {
    // The sharpen used to clip from this session, and a clipped capture restores
    // the metrics it found — the page's devicePixelRatio came back as 1, and the
    // stream reported frames at twice their CSS size, so the panel jumped about.
    const page = await rpc('tab.create', {
      chatId: 'test',
      url: 'data:text/html,' + encodeURIComponent('<body style="margin:0">ratio</body>')
    })
    const { targetId: target } = page.tab as { targetId: string }
    const sessionId = await hub.session(target)
    const seen: string[] = []
    const sub = hub.subscribe(target, { width: 1280, devicePixels: 2560 }, (bitmap, meta) => {
      seen.push(`${meta.deviceWidth}x${meta.deviceHeight}@${bitmap.width}`)
    })
    await settle(1500)
    sub.stop()
    const dpr = await conn.send<{ result: { value: number } }>(
      'Runtime.evaluate',
      { expression: 'devicePixelRatio', returnByValue: true },
      sessionId
    )
    expect(dpr.result.value).toBe(VIEWPORT.deviceScaleFactor)
    // No frame claims the page is twice its CSS size. Chromium reports a frame
    // composited just after a screenshot in device pixels, and the hub has to
    // read it back; a stray early frame at some other size is fine, a doubled
    // one is the bug. And the sharpened still carries the full raster.
    const doubled = `${VIEWPORT.width * 2}x${VIEWPORT.height * 2}@`
    expect(seen.filter((s) => s.startsWith(doubled))).toEqual([])
    expect(seen).toContain(`${VIEWPORT.width}x${VIEWPORT.height}@${VIEWPORT.width * 2}`)
  }, 30_000)

  it('keeps a device switch that a clipped screenshot overlapped', async () => {
    // A clipped capture emulates metrics of its own and restores the ones it
    // found when it finishes, so one in flight across a resize puts the old size
    // back — a phone switch mid-sharpen left the page laid out at the old width,
    // cropped. The per-resize shot no longer clips; the sharpen still must, so
    // the sidecar re-asserts after every change, and this is that repair.
    const page = await rpc('tab.create', {
      chatId: 'test',
      url: 'data:text/html,' + encodeURIComponent('<body style="margin:0">race</body>')
    })
    const { tabId, targetId: target } = page.tab as { tabId: string; targetId: string }
    const sessionId = await hub.session(target)
    const innerWidth = async (): Promise<number> => {
      const res = await conn.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: 'innerWidth', returnByValue: true },
        sessionId
      )
      return res.result.value
    }
    await rpc('tab.setViewport', { chatId: 'test', tabId, id: 'responsive', width: 985, height: 900 })
    await settle(400)

    const shot = conn.send(
      'Page.captureScreenshot',
      { format: 'jpeg', clip: { x: 0, y: 0, width: 985, height: 900, scale: 2 } },
      sessionId
    )
    await rpc('tab.setViewport', { chatId: 'test', tabId, id: 'iphone-16' })
    await shot.catch(() => {})
    await settle(1800)

    expect(await innerWidth()).toBe(393)
  }, 30_000)

  it('stops streaming once the last surface goes away', async () => {
    let count = 0
    const stop = hub.subscribe(targetId, { width: 400, devicePixels: 400 }, () => {
      count += 1
    })
    await settle(1200)
    expect(count).toBeGreaterThan(0)

    stop.stop()
    await settle(600)
    const afterStop = count
    await settle(1200)
    // A frame already in flight may still land, but the stream is over.
    expect(count - afterStop).toBeLessThanOrEqual(1)
  }, 20_000)
})

describe.skipIf(!ENABLED)('input reaches the page', () => {
  let child: ChildProcessWithoutNullStreams
  let conn: CdpConnection
  let hub: ScreencastHub
  let sessionId: string
  let nextId = 0
  const pending = new Map<number, (v: Record<string, unknown>) => void>()

  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise((resolve) => pending.set(id, resolve))
  }

  /** Read something back out of the page. */
  const evaluate = async (expression: string): Promise<unknown> => {
    const res = await conn.send<{ result: { value: unknown } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId
    )
    return res.result.value
  }

  /** What BrowserCanvas does on a click, minus React. The canvas is half the
   *  page's width here, so this also exercises the coordinate scaling. */
  const CANVAS = { left: 0, top: 0, width: VIEWPORT.width / 2, height: VIEWPORT.height / 2 }
  const clickAt = (canvasX: number, canvasY: number): void => {
    const { x, y } = pageFromCanvas({ x: canvasX, y: canvasY }, CANVAS, VIEWPORT)
    for (const type of ['mousePressed', 'mouseReleased']) {
      void conn.send(
        'Input.dispatchMouseEvent',
        { type, x, y, button: buttonName(0), buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 },
        sessionId
      )
    }
  }

  const type = (text: string): void => {
    for (const ch of text) {
      const base = { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0),
        repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
      void conn.send('Input.dispatchKeyEvent', keyEventOf({ ...base, key: ch }, 'down'), sessionId)
      void conn.send('Input.dispatchKeyEvent', keyEventOf({ ...base, key: ch }, 'up'), sessionId)
    }
  }

  beforeAll(async () => {
    child = spawn('node', [SIDECAR], { stdio: ['pipe', 'pipe', 'pipe'] })
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id == null) return
      pending.get(message.id)?.(message.error ? { error: message.error } : message.result)
      pending.delete(message.id)
    })
    const opened = await rpc('chat.open', { chatId: 'input' })
    const created = await rpc('tab.create', {
      chatId: 'input',
      url:
        'data:text/html,' +
        encodeURIComponent(
          `<body style="margin:0;height:3000px;font:16px system-ui">
           <button id=b style="position:absolute;left:600px;top:300px;width:120px;height:60px"
             onclick="window.__hit=1">go</button>
           <input id=i style="position:absolute;left:100px;top:100px;width:300px">
           </body>`
        )
    })
    conn = await connectCdp(opened.cdpUrl as string)
    hub = createScreencastHub(conn, { viewportFor: () => VIEWPORT, fallback: VIEWPORT })
    sessionId = await hub.session((created.tab as { targetId: string }).targetId)
  }, 120_000)

  afterAll(async () => {
    hub?.dispose()
    conn?.close()
    child?.stdin.end()
  })

  it('lands a click on the element under it, scaling from the canvas', async () => {
    // The button spans 600-720 x 300-360 on the page, so 330,165 on a
    // half-size canvas is 660,330 on the page — the middle of it.
    clickAt(330, 165)
    await settle(300)
    expect(await evaluate('window.__hit')).toBe(1)
  }, 20_000)

  it('types into the field the click focused', async () => {
    clickAt(125, 55)
    await settle(200)
    type('hello')
    await settle(300)
    expect(await evaluate('document.getElementById("i").value')).toBe('hello')
  }, 20_000)

  it('pastes without going near the shortcut', async () => {
    await conn.send('Input.insertText', { text: ' world' }, sessionId)
    await settle(200)
    expect(await evaluate('document.getElementById("i").value')).toBe('hello world')
  }, 20_000)

  it('scrolls the page rather than the panel', async () => {
    expect(await evaluate('window.scrollY')).toBe(0)
    await conn.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 400 },
      sessionId
    )
    await settle(400)
    expect(await evaluate('window.scrollY')).toBeGreaterThan(0)
  }, 20_000)
})
