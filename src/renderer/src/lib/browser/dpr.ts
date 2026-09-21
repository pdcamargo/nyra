/**
 * Device pixels per CSS pixel, for one element.
 *
 * Deliberately not `window.devicePixelRatio`. Nyra has its own webview zoom
 * (`lib/zoom.ts`), and the platforms disagree about whether page zoom is folded
 * into that global — so it is the wrong number on at least one of them, and
 * guessing which is how a frame ends up soft in exactly one configuration.
 *
 * A `device-pixel-content-box` observation is measured rather than derived: it
 * reports the element's real backing-store size, display and zoom already in
 * it, and it fires again when either changes. Moving the window to a display
 * with a different pixel ratio changes that box even though the CSS box holds
 * still, which a `contentBoxSize` observer would sleep through.
 */
import { useEffect, useState, type RefObject } from 'react'

function globalRatio(): number {
  if (typeof window === 'undefined') return 1
  return window.devicePixelRatio || 1
}

/** Two decimals. Fractional layout wobbles the measured ratio by a thousandth
 *  between frames, and every distinct value would restart a screencast. */
function quantize(ratio: number): number {
  return Math.round(ratio * 100) / 100
}

export function useElementDpr(ref: RefObject<Element | null>): number {
  const [ratio, setRatio] = useState(() => quantize(globalRatio()))

  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const css = entry.contentBoxSize?.[0]?.inlineSize
        const device = entry.devicePixelContentBoxSize?.[0]?.inlineSize
        const measured = css && device ? device / css : globalRatio()
        const next = quantize(measured)
        if (next > 0) setRatio((prev) => (next === prev ? prev : next))
      }
    })

    try {
      observer.observe(element, { box: 'device-pixel-content-box' })
    } catch {
      // Without the box option there is nothing to measure, so the global is
      // the best answer available — and it is the right one whenever the
      // webview is at 100%, which is almost always.
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [ref])

  return ratio
}
