import { create } from 'zustand'

/** The image currently shown full-size, if any. */
export type LightboxImage = {
  /** A `data:` or `blob:` URL — the CSP allows no other scheme for an `img`. */
  src: string
  /** Shown under the image and used as the accessible name. */
  name?: string
}

type LightboxStore = {
  image: LightboxImage | null
  openLightbox: (image: LightboxImage) => void
  closeLightbox: () => void
}

/**
 * One lightbox for every thumbnail in the app.
 *
 * Images turn up in six places — the composer's attachment chips, the queued
 * message previews, a sent message, the edit box, and whatever Claude renders
 * into a reply — and each one is a thumbnail sized for its row. A store rather
 * than local state in each of them, because the thing being opened is a single
 * app-wide surface: two lightboxes stacked is never what anyone wanted, and this
 * makes that unrepresentable.
 */
export const useLightboxStore = create<LightboxStore>((set) => ({
  image: null,
  openLightbox: (image) => set({ image }),
  closeLightbox: () => set({ image: null })
}))

/** Open the lightbox on an image. Safe to pass a missing src — it no-ops. */
export function showImage(src: string | undefined, name?: string): void {
  if (!src) return
  useLightboxStore.getState().openLightbox({ src, name })
}
