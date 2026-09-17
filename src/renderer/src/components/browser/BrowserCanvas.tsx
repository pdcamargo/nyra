import React, { useEffect, useRef } from 'react'
import { browserHub, useBrowserStore } from '../../store/browser'

/**
 * One tab's pixels.
 *
 * The canvas takes its intrinsic size from the frame and its display size from
 * the container, so the page is rendered at the pinned viewport and scaled down
 * to whatever room there is. That is the whole reason the page never reflows to
 * a phone layout when the panel is narrow — and it is also what makes canvas
 * coordinates convert to page coordinates by a single scale factor.
 */
export default function BrowserCanvas({
  targetId,
  width,
  everyNthFrame = 2,
  className = ''
}: {
  targetId: string | null
  /** CSS pixels this surface will occupy. The hub streams at the largest width
   *  any surface asked for, so a miniature never downgrades the panel. */
  width: number
  everyNthFrame?: number
  className?: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cdpUrl = useBrowserStore((s) => s.cdpUrl)
  const viewport = useBrowserStore((s) => s.viewport)

  useEffect(() => {
    if (!cdpUrl || !targetId) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void browserHub(cdpUrl, viewport)
      .then(({ hub }) => {
        if (cancelled) return
        unsubscribe = hub.subscribe(targetId, { width, everyNthFrame }, (bitmap) => {
          const canvas = canvasRef.current
          if (!canvas) return
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        })
      })
      .catch(() => {
        // The panel already renders the connection failure from store state;
        // a rejected promise here would only be an unhandled one.
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [cdpUrl, targetId, width, everyNthFrame, viewport])

  return (
    <canvas
      ref={canvasRef}
      // Until the first frame lands the element has no intrinsic size, so the
      // aspect ratio keeps the box from collapsing and the layout from jumping.
      style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
      className={`block h-auto w-full bg-background ${className}`}
    />
  )
}
