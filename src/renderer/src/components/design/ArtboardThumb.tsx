import { useEffect, useState } from 'react'
import type { ResolvedArtboard, Theme } from '@nyra/design'
import { requestThumbnail, thumbnailNow, type Thumbnail } from '../../lib/designThumbs'

/** What an `auto` artboard's placeholder assumes until its picture says. */
const ASSUMED_HEIGHT = 720

/**
 * One artboard shrunk to fit a box, as a cached picture rather than live DOM.
 *
 * For a size nobody reads — a strip of thumbnails — where `ScaledArtboard`
 * would lay out the whole artboard for a 36 px square. A picture not made yet
 * is a plain box of the same size, filled in when its turn in the queue comes.
 */
export default function ArtboardThumb({
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
  const [thumb, setThumb] = useState<Thumbnail | null>(() => thumbnailNow(artboard, theme, { maxWidth, maxHeight }))
  useEffect(() => {
    const box = { maxWidth, maxHeight }
    const ready = thumbnailNow(artboard, theme, box)
    setThumb(ready)
    if (ready) return
    return requestThumbnail(artboard, theme, box, setThumb)
  }, [artboard, theme, maxWidth, maxHeight])

  if (thumb) {
    // Drawn at exactly the size it was made for; see `designThumbs`.
    return (
      <img
        src={thumb.url}
        alt=""
        draggable={false}
        decoding="async"
        className={className}
        style={{ width: thumb.width, height: thumb.height, flexShrink: 0 }}
      />
    )
  }
  const width = artboard.size.width
  const height = artboard.size.height === 'auto' ? ASSUMED_HEIGHT : artboard.size.height
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return <span className={className} style={{ display: 'block', width: width * scale, height: height * scale, flexShrink: 0 }} />
}
