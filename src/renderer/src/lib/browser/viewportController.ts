/**
 * Responsive mode's write side.
 *
 * In responsive mode the page's viewport *is* the panel box, so every frame of
 * a panel drag is a request to relayout the page. Surfaces measure on each of
 * those frames and call this; this is what makes that safe.
 *
 * Paced by frames, not by a clock. One size is in flight at a time, and the
 * next goes when the last one is on screen — newest wins, everything between is
 * dropped. That is not caution: measured against headless Chromium, a resize
 * takes about 33 ms to reach the stream, and a second resize inside that window
 * throws the first frame away. Resizing every 16 ms showed 3 sizes out of 59;
 * pacing on arrival shows every one it sends, as fast as the page can lay out.
 *
 * Whole pixels, and floored so a box that has not been laid out yet is never
 * sent at all.
 */
import { MIN_RESPONSIVE_DIMENSION } from './viewport'
import { targetResized } from '../../store/browser'
import type { TabDevice } from '../api-types'

/**
 * How long to wait for a size to show before sending the next anyway.
 *
 * A page mid-navigation, or one that has hung, may never produce a frame at
 * all, and a drag must not freeze behind it.
 */
export const LAND_TIMEOUT_MS = 250

type Pending = { sessionId: string; tabId: string; targetId: string; width: number; height: number }

type Slot = {
  queued: Pending | null
  inFlight: boolean
  /** What was last sent. Compared against rather than the broadcast, which
   *  lags a drag by a round trip and would make "already there" a lie. */
  sent: string | null
}

const slots = new Map<string, Slot>()

const keyOf = (sessionId: string, tabId: string): string => `${sessionId}::${tabId}`

function slotFor(key: string): Slot {
  let slot = slots.get(key)
  if (!slot) {
    slot = { queued: null, inFlight: false, sent: null }
    slots.set(key, slot)
  }
  return slot
}

const timeout = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function flush(key: string, slot: Slot): Promise<void> {
  const next = slot.queued
  if (slot.inFlight || !next) return
  slot.queued = null
  const signature = `${next.width}x${next.height}`
  if (slot.sent === signature) return
  slot.sent = signature
  slot.inFlight = true
  try {
    await window.api.browser.tabSetViewport(next.sessionId, next.tabId, {
      id: 'responsive',
      width: next.width,
      height: next.height
    })
    await Promise.race([
      targetResized(next.targetId, { width: next.width, height: next.height }),
      timeout(LAND_TIMEOUT_MS)
    ])
  } catch {
    // The sidecar went away mid-drag. The next request tries again.
  } finally {
    slot.inFlight = false
  }
  // Forgotten while in flight: the tab is gone, so is whatever was queued.
  if (slots.get(key) === slot) void flush(key, slot)
}

export function requestResponsiveViewport(
  sessionId: string,
  tabId: string,
  targetId: string,
  width: number,
  height: number,
  current: TabDevice | null
): void {
  const key = keyOf(sessionId, tabId)
  const slot = slotFor(key)

  // Coming back from a pinned device: the size may be byte-for-byte what was
  // last sent, and it still has to be re-sent, because the page is not at it.
  if (current && current.id !== 'responsive') slot.sent = null

  const w = Math.floor(width)
  const h = Math.floor(height)

  // A collapsed or not-yet-laid-out box. Skipping is not merely tidy: Chromium
  // reads a width of 0 as "clear the override", so the page would silently snap
  // back to the window size and every click would land somewhere else, with no
  // error anywhere to explain it.
  if (w < MIN_RESPONSIVE_DIMENSION || h < MIN_RESPONSIVE_DIMENSION) return

  // Nothing sent yet from here, and the broadcast says the page is already at
  // this size — a remount, say. Once something has been sent, `sent` is the
  // truth and the broadcast is only an echo of it.
  if (slot.sent === null && current?.id === 'responsive' && current.width === w && current.height === h) {
    slot.sent = `${w}x${h}`
    return
  }

  slot.queued = { sessionId, tabId, targetId, width: w, height: h }
  void flush(key, slot)
}

/** A tab went away. Without this the map keeps a row per tab ever opened. */
export function forgetResponsiveViewport(sessionId: string, tabId: string): void {
  slots.delete(keyOf(sessionId, tabId))
}
