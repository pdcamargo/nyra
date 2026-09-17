/**
 * Frames out of Chromium, at the size the thing looking at them actually needs.
 *
 * Surfaces subscribe to a tab and say how wide they are; the hub runs exactly
 * one screencast per tab, at the largest width anybody asked for, and stops it
 * when the last subscriber goes. That is what keeps the budget honest without
 * anyone having to think about it: the panel and a miniature of the same tab
 * share one stream, and a tab nobody is rendering costs nothing.
 *
 * Frames are cheap — measured at 10.6 KB each at 1280 wide and 1.3 KB at 300 —
 * so five live miniatures run at 0.09 MB/s. The reason not to show ten of them
 * is the screen, not the wire.
 */
import type { CdpConnection } from './cdp'

/** What Chromium says about the frame it just sent. With device metrics pinned
 *  these are constant, which is the whole reason the coordinate mapping is a
 *  single scale factor instead of DevTools' four-term formula. */
export type FrameMetadata = {
  offsetTop: number
  pageScaleFactor: number
  deviceWidth: number
  deviceHeight: number
  scrollOffsetX: number
  scrollOffsetY: number
  timestamp?: number
}

export type FrameSink = (bitmap: ImageBitmap, metadata: FrameMetadata) => void

export type Want = {
  /** CSS pixels the surface will draw into. Chromium scales to fit. */
  width: number
  /** 1 is every frame. The panel uses 2 — 30 fps is plenty and it halves the
   *  JSON churn, which is the part that actually costs anything in WKWebView. */
  everyNthFrame?: number
}

type Entry = {
  sessionId: string
  subs: Map<symbol, Want & { onFrame: FrameSink }>
  running: { width: number; everyNthFrame: number } | null
  /** Decode is async, and frames arrive faster than a slow frame decodes. Only
   *  the newest one is worth drawing, so a frame that lands mid-decode replaces
   *  whatever was waiting rather than queueing behind it. */
  decoding: boolean
  queued: string | null
  queuedMeta: FrameMetadata | null
}

/** Below this the picture is a thumbnail and nobody is reading text in it. */
const MINIATURE_WIDTH = 480

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}

export type ScreencastHub = {
  /** Attach to a target, pin its viewport, and keep the session. */
  session: (targetId: string) => Promise<string>
  subscribe: (targetId: string, want: Want, onFrame: FrameSink) => () => void
  dispose: () => void
}

export function createScreencastHub(
  conn: CdpConnection,
  viewport: { width: number; height: number }
): ScreencastHub {
  const entries = new Map<string, Entry>()
  const opening = new Map<string, Promise<string>>()
  /** Frames arrive by session, sixty times a second per tab. Scanning `entries`
   *  for each one would allocate an array per frame for no reason. */
  const bySession = new Map<string, Entry>()

  const draw = async (entry: Entry, data: string, metadata: FrameMetadata): Promise<void> => {
    entry.decoding = true
    try {
      const bitmap = await createImageBitmap(base64ToBlob(data))
      for (const sub of entry.subs.values()) sub.onFrame(bitmap, metadata)
      // Every sink draws from the same bitmap, so it can only be closed once
      // they have all had it.
      bitmap.close()
    } catch {
      // A truncated or superseded frame is not worth a log line sixty times a
      // second; the next one will be along.
    } finally {
      entry.decoding = false
      const next = entry.queued
      const nextMeta = entry.queuedMeta
      entry.queued = null
      entry.queuedMeta = null
      if (next && nextMeta) void draw(entry, next, nextMeta)
    }
  }

  const offFrame = conn.on('Page.screencastFrame', (params, sessionId) => {
    if (!sessionId) return
    const entry = bySession.get(sessionId)
    if (!entry) return

    // Ack first, always. Chromium sends a frame and then waits for this; miss
    // one and the stream stalls for good.
    void conn
      .send('Page.screencastFrameAck', { sessionId: params.sessionId as number }, sessionId)
      .catch(() => {})

    const data = params.data as string
    const metadata = params.metadata as FrameMetadata
    if (entry.decoding) {
      entry.queued = data
      entry.queuedMeta = metadata
      return
    }
    void draw(entry, data, metadata)
  })

  const reconcile = async (targetId: string): Promise<void> => {
    const entry = entries.get(targetId)
    if (!entry) return

    if (entry.subs.size === 0) {
      if (entry.running) {
        entry.running = null
        await conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
      }
      return
    }

    const width = Math.max(...[...entry.subs.values()].map((s) => s.width))
    const everyNthFrame = Math.min(
      ...[...entry.subs.values()].map((s) => s.everyNthFrame ?? 1)
    )
    if (entry.running?.width === width && entry.running.everyNthFrame === everyNthFrame) return

    entry.running = { width, everyNthFrame }
    const height = Math.round((width / viewport.width) * viewport.height)
    // Restarting is the only way to change the size; Chromium has no "resize
    // the screencast" call.
    await conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
    await conn
      .send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: width <= MINIATURE_WIDTH ? 40 : 60,
          maxWidth: width,
          maxHeight: height,
          everyNthFrame
        },
        entry.sessionId
      )
      .catch(() => {})
  }

  const session = (targetId: string): Promise<string> => {
    const existing = entries.get(targetId)
    if (existing) return Promise.resolve(existing.sessionId)
    const inFlight = opening.get(targetId)
    if (inFlight) return inFlight

    const promise = (async () => {
      const sessionId = await conn.attach(targetId)
      await conn.send('Page.enable', {}, sessionId).catch(() => {})
      // Pin the viewport. Codex sizes its browser to the panel, so pages there
      // render at tablet breakpoints and the agent checks a layout nobody will
      // see; this keeps the page at a desktop size and lets the canvas scale it.
      await conn
        .send(
          'Emulation.setDeviceMetricsOverride',
          {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false
          },
          sessionId
        )
        .catch(() => {})
      const entry: Entry = {
        sessionId,
        subs: new Map(),
        running: null,
        decoding: false,
        queued: null,
        queuedMeta: null
      }
      entries.set(targetId, entry)
      bySession.set(sessionId, entry)
      opening.delete(targetId)
      return sessionId
    })()
    opening.set(targetId, promise)
    return promise
  }

  return {
    session,
    subscribe: (targetId, want, onFrame) => {
      const key = Symbol('screencast-subscriber')
      let cancelled = false
      void session(targetId).then(() => {
        if (cancelled) return
        entries.get(targetId)?.subs.set(key, { ...want, onFrame })
        void reconcile(targetId)
      })
      return () => {
        cancelled = true
        const entry = entries.get(targetId)
        if (!entry) return
        entry.subs.delete(key)
        void reconcile(targetId)
      }
    },
    dispose: () => {
      offFrame()
      for (const [targetId, entry] of entries) {
        void conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
        void conn.detach(entry.sessionId)
        entries.delete(targetId)
        bySession.delete(entry.sessionId)
      }
    }
  }
}
