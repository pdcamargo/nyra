import React, { useEffect, useRef, useState } from 'react'
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

          {/* Keyed on the image, so opening another one starts at fit. */}
          <PanZoomImage key={image.src} src={image.src} alt={image.name ?? ''} onClose={closeLightbox} />

          {image.name && (
            <p className="relative mt-3 max-w-full truncate text-c-md text-white/70">
              {image.name}
            </p>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

type View = { scale: number; x: number; y: number }
const FIT: View = { scale: 1, x: 0, y: 0 }
const MAX_SCALE = 8
// Per pixel of wheel travel. A pinch arrives as a ctrl+wheel in small deltas, a
// mouse wheel in large ones, so the two need very different gains to feel alike.
const WHEEL_GAIN = 0.0015
const PINCH_GAIN = 0.01

/**
 * Never smaller than fit — there is nothing to see out there — and panned no
 * further than lines an edge of the image up with an edge of the box it fits in,
 * so it cannot be dragged off the screen and lost.
 */
function settle(view: View, width: number, height: number): View {
  const scale = Math.min(MAX_SCALE, view.scale)
  if (scale <= 1) return FIT
  const mx = ((scale - 1) * width) / 2
  const my = ((scale - 1) * height) / 2
  return { scale, x: Math.min(mx, Math.max(-mx, view.x)), y: Math.min(my, Math.max(-my, view.y)) }
}

/**
 * The picture, zoomable and pannable.
 *
 * Here and not inline in the transcript: in a scrolling chat the wheel has to
 * scroll, and the lightbox is the one place nothing else wants it. What needed
 * this was a diagram — a big flowchart fits its row by shrinking until it cannot
 * be read — but every picture gets it, screenshots included.
 */
function PanZoomImage({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): React.JSX.Element {
  const [view, setView] = useState(FIT)
  // Eased for a jump — double-click, a key, reset — and not while the wheel or a
  // drag is moving it, where any easing reads as lag.
  const [eased, setEased] = useState(false)
  const [dragging, setDragging] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  // Ahead of the render, not behind it: wheel events land several to a frame,
  // and each has to build on the last one's zoom, not on what was painted.
  const viewRef = useRef(view)
  const drag = useRef<{ id: number; x: number; y: number; from: View } | null>(null)

  const show = (next: View): void => {
    viewRef.current = next
    setView(next)
  }

  /** Zoom to `scale`, keeping the point at (`px`, `py`) on screen where it is. Centre by default. */
  const zoomTo = (scale: number, px?: number, py?: number): void => {
    const img = imgRef.current
    if (!img) return
    const v = viewRef.current
    const target = Math.max(1, Math.min(MAX_SCALE, scale))
    // Where the centre is now: its laid-out spot, which transforms do not move,
    // plus the pan. Measuring the transformed box instead would read whatever
    // was last painted, a wheel event or two behind.
    const parent = (img.offsetParent ?? document.body).getBoundingClientRect()
    const cx = parent.left + img.offsetLeft + img.offsetWidth / 2 + v.x
    const cy = parent.top + img.offsetTop + img.offsetHeight / 2 + v.y
    // The image scales about its centre, so a point `d` from that centre moves
    // to `d * target / scale`; shifting by the difference holds it still.
    const k = 1 - target / v.scale
    const dx = (px ?? cx) - cx
    const dy = (py ?? cy) - cy
    show(settle({ scale: target, x: v.x + dx * k, y: v.y + dy * k }, img.offsetWidth, img.offsetHeight))
  }

  // On the window, and not passive: the wheel has to be claimed over the
  // backdrop as well as the picture, and a passive listener cannot stop the
  // pinch from zooming the whole webview instead.
  useEffect(() => {
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const lines = e.deltaMode === 1 ? 16 : 1
      const gain = e.ctrlKey ? PINCH_GAIN : WHEEL_GAIN
      setEased(false)
      zoomTo(viewRef.current.scale * Math.exp(-e.deltaY * lines * gain), e.clientX, e.clientY)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const step = e.key === '+' || e.key === '=' ? 1.5 : e.key === '-' ? 1 / 1.5 : e.key === '0' ? 0 : null
      if (step === null) return
      e.preventDefault()
      setEased(true)
      if (step === 0) show(FIT)
      else zoomTo(viewRef.current.scale * step)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const zoomed = view.scale > 1

  return (
    <>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        // The backdrop behind is the dismiss target; a click or a drag that
        // lands on the picture must not reach it.
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          setEased(true)
          if (zoomed) show(FIT)
          else zoomTo(2, e.clientX, e.clientY)
        }}
        onPointerDown={(e) => {
          if (!zoomed || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: viewRef.current }
          setEased(false)
          setDragging(true)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          const img = e.currentTarget
          show(settle({ ...d.from, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }, img.offsetWidth, img.offsetHeight))
        }}
        onPointerUp={() => {
          drag.current = null
          setDragging(false)
        }}
        onPointerCancel={() => {
          drag.current = null
          setDragging(false)
        }}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        className={`relative max-h-full max-w-full rounded-md object-contain shadow-panel touch-none select-none ${
          eased ? 'transition-transform duration-150 ease-out' : ''
        } ${zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'}`}
      />

      {/* Over the backdrop, clear of the picture. z above the overlay so they
          stay clickable, and their own hit areas rather than the image's. */}
      <div className="absolute right-4 top-4 flex items-center gap-1">
        {zoomed && (
          <button
            type="button"
            onClick={() => {
              setEased(true)
              show(FIT)
            }}
            aria-label="Reset zoom"
            title="Reset zoom (0)"
            className="rounded-md px-2 py-1.5 font-mono text-c-sm tabular-nums text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
          >
            {Math.round(view.scale * 100)}%
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
        >
          <X className="size-5" />
        </button>
      </div>
    </>
  )
}
