import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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

beforeEach(() => {
  vi.useFakeTimers()
  sent = vi.fn()
  window.api.browser.tabSetViewport = sent as never
  forgetResponsiveViewport('s', 't')
})

afterEach(() => {
  vi.useRealTimers()
  forgetResponsiveViewport('s', 't')
})

describe('requestResponsiveViewport', () => {
  it('sends the first size straight away, so the page reflows while you drag', () => {
    requestResponsiveViewport('s', 't', 600, 800, null)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledWith('s', 't', { id: 'responsive', width: 600, height: 800 })
  })

  it('collapses a drag into a leading and a trailing call', () => {
    requestResponsiveViewport('s', 't', 600, 800, null)
    for (let w = 601; w < 700; w += 1) requestResponsiveViewport('s', 't', w, 800, null)
    // Everything after the first is still queued behind the throttle.
    expect(sent).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(150)
    expect(sent).toHaveBeenCalledTimes(2)
    // The size it was let go at, not one from the middle of the drag.
    expect(sent.mock.calls[1][2]).toEqual({ id: 'responsive', width: 696, height: 800 })
  })

  it('never sends a box that has not been laid out', () => {
    // Chromium reads a width of 0 as "clear the override", which snaps the page
    // back to the window size and silently breaks the click mapping.
    requestResponsiveViewport('s', 't', 0, 0, null)
    requestResponsiveViewport('s', 't', 120, 800, null)
    expect(sent).not.toHaveBeenCalled()
  })

  it('says nothing when the page is already at that size', () => {
    requestResponsiveViewport('s', 't', 600, 800, responsive(600, 800))
    expect(sent).not.toHaveBeenCalled()
  })

  it('re-sends the same numbers when coming back from a pinned device', () => {
    // The size may be byte-for-byte what was last sent and still has to go: the
    // page is on a phone, not on it.
    requestResponsiveViewport('s', 't', 600, 800, null)
    expect(sent).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)

    requestResponsiveViewport('s', 't', 600, 800, phone)
    expect(sent).toHaveBeenCalledTimes(2)
    expect(sent.mock.calls[1][2]).toEqual({ id: 'responsive', width: 600, height: 800 })
  })

  it('quantises, so a one-pixel wobble is not a round trip', () => {
    requestResponsiveViewport('s', 't', 600, 800, null)
    vi.advanceTimersByTime(150)
    const before = sent.mock.calls.length
    requestResponsiveViewport('s', 't', 602, 801, responsive(600, 800))
    vi.advanceTimersByTime(150)
    expect(sent.mock.calls.length).toBe(before)
  })
})
