/**
 * Responsive mode's write side.
 *
 * In responsive mode the page's viewport *is* the panel box, so every frame of
 * a panel drag is a request to relayout the page. Surfaces measure on each of
 * those frames and call this; this is what makes that safe.
 *
 * Leading edge so the page visibly reflows while the handle is moving, trailing
 * so the size it was let go at always lands. Quantised so a one-pixel wobble is
 * not a round trip, and floored so a box that has not been laid out yet is
 * never sent at all.
 */
import { MIN_RESPONSIVE_DIMENSION, QUANTISE_STEP } from './viewport'
import type { TabDevice } from '../api-types'

const THROTTLE_MS = 100

type Pending = { sessionId: string; tabId: string; width: number; height: number }

const queued = new Map<string, Pending>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const sent = new Map<string, string>()

const keyOf = (sessionId: string, tabId: string): string => `${sessionId}::${tabId}`
const quantise = (n: number): number => Math.round(n / QUANTISE_STEP) * QUANTISE_STEP

function flush(key: string): void {
  const next = queued.get(key)
  if (!next) return
  queued.delete(key)
  const signature = `${next.width}x${next.height}`
  if (sent.get(key) === signature) return
  sent.set(key, signature)
  void window.api.browser.tabSetViewport(next.sessionId, next.tabId, {
    id: 'responsive',
    width: next.width,
    height: next.height
  })
}

export function requestResponsiveViewport(
  sessionId: string,
  tabId: string,
  width: number,
  height: number,
  current: TabDevice | null
): void {
  const key = keyOf(sessionId, tabId)

  // Coming back from a pinned device: the size may be byte-for-byte what was
  // last sent, and it still has to be re-sent, because the page is not at it.
  if (current && current.id !== 'responsive') sent.delete(key)

  const w = quantise(width)
  const h = quantise(height)

  // A collapsed or not-yet-laid-out box. Skipping is not merely tidy: Chromium
  // reads a width of 0 as "clear the override", so the page would silently snap
  // back to the window size and every click would land somewhere else, with no
  // error anywhere to explain it.
  if (w < MIN_RESPONSIVE_DIMENSION || h < MIN_RESPONSIVE_DIMENSION) return

  // Already there, and the broadcast has confirmed it.
  if (current?.id === 'responsive' && current.width === w && current.height === h) return

  queued.set(key, { sessionId, tabId, width: w, height: h })
  if (timers.has(key)) return

  flush(key)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      flush(key)
    }, THROTTLE_MS)
  )
}

/** A tab went away. Without this the caches keep a row per tab ever opened. */
export function forgetResponsiveViewport(sessionId: string, tabId: string): void {
  const key = keyOf(sessionId, tabId)
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
  queued.delete(key)
  sent.delete(key)
}
