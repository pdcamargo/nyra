import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResolvedArtboard, Theme } from '@nyra/design'
import { bitmapNow, requestBitmap, type Bitmap } from '../../lib/designThumbs'

/**
 * An artboard as a bitmap, at its full size on the canvas.
 *
 * What the canvas shows while a zoom is moving and when boards are too small
 * to read: a texture that scales for free, where a live artboard repaints at
 * every step. `fallback` stands in until the bitmap has been made.
 */
export default function BoardBitmap({
  artboard,
  theme,
  className,
  fallback = null
}: {
  artboard: ResolvedArtboard
  theme: Theme
  className?: string
  fallback?: React.ReactNode
}): React.ReactNode {
  const [made, setMade] = useState<Bitmap | null>(() => bitmapNow(artboard, theme))
  useEffect(() => {
    const ready = bitmapNow(artboard, theme)
    setMade(ready)
    if (ready) return
    return requestBitmap(artboard, theme, setMade)
  }, [artboard, theme])

  const canvas = useRef<HTMLCanvasElement | null>(null)
  useLayoutEffect(() => {
    const node = canvas.current
    if (!node || !made) return
    node.width = made.bitmap.width
    node.height = made.bitmap.height
    node.getContext('2d')?.drawImage(made.bitmap, 0, 0)
  }, [made])

  if (!made) return fallback
  return (
    <canvas
      ref={canvas}
      data-artboard-bitmap=""
      className={className}
      style={{ display: 'block', width: made.width, height: made.height }}
    />
  )
}
