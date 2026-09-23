import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LAND_TIMEOUT_MS,
  forgetResponsiveViewport,
  requestResponsiveViewport
} from '@renderer/lib/browser/viewportController'
import type { TabDevice } from '@renderer/lib/api-types'

const responsive = (width: number, height: number): TabDevice => ({
  id: 'responsive',
  label: 'Responsive',
  width,
  height,
  deviceScaleFactor: 2,
  mobile: false,
  hasTouch: false,
  by: 'user'
})

const phone: TabDevice = {
  id: 'iphone-16-pro',
  label: 'iPhone 16 Pro',
  width: 402,
  height: 874,
  deviceScaleFactor: 3,
  mobile: true,
  hasTouch: true,
  by: 'agent'
}

let sent: ReturnType<typeof vi.fn>
/** Settles the size currently waiting to land — the stand-in for a frame at
 *  that size reaching the canvas. */
let land: () => void

vi.mock('@renderer/store/browser', () => ({
  targetResized: () => new Promise<void>((resolve) => (land = resolve))
}))

/** Let the IPC reply and the landing promise run. */
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = vi.fn(async () => ({ ok: true }))
  land = () => {}
  window.api.browser.tabSetViewport = sent as never
  forgetResponsiveViewport('s', 't')
})

afterEach(() => {
  vi.useRealTimers()
  forgetResponsiveViewport('s', 't')
})

describe('requestResponsiveViewport', () => {
  it('sends the first size straight away, so the page reflows while you drag', () => {
    requestResponsiveViewport('s', 't', 'T', 600, 800, null)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledWith('s', 't', { id: 'responsive', width: 600, height: 800 })
  })

  it('holds the next size until the last one is on screen, and sends only the newest', async () => {
    // Measured: a second resize inside the ~33 ms before the first reaches the
    // stream throws that frame away, so sending on a clock showed 3 of 59.
    requestResponsiveViewport('s', 't', 'T', 600, 800, null)
    for (let w = 601; w < 700; w += 1) requestResponsiveViewport('s', 't', 'T', w, 800, null)
    await tick()
    expect(sent).toHaveBeenCalledTimes(1)

    land()
    await tick()
    expect(sent).toHaveBeenCalledTimes(2)
    // The newest size, not one from the middle of the drag.
    expect(sent.mock.calls[1][2]).toEqual({ id: 'responsive', width: 699, height: 800 })
  })

  it('stops waiting for a size that never shows, so a drag cannot freeze', async () => {
    requestResponsiveViewport('s', 't', 'T', 600, 800, null)
    requestResponsiveViewport('s', 't', 'T', 640, 800, null)
    await tick()
    expect(sent).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(LAND_TIMEOUT_MS)
    expect(sent).toHaveBeenCalledTimes(2)
    expect(sent.mock.calls[1][2]).toEqual({ id: 'responsive', width: 640, height: 800 })
  })

  it('never sends a box that has not been laid out', () => {
    // Chromium reads a width of 0 as "clear the override", which snaps the page
    // back to the window size and silently breaks the click mapping.
    requestResponsiveViewport('s', 't', 'T', 0, 0, null)
    requestResponsiveViewport('s', 't', 'T', 120, 800, null)
    expect(sent).not.toHaveBeenCalled()
  })

  it('says nothing when the page is already at that size', () => {
    requestResponsiveViewport('s', 't', 'T', 600, 800, responsive(600, 800))
    expect(sent).not.toHaveBeenCalled()
  })

  it('trusts what it sent over a broadcast that has not caught up', async () => {
    // Dragged 600 -> 700 -> back to 600 while the broadcast still says 600: the
    // page is at 700, so 600 has to go.
    requestResponsiveViewport('s', 't', 'T', 600, 800, null)
    await tick()
    land()
    await tick()
    requestResponsiveViewport('s', 't', 'T', 700, 800, responsive(600, 800))
    await tick()
    land()
    await tick()
    requestResponsiveViewport('s', 't', 'T', 600, 800, responsive(600, 800))
    expect(sent).toHaveBeenCalledTimes(3)
    expect(sent.mock.calls[2][2]).toEqual({ id: 'responsive', width: 600, height: 800 })
  })

  it('re-sends the same numbers when coming back from a pinned device', async () => {
    // The size may be byte-for-byte what was last sent and still has to go: the
    // page is on a phone, not on it.
    requestResponsiveViewport('s', 't', 'T', 600, 800, null)
    await tick()
    land()
    await tick()
    expect(sent).toHaveBeenCalledTimes(1)

    requestResponsiveViewport('s', 't', 'T', 600, 800, phone)
    expect(sent).toHaveBeenCalledTimes(2)
    expect(sent.mock.calls[1][2]).toEqual({ id: 'responsive', width: 600, height: 800 })
  })

  it('ignores a sub-pixel wobble', async () => {
    requestResponsiveViewport('s', 't', 'T', 600.2, 800.7, null)
    await tick()
    land()
    await tick()
    requestResponsiveViewport('s', 't', 'T', 600.9, 800.1, responsive(600, 800))
    await tick()
    expect(sent).toHaveBeenCalledTimes(1)
  })
})
