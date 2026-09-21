import { describe, expect, it } from 'vitest'
import {
  CAPTURE_STEP,
  captureCeiling,
  captureHeight,
  capturePx,
  captureQuality,
  fitScale,
  holdCapture,
  stepCapture
} from '../../renderer/src/lib/browser/viewport'

const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 }
const PHONE = { width: 402, height: 874, deviceScaleFactor: 3 }

describe('captureCeiling', () => {
  it('is the CSS viewport, not the raster behind it', () => {
    // The measured rule: a screencast never exceeds the page's CSS viewport,
    // however high deviceScaleFactor goes. Multiplying by dsf here would ask
    // for pixels that do not exist and make the pixel budget lie.
    expect(captureCeiling(DESKTOP)).toBe(1280)
    expect(captureCeiling({ ...DESKTOP, deviceScaleFactor: 3 })).toBe(1280)
  })

  it('lets the pixel budget bind before the width does on a tall viewport', () => {
    // 402 wide is far under MAX_CAPTURE_WIDTH, so the viewport is what binds.
    expect(captureCeiling(PHONE)).toBe(402)
    // A very tall, wide viewport is where the budget earns its keep.
    expect(captureCeiling({ width: 4000, height: 4000, deviceScaleFactor: 1 })).toBe(1414)
  })
})

describe('capturePx', () => {
  it('asks for device pixels, which is the whole fix', () => {
    // A 600 CSS px panel on a 2x display is 1200 real pixels. Asking for 600
    // and drawing onto that canvas is the upscale that made the panel soft.
    expect(capturePx(600, DESKTOP, 2)).toBe(1216)
    expect(capturePx(600, DESKTOP, 1)).toBe(640)
  })

  it('clamps to what Chromium can actually give', () => {
    expect(capturePx(1000, DESKTOP, 2)).toBe(1280)
    expect(capturePx(9000, DESKTOP, 3)).toBe(1280)
  })

  it('rounds up to a step, never down', () => {
    // Slightly more than the box needs is invisible; slightly less is soft.
    expect(capturePx(601, DESKTOP, 1) % CAPTURE_STEP).toBe(0)
    expect(capturePx(601, DESKTOP, 1)).toBeGreaterThanOrEqual(601)
  })

  it('never returns zero for a collapsed box', () => {
    expect(capturePx(0, DESKTOP, 2)).toBe(64)
  })
})

describe('holdCapture', () => {
  it('takes the first value it is given', () => {
    expect(holdCapture(640, null)).toBe(640)
  })

  it('keeps a slightly oversized stream rather than restarting it', () => {
    // Restarting is a stop plus a start, so a drag that nudges the box by a few
    // pixels must not cost one.
    expect(holdCapture(1216, 1280)).toBe(1280)
  })

  it('gives the pixels back once it is two full steps too big', () => {
    expect(holdCapture(1280 - CAPTURE_STEP * 2, 1280)).toBe(1280 - CAPTURE_STEP * 2)
  })

  it('grows immediately, because growing is what fixes softness', () => {
    expect(holdCapture(1280, 640)).toBe(1280)
  })
})

describe('holdCapture against the ceiling', () => {
  it('must not carry an oversized width across a shrink', () => {
    // The bug this covers: switching from a wide page to an iPhone kept the
    // hysteresis width, which is above what a 402px page can ever produce. The
    // hub then recorded a size the stream was never running at, so the next
    // change compared against a lie and skipped the restart — the wrapper
    // resized and the picture did not.
    const phone = { width: 402, height: 874, deviceScaleFactor: 3 }
    const ceiling = captureCeiling(phone)
    const held = holdCapture(stepCapture(402, phone), 480)
    expect(Math.min(held, ceiling)).toBe(402)
  })
})

describe('captureHeight', () => {
  it('preserves the page aspect and never rounds down', () => {
    expect(captureHeight(1280, DESKTOP)).toBe(800)
    expect(captureHeight(640, DESKTOP)).toBe(400)
    // Rounding down here would make height the binding constraint and silently
    // narrow the frame.
    expect(captureHeight(100, PHONE)).toBe(218)
  })
})

describe('captureQuality', () => {
  it('asks what the surface is instead of guessing from its width', () => {
    // The regression this replaces: quality keyed off a 480px threshold, which
    // was fine while the panel always rendered a 1280-wide page and so always
    // asked for more than that. Responsive mode made the panel ask for its own
    // width, and any panel narrower than 480 quietly dropped to thumbnail
    // quality — a soft picture with no setting to explain it.
    expect(captureQuality(true)).toBe(40)
    expect(captureQuality(false)).toBe(72)
  })
})

describe('fitScale', () => {
  it('shrinks a device that does not fit, on whichever axis binds', () => {
    expect(fitScale({ width: 300, height: 5000 }, PHONE)).toBeCloseTo(300 / 402)
    expect(fitScale({ width: 5000, height: 500 }, PHONE)).toBeCloseTo(500 / 874)
  })

  it('never magnifies', () => {
    // A 402-wide phone blown up 3x on a wide panel looks broken. "Fit" means
    // make it fit, not fill the space.
    expect(fitScale({ width: 4000, height: 4000 }, PHONE)).toBe(1)
  })

  it('survives a box that has not been laid out yet', () => {
    expect(fitScale({ width: 0, height: 0 }, PHONE)).toBe(1)
  })
})

describe('stepCapture', () => {
  it('is the rule both the surfaces and the hub reduce through', () => {
    expect(stepCapture(1200, DESKTOP)).toBe(capturePx(600, DESKTOP, 2))
  })
})
