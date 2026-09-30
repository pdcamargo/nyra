import { useCallback, useState } from 'react'
import type { ResolvedArtboard, Theme } from '@nyra/design'
import Artboard from './Artboard'

/** What an `auto` artboard is drawn at until it has laid out once. */
const ASSUMED_HEIGHT = 720

/**
 * One artboard shrunk to fit a box, never enlarged.
 *
 * The live artboard under a CSS scale rather than a raster: the export
 * preview, its thumbnails and the chat miniature all follow the file as it
 * changes, and a shadow root re-renders in a frame where a raster would wait on
 * Chromium. The outer box takes the scaled size so layout around it is honest.
 */
export default function ScaledArtboard({
  artboard,
  theme,
  maxWidth,
  maxHeight,
  className
}: {
  artboard: ResolvedArtboard
  theme: Theme
  maxWidth: number
  maxHeight: number
  className?: string
}): React.ReactElement {
  const [measured, setMeasured] = useState<number | null>(null)
  const onMeasure = useCallback((_: string, height: number) => setMeasured(height), [])

  const width = artboard.size.width
  const height =
    artboard.size.height === 'auto' ? (measured ?? ASSUMED_HEIGHT) : artboard.size.height
  const scale = Math.min(1, maxWidth / width, maxHeight / height)

  return (
    <div
      className={className}
      style={{ width: width * scale, height: height * scale, overflow: 'hidden', flexShrink: 0 }}
    >
      <div
        className="pointer-events-none origin-top-left bg-background"
        style={{ width, transform: `scale(${scale})` }}
      >
        <Artboard artboard={artboard} theme={theme} onMeasure={onMeasure} />
      </div>
    </div>
  )
}
