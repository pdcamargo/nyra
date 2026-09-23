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
  MAX_CAPTURE_WIDTH,
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
  /** Exactly what the running stream was started with, so a restart happens
   *  only when one of these would actually change. */
  running: { maxWidth: number; maxHeight: number; everyNthFrame: number; quality: number } | null
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
  /** Callers waiting for a frame at a size — see `resized`. */
  landing: Array<{ width: number; height: number; resolve: () => void }>
  /** Bumped per `resized`, so a screenshot of a size the page has since left
   *  is thrown away rather than drawn over the newer one. */
  resizeSeq: number
  /** The last size `resized` was told the page is at. Ahead of the store's,
   *  which waits for a broadcast. */
  resizedTo: { width: number; height: number } | null
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
 * How a resized page reaches the canvas when the stream will not carry it.
 *
 * Measured against headless Chromium: a page that is painting anyway has the
 * new size in its stream about 33 ms after the override, but a static page
 * sends *no* screencast frame for a resize at all — not for a relayout, and not
 * for anything else tried without touching its DOM (an overlay rect, a
 * background override, a requestAnimationFrame from an isolated world). A
 * screenshot is the only thing that shows it, at about 36 ms.
 *
 * At 1x and live quality, because it stands in for a stream frame; the idle
 * sharpen replaces it with the full raster once the drag stops.
 *
 * And unclipped, which is not a detail. A clipped screenshot emulates metrics
 * of its own for the capture and then *restores the ones it found* — so one
 * that is still in flight when the sidecar resizes the page puts the old size
 * back. Measured: switching to a 393-wide phone mid-shot left the page at 985.
 * An unclipped shot from this session comes back at exactly the CSS viewport,
 * 1x, which is what this wants anyway.
 */
const RESIZE_SHOT_QUALITY = 72

/** Metadata for a frame that did not come from the stream and has no live
 *  frame to borrow from. The emulated viewport is owned, so identity is right. */
const IDENTITY_META: FrameMetadata = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 0,
  deviceHeight: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0
}

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
  /**
   * The sidecar has just put the page at this CSS size. Gets it drawn — from
   * the stream if the page is painting, from a screenshot if it is not — and
   * resolves once a frame at that size has reached the surfaces.
   *
   * Resolves at once when nobody is drawing the target. It can also never
   * resolve, if the page never produces the size, so a caller that paces on it
   * needs its own timeout.
   */
  resized: (targetId: string, size: { width: number; height: number }) => Promise<void>
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
  /**
   * A still of the target at its full emulated resolution, from the sidecar.
   * Without it the idle sharpen is skipped, and the stream is what you get.
   */
  stillFor?: (targetId: string) => Promise<{ data: string; width: number; height: number } | null>
}

export function createScreencastHub(conn: CdpConnection, deps: HubDeps): ScreencastHub {
  const metricsFor = (targetId: string): EmulatedViewport =>
    deps.viewportFor(targetId) ?? deps.fallback
  const entries = new Map<string, Entry>()
  const opening = new Map<string, Promise<string>>()
  /** Frames arrive by session, sixty times a second per tab. Scanning `entries`
   *  for each one would allocate an array per frame for no reason. */
  const bySession = new Map<string, Entry>()

  /** Hand a frame to every surface, and to anybody waiting for its size. */
  const publish = (entry: Entry, bitmap: ImageBitmap, metadata: FrameMetadata): void => {
    for (const sub of entry.subs.values()) sub.onFrame(bitmap, metadata)
    // Every sink draws from the same bitmap, so it can only be closed once
    // they have all had it.
    bitmap.close()
    if (entry.landing.length === 0) return
    entry.landing = entry.landing.filter((wait) => {
      if (wait.width !== metadata.deviceWidth || wait.height !== metadata.deviceHeight) return true
      wait.resolve()
      return false
    })
  }

  /** Nobody is drawing any more, so nobody should be left waiting for a frame. */
  const releaseLanding = (entry: Entry): void => {
    for (const wait of entry.landing) wait.resolve()
    entry.landing = []
  }

  const draw = async (entry: Entry, data: string, metadata: FrameMetadata): Promise<void> => {
    entry.decoding = true
    try {
      publish(entry, await createImageBitmap(base64ToBlob(data)), metadata)
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
    const metadata = cssSized(entry, params.metadata as FrameMetadata)
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

  /**
   * Frame metadata with the page's size in CSS pixels, always.
   *
   * Usually it already is. But a frame composited just after a screenshot —
   * anybody's, even the sidecar's unclipped one — comes through at the device
   * pixel ratio, and its `deviceWidth` and `deviceHeight` report *that*: 2560 x
   * 1600 for a 1280 x 800 page at 2x, with nothing else in the metadata to tell
   * it apart. The canvas sizes itself from these numbers in responsive mode, so
   * passed through, the panel jumped to twice its size and back. Measured, not
   * guessed: two such frames per six screenshots.
   *
   * So a size that is exactly a size the page is known to be at, times the
   * pixel ratio, is read as that size.
   */
  const cssSized = (entry: Entry, meta: FrameMetadata): FrameMetadata => {
    const metrics = metricsFor(entry.targetId)
    const dsf = metrics.deviceScaleFactor
    if (!(dsf > 1)) return meta
    for (const known of [entry.resizedTo, metrics]) {
      if (!known) continue
      if (
        Math.round(known.width * dsf) === meta.deviceWidth &&
        Math.round(known.height * dsf) === meta.deviceHeight
      ) {
        return { ...meta, deviceWidth: known.width, deviceHeight: known.height }
      }
    }
    return meta
  }

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
    // page that has settled, nothing else will ever ask again. Likewise while a
    // resize is waiting to land: a still of the size being left would be drawn
    // over the one arriving.
    if (entry.sharpening || entry.landing.length > 0) {
      armSharpen(entry)
      return
    }

    const metrics = metricsFor(entry.targetId)
    // A thumbnail is not worth a quarter of a megabyte and fifty milliseconds —
    // but it still needs a first frame after a restart, like anything else.
    const preview = [...entry.subs.values()].every((s) => s.preview === true)
    if (!force && preview) return
    // Nothing sharper exists: the stream is already carrying the whole raster.
    // It never carries more than the CSS viewport, whatever it was asked for.
    const streamWidth = Math.min(entry.running.maxWidth, metrics.width)
    const sharper = Math.round(metrics.width * metrics.deviceScaleFactor) > streamWidth
    if (!force && (!sharper || !deps.stillFor)) return

    entry.sharpening = true
    const stamp = entry.frameSeq
    try {
      // Forced means "any frame, now", so it is this session's own unclipped
      // capture: 1x, quick, and free of side effects. The full raster comes from
      // the sidecar, whose session owns the metrics and so captures at the pixel
      // ratio unclipped. From here it would take a clip, and a clipped capture
      // restores the metrics it found when it finishes — measured dropping the
      // page's devicePixelRatio to 1 and reporting stream frames at twice their
      // CSS size, which made the panel's size jump about.
      const shot = force
        ? {
            ...(await conn.send<{ data: string }>(
              'Page.captureScreenshot',
              { format: 'jpeg', quality: RESIZE_SHOT_QUALITY },
              entry.sessionId
            )),
            width: metrics.width,
            height: metrics.height
          }
        : await deps.stillFor!(entry.targetId)
      // The page moved while the shot was being taken, so a live frame is newer
      // than this and drawing it would be a visible step backwards.
      if (!shot || entry.frameSeq !== stamp || entry.subs.size === 0) return
      const bitmap = await createImageBitmap(base64ToBlob(shot.data))
      if (entry.frameSeq !== stamp) {
        bitmap.close()
        return
      }
      // Sized as what was shot, not as the last live frame: after a resize the
      // two differ, and the canvas lays itself out from these numbers.
      publish(entry, bitmap, {
        ...(entry.lastMeta ?? IDENTITY_META),
        deviceWidth: shot.width || metrics.width,
        deviceHeight: shot.height || metrics.height
      })
      // A forced frame is only 1x; a page that now holds still earns the rest.
      if (force && !preview && sharper) armSharpen(entry)
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
      releaseLanding(entry)
      if (entry.running) {
        entry.running = null
        await conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
      }
      return
    }

    const metrics = metricsFor(targetId)
    const subs = [...entry.subs.values()]
    // A target shared by the panel and a miniature is the panel's to serve.
    const preview = subs.every((s) => s.preview === true)
    const quality = captureQuality(preview)
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

    // Somebody wants the whole CSS viewport, which is all a stream can ever
    // carry. Then the size to ask for is "no limit", not the viewport: a limit
    // tied to the viewport's size and aspect changes every time the page is
    // resized, and each change is a stop and a start. Responsive mode resizes
    // the page on every step of a panel drag, so that was a restart per step.
    // `ceiling === metrics.width` keeps the pixel budget: a viewport too big
    // for it still gets a downscaled stream below.
    const full = wanted >= metrics.width && ceiling === metrics.width
    let maxWidth: number
    let maxHeight: number
    if (full) {
      maxWidth = MAX_CAPTURE_WIDTH
      maxHeight = MAX_CAPTURE_WIDTH
    } else {
      const held = entry.running && entry.running.maxWidth <= ceiling ? entry.running.maxWidth : null
      maxWidth = Math.min(holdCapture(stepCapture(wanted, metrics), held), ceiling)
      maxHeight = captureHeight(maxWidth, metrics)
    }
    if (
      entry.running?.maxWidth === maxWidth &&
      entry.running.maxHeight === maxHeight &&
      entry.running.everyNthFrame === everyNthFrame &&
      entry.running.quality === quality
    ) {
      return
    }

    entry.running = { maxWidth, maxHeight, everyNthFrame, quality }
    // Restarting is the only way to change the size; Chromium has no "resize
    // the screencast" call.
    await conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
    await conn
      .send(
        'Page.startScreencast',
        { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame },
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
        sharpening: false,
        landing: [],
        resizeSeq: 0,
        resizedTo: null
      }
      entries.set(targetId, entry)
      bySession.set(sessionId, entry)
      opening.delete(targetId)
      return sessionId
    })()
    opening.set(targetId, promise)
    return promise
  }

  /** A 1x still at a size the page has just been put at. See `RESIZE_SHOT_QUALITY`. */
  const shootResize = async (entry: Entry, width: number, height: number): Promise<void> => {
    const seq = entry.resizeSeq
    try {
      const shot = await conn.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: RESIZE_SHOT_QUALITY },
        entry.sessionId
      )
      // Superseded by a newer size, or the stream already showed this one.
      const landed = !entry.landing.some((w) => w.width === width && w.height === height)
      if (entry.resizeSeq !== seq || landed || entry.subs.size === 0) return
      const bitmap = await createImageBitmap(base64ToBlob(shot.data))
      if (entry.resizeSeq !== seq) {
        bitmap.close()
        return
      }
      publish(entry, bitmap, {
        ...(entry.lastMeta ?? IDENTITY_META),
        deviceWidth: width,
        deviceHeight: height
      })
      // A static page sends no stream frame to arm this, and the still above
      // is only 1x.
      armSharpen(entry)
    } catch {
      // Mid-navigation, or the target went away. The caller's timeout covers it.
    }
  }

  return {
    session,
    invalidate: (targetId) => {
      void reconcile(targetId)
    },
    resized: (targetId, { width, height }) => {
      const entry = entries.get(targetId)
      if (!entry || entry.subs.size === 0) return Promise.resolve()
      entry.resizeSeq += 1
      entry.resizedTo = { width, height }
      // Anybody still waiting on an older size has been overtaken by this one.
      releaseLanding(entry)
      const landed = new Promise<void>((resolve) => {
        entry.landing.push({ width, height, resolve })
      })
      // Fired now rather than after waiting to see whether the stream shows it:
      // waiting costs a static page — most pages, most of the time — a whole
      // extra frame per step, and the loser is simply discarded.
      void shootResize(entry, width, height)
      return landed
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
        releaseLanding(entry)
        void conn.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {})
        void conn.detach(entry.sessionId)
        entries.delete(targetId)
        bySession.delete(entry.sessionId)
      }
    }
  }
}
