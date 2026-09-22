import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Dialog, DialogPortal, DialogOverlay, DialogTitle } from './ui/dialog'
import { useLightboxStore } from '../store/lightbox'

/**
 * A thumbnail, seen properly.
 *
 * Every image in the app is sized for the row it sits in — an attachment chip, a
 * queued preview, something Claude rendered into a reply — which is fine for
 * knowing it is there and useless for looking at it. Clicking one brings it here.
 *
 * Built on the Dialog primitives rather than `Modal`, because `Modal` is a panel:
 * a popover background, padding and a ring, all of which would frame the image in
 * chrome it does not want. What is reused is the part worth reusing — the portal,
 * the focus trap, the backdrop, and focus returning to the thumbnail on close.
 *
 * The close button is deliberately over the backdrop at the top right of the
 * viewport rather than inside the image: an image is content, and a control
 * floating on top of content covers the thing you opened it to see.
 */
export default function ImageLightbox(): React.JSX.Element | null {
  const image = useLightboxStore((s) => s.image)
  const closeLightbox = useLightboxStore((s) => s.closeLightbox)

  /**
   * Escape closes the picture. It must not also stop the turn.
   *
   * `session.abort` holds bare Escape with `allowInInput`, on a bubble-phase
   * window listener — so without this, looking at a screenshot and pressing
   * Escape to put it away would kill whatever Claude was in the middle of. Same
   * shape as `PermissionDialog`: capture phase, `stopImmediatePropagation`, so
   * the key is spent here and goes no further. Radix would close the dialog on
   * its own, but it does not stop the event, which is the whole problem.
   *
   * Like that one, this assumes it is the topmost modal while open. A permission
   * prompt arriving over an open lightbox would be the case to revisit, and the
   * answer there is a modal stack rather than a second copy of this.
   */
  useEffect(() => {
    if (!image) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeLightbox()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [image, closeLightbox])

  if (!image) return null

  return (
    <Dialog open onOpenChange={(next) => !next && closeLightbox()}>
      <DialogPortal>
        <DialogOverlay className="bg-black/90" />
        <DialogPrimitive.Content
          // Escape is handled above, in the capture phase, so that it can be
          // stopped rather than merely acted on. Radix acting on it too would
          // close this twice.
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center p-12 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{image.name ?? 'Image preview'}</DialogTitle>

          {/* The backdrop is the dismiss target, so clicking beside the image
              closes it — the image itself stops the click from getting there. */}
          <button
            type="button"
            aria-label="Close image"
            onClick={closeLightbox}
            className="absolute inset-0 cursor-default"
          />

          <img
            src={image.src}
            alt={image.name ?? ''}
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-full max-w-full rounded-md object-contain shadow-panel"
          />

          {image.name && (
            <p className="relative mt-3 max-w-full truncate text-c-md text-white/70">
              {image.name}
            </p>
          )}

          {/* Over the backdrop, clear of the picture. z above the overlay so it
              stays clickable, and its own hit area rather than the image's. */}
          <button
            type="button"
            onClick={closeLightbox}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-md p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
          >
            <X className="size-5" />
          </button>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
