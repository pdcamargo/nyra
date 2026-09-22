import React from 'react'
import { cn } from 'cn'
import { showImage } from '../store/lightbox'

/**
 * A thumbnail you can click to see properly.
 *
 * A bare `<img onClick>` would do the job for a mouse and leave it unreachable
 * from the keyboard and unannounced to a screen reader, so the button is the
 * element and the image is its content. `className` still lands on the `<img>` —
 * every call site already has the sizing it wants there — and the button takes
 * only what it needs to not disturb the layout it is being dropped into.
 */
export default function ZoomableImage({
  src,
  alt = '',
  name,
  title,
  className,
  wrapperClassName
}: {
  src: string
  alt?: string
  /** Shown under the image in the lightbox; falls back to `title`. */
  name?: string
  title?: string
  className?: string
  wrapperClassName?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={name ? `View ${name}` : 'View image'}
      onClick={(e) => {
        // Inside a chip or a row that has its own click, this is the more
        // specific intent: looking at the picture, not opening what holds it.
        e.stopPropagation()
        showImage(src, name ?? title)
      }}
      className={cn(
        'block cursor-zoom-in rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info',
        wrapperClassName
      )}
    >
      {/* `title` stays on the image, not the button: it is disclosure of a
          truncated path, which is the one job the native tooltip is still right
          for. The button's name is the action, and that is what `aria-label` is. */}
      <img src={src} alt={alt} title={title} className={className} />
    </button>
  )
}
