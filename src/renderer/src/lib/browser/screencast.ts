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
 * is the screen, not the wire. A sharpening still is not cheap by comparison
 * (~230 KB, ~50 ms), which is why it only happens once a page has stopped.
 *
 * Sizes are asked for in *device* pixels, not CSS ones. Chromium caps a
 * screencast at the page's CSS viewport and `maxWidth` only ever downscales, so
 * requesting the CSS width and then drawing onto a Retina canvas upscaled every
 * frame before anybody saw it. `lib/browser/viewport.ts` carries the
 * measurements and the arithmetic.
 */
import type { CdpConnection } from './cdp'
import {
  captureCeiling,
  captureHeight,
  captureQuality,
  holdCapture,
  stepCapture,
  type EmulatedViewport
} from './viewport'

/** What Chromium says about the frame it just sent. Because the emulated
 *  viewport is owned rather than observed, `pageScaleFactor` and `offsetTop`
 *  are the identity, which is the whole reason the coordinate mapping is a
 *  single scale factor instead of DevTools' four-term formula. The scroll
 *  offsets are not decoration: a sharpening screenshot clips in document
 *  coordinates and needs them. */
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
  /** CSS pixels the surface occupies. Decides how much detail is worth paying
   *  for — a thumbnail nobody is reading text in gets a cheaper JPEG. */
  width: number
  /** Backing-store pixels behind that same box. This, and not `width`, is what
   *  the frame is captured at. */
  devicePixels: number
  /** A miniature nobody reads text in. Gets a cheaper JPEG, and never triggers
   *  a sharpening screenshot. Declared rather than guessed from the width —
   *  guessing meant a narrow panel was mistaken for a thumbnail. */
  preview?: boolean
  /**
   * 1 is every frame, and the panel uses 1.
   *
   * It used to use 2, on the theory that 30 fps was plenty and halving the JSON
   * churn was the saving that mattered. Measured in the real window, that was
   * the wrong trade: at every frame the panel holds a steady 60 received and 60
   * drawn with nothing dropped, 1.5 ms of decode each and 0.23 MB/s — and the
   * difference in how the page feels under the hand is not subtle. The cap was
   * the limiter, not the pipeline. A miniature still uses 4; nobody is
   * interacting with that.
   */
  everyNthFrame?: number
}

type Entry = {
  sessionId: string
  targetId: string
  subs: Map<symbol, Want & { onFrame: FrameSink }>
  running: { px: number; everyNthFrame: number; vp: string } | null
  /** Decode is async, and frames arrive faster than a slow frame decodes. Only
   *  the newest one is worth drawing, so a frame that lands mid-decode replaces
   *  whatever was waiting rather than queueing behind it. */
  decoding: boolean
  queued: string | null
  queuedMeta: FrameMetadata | null
  /** Bumped per frame, so a still that was overtaken while being taken can be
   *  thrown away rather than drawn over something newer. */
  frameSeq: number
  lastMeta: FrameMetadata | null
  sharpenTimer: ReturnType<typeof setTimeout> | null
  sharpening: boolean
}

/**
 * How long a page has to hold still before a sharper still is worth taking.
 *
 * The screencast is capped at the page's CSS viewport, so in responsive mode —
 * where the viewport *is* the panel box — it can never fill a Retina canvas and
 * is permanently upscaled. `Page.captureScreenshot` has no such cap: it honours
 * `deviceScaleFactor` and comes back at exactly the canvas's device-pixel box.
 *
 * It costs ~50 ms and a couple of hundred KB, which is why it only happens when
 * nothing is moving — which is also precisely when someone is reading the page
 * and a soft frame is most obvious. A page that animates forever never sharpens,
 * and that is correct: nobody is reading it.
 */
const SHARPEN_IDLE_MS = 250

/**
 * Lossy on purpose, for now.
 *
 * At the same pixel count PNG is visibly cleaner on text — JPEG's chroma
 * subsampling leaves a coloured halo around links and highlighting, which is
 * most of why a 1:1 still still reads as slightly soft. Measured on a 480x800
 * at dsf 2: PNG 68 ms and 210 KB against 51 ms and 139 KB here. Worth revisiting
 * if the softness ever becomes the thing that bothers someone; it needs the
 * integration test's image shim to learn PNG at the same time.
 */
const SHARPEN_QUALITY = 80

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}

/**
 * A live subscription.
 *
 * `update` exists so that resizing a surface is not the same event as detaching
 * it. Unsubscribing takes the subscriber count to zero, which stops the stream;
 * re-subscribing starts it again. Doing that from a React effect whose deps
 * included the width meant a drag stopped and restarted the screencast on every
 * mousemove — which is only survivable while nothing reflows on resize, and
 * responsive mode reflows on resize.
 */
export type Subscription = {
  update: (want: Want) => void
  stop: () => void
}

export type ScreencastHub = {
  /** Attach to a target and keep the session. The size the page renders at is
   *  the sidecar's to set — see `HubDeps`. */
  session: (targetId: string) => Promise<string>
  subscribe: (targetId: string, want: Want, onFrame: FrameSink) => Subscription
  /** That target's emulated size changed, so the stream has to be restarted at
   *  the new aspect. Cheap when nothing actually moved. */
  invalidate: (targetId: string) => void
  dispose: () => void
}

export type HubDeps = {
  /**
   * The size a target is being rendered at, as last reported by the sidecar.
   *
   * A getter rather than a value because the hub is a process-lifetime
   * singleton: anything captured at construction is stale the first time
   * anybody resizes, which is exactly the bug `browserHub` used to have when it
   * returned a cached connection and quietly ignored the viewport passed with
   * it.
   */
  viewportFor: (targetId: string) => EmulatedViewport | undefined
  /** What to assume before the first `tabs` broadcast lands. */
  fallback: EmulatedViewport
}

export function createScreencastHub(conn: CdpConnection, deps: HubDeps): ScreencastHub {
  const metricsFor = (targetId: string): EmulatedViewport =>
    deps.viewportFor(targetId) ?? deps.fallback
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
    entry.frameSeq += 1
    entry.lastMeta = metadata
    armSharpen(entry)
    if (entry.decoding) {
      entry.queued = data
      entry.queuedMeta = metadata
      return
    }
    void draw(entry, data, metadata)
  })

  const cancelSharpen = (entry: Entry): void => {
    if (!entry.sharpenTimer) return
    clearTimeout(entry.sharpenTimer)
    entry.sharpenTimer = null
  }

  /** Re-armed by every frame, so it only ever fires after the last one. */
  const armSharpen = (entry: Entry): void => {
    cancelSharpen(entry)
    entry.sharpenTimer = setTimeout(() => {
      entry.sharpenTimer = null
      void sharpen(entry)
    }, SHARPEN_IDLE_MS)
  }

  /**
   * @param force draw one whatever the cost, because the alternative is worse.
   *
   * A screencast only produces frames when something repaints, so restarting it
   * at a new size leaves a settled page showing the *last* frame of the old one
   * — the wrapper resizes, the picture does not, and it reads as the page
   * having ignored the resize entirely. Forcing a frame is what closes that.
   */
  const sharpen = async (entry: Entry, force = false): Promise<void> => {
    if (entry.subs.size === 0 || !entry.running) return
    // One already going — usually the forced one from a restart, which the new
    // stream's first frame then overtakes. Come back rather than give up: on a
    // page that has settled, nothing else will ever ask again.
    if (entry.sharpening) {
      armSharpen(entry)
      return
    }

    const metrics = metricsFor(entry.targetId)
    // A thumbnail is not worth a quarter of a megabyte and fifty milliseconds —
    // but it still needs a first frame after a resize, like anything else.
    if (!force && [...entry.subs.values()].every((s) => s.preview === true)) return
    // Nothing sharper exists: the stream is already carrying the whole raster.
    if (!force && Math.round(metrics.width * metrics.deviceScaleFactor) <= entry.running.px) return

    entry.sharpening = true
    const stamp = entry.frameSeq
    try {
      // `clip.scale`, not the session's emulation. Emulation overrides are per
      // CDP session and the one that matters belongs to the sidecar, so a plain
      // screenshot from this session comes back at 1x and is no sharper than
      // the stream it was meant to improve. The clip's origin is in document
      // coordinates, which is exactly what the screencast metadata's scroll
      // offset is for.
      const shot = await conn.send<{ data: string }>(
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: SHARPEN_QUALITY,
          clip: {
            x: entry.lastMeta?.scrollOffsetX ?? 0,
            y: entry.lastMeta?.scrollOffsetY ?? 0,
            width: metrics.width,
            height: metrics.height,
            scale: metrics.deviceScaleFactor
          }
        },
        entry.sessionId
      )
      // The page moved while the shot was being taken, so a live frame is newer
      // than this and drawing it would be a visible step backwards.
      if (entry.frameSeq !== stamp || entry.subs.size === 0) return
      const bitmap = await createImageBitmap(base64ToBlob(shot.data))
      if (entry.frameSeq !== stamp) {
        bitmap.close()
        return
      }
      for (const sub of entry.subs.values()) {
        if (entry.lastMeta) sub.onFrame(bitmap, entry.lastMeta)
      }
      bitmap.close()
    } catch {
      // A screenshot of a page mid-navigation is not worth a log line.
    } finally {
      entry.sharpening = false
      // Overtaken by a live frame, so the page was still moving. Try again once
      // it stops — every incoming frame resets this timer, so an animating page
      // simply never reaches it.
      if (entry.frameSeq !== stamp) armSharpen(entry)
    }
  }

  const reconcile = async (targetId: string): Promise<void> => {
    const entry = entries.get(targetId)
    if (!entry) return

    if (entry.subs.size === 0) {
      cancelSharpen(entry)
      if (entry.running) {
        entry.running = null
        await conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
      }
      return
    }

    const metrics = metricsFor(targetId)
    const vp = `${metrics.width}x${metrics.height}`
    const subs = [...entry.subs.values()]
    // A target shared by the panel and a miniature is the panel's to serve.
    const preview = subs.every((s) => s.preview === true)
    const everyNthFrame = Math.min(...subs.map((s) => s.everyNthFrame ?? 1))
    // The largest box anybody draws into, counted in the pixels that box really
    // has, then held against the running size so dragging the panel does not
    // restart the stream once per mousemove.
    // The ceiling binds last as well as first. `holdCapture` deliberately keeps
    // an oversized stream rather than restart for a few pixels, and without
    // this that hysteresis carries a width across a device change that the new
    // page cannot produce — recording a size the stream was never running at.
    const ceiling = captureCeiling(metrics)
    const wanted = Math.min(Math.max(...subs.map((s) => s.devicePixels)), ceiling)
    const px = Math.min(holdCapture(stepCapture(wanted, metrics), entry.running?.px ?? null), ceiling)
    if (
      entry.running?.px === px &&
      entry.running.everyNthFrame === everyNthFrame &&
      entry.running.vp === vp
    ) {
      return
    }

    entry.running = { px, everyNthFrame, vp }
    // Restarting is the only way to change the size; Chromium has no "resize
    // the screencast" call.
    await conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
    await conn
      .send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: captureQuality(preview),
          maxWidth: px,
          maxHeight: captureHeight(px, metrics),
          everyNthFrame
        },
        entry.sessionId
      )
      .catch(() => {})

    // Chromium does not repaint a page that has already settled, so without
    // this the new stream stays silent and the canvas keeps showing the old
    // size's last frame.
    cancelSharpen(entry)
    void sharpen(entry, true)
  }

  const session = (targetId: string): Promise<string> => {
    const existing = entries.get(targetId)
    if (existing) return Promise.resolve(existing.sessionId)
    const inFlight = opening.get(targetId)
    if (inFlight) return inFlight

    const promise = (async () => {
      const sessionId = await conn.attach(targetId)
      await conn.send('Page.enable', {}, sessionId).catch(() => {})
      // No device metrics here, deliberately. The sidecar owns the emulated
      // size: it is the only side that is always present, so a size set while
      // this panel is closed still reaches the page, and it is the only side
      // that can set `deviceScaleFactor` at all — Playwright reads that from
      // context options and re-sends it from its own session on every
      // cross-process navigation, so anything written here would be reverted by
      // the first cross-origin click.
      const entry: Entry = {
        sessionId,
        targetId,
        subs: new Map(),
        running: null,
        decoding: false,
        queued: null,
        queuedMeta: null,
        frameSeq: 0,
        lastMeta: null,
        sharpenTimer: null,
        sharpening: false
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
    invalidate: (targetId) => {
      void reconcile(targetId)
    },
    subscribe: (targetId, want, onFrame) => {
      const key = Symbol('screencast-subscriber')
      let cancelled = false
      // The attach is async, so a resize can arrive before there is anything to
      // resize. Holding the latest want here means it is simply what gets
      // registered when the session lands.
      let latest = want
      void session(targetId).then(() => {
        if (cancelled) return
        entries.get(targetId)?.subs.set(key, { ...latest, onFrame })
        void reconcile(targetId)
      })
      return {
        update: (next) => {
          latest = next
          const entry = entries.get(targetId)
          const existing = entry?.subs.get(key)
          if (!entry || !existing) return
          entry.subs.set(key, { ...next, onFrame: existing.onFrame })
          // Usually a no-op: `holdCapture` keeps the running size unless the
          // step really moved, so most of a drag costs one map write.
          void reconcile(targetId)
        },
        stop: () => {
          cancelled = true
          const entry = entries.get(targetId)
          if (!entry) return
          entry.subs.delete(key)
          void reconcile(targetId)
        }
      }
    },
    dispose: () => {
      offFrame()
      for (const [targetId, entry] of entries) {
        cancelSharpen(entry)
        void conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
        void conn.detach(entry.sessionId)
        entries.delete(targetId)
        bySession.delete(entry.sessionId)
      }
    }
  }
}
