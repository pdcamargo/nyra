/**
 * Chat background images: loading them, the dither effect, and which look
 * applies in which mode.
 *
 * The image comes back from `~/.nyra/backgrounds/` as base64 and is kept as a
 * blob URL rather than a data URL, so a 10 MB photo is one blob the `<img>`
 * points at instead of a 13 MB string in the DOM. In memory only.
 */
import { useEffect, useState } from 'react'
import type { BackgroundEffect, BackgroundLook, ChatBackground } from '../../../shared/types'

/** On-screen size of one dither cell, in CSS px, at the window's full width. */
const DITHER_CELL = 3
/** Brightness levels after dithering. Four is the coarsest that keeps a photo
 *  recognisable at a glance. */
const DITHER_LEVELS = 4

// prettier-ignore
const BAYER_8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21
]

/**
 * Ordered (8×8 Bayer) dithering of brightness, in place.
 *
 * Each pixel's luminance is snapped to one of `levels` steps, the threshold
 * shifted per cell by the Bayer matrix, and the colour scaled to match — so the
 * hue survives and only the brightness turns into a pattern.
 */
export function ditherPixels(data: Uint8ClampedArray, width: number, height: number, levels = DITHER_LEVELS): void {
  const steps = levels - 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const threshold = (BAYER_8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 - 0.5
      const q = Math.min(steps, Math.max(0, Math.round(lum * steps + threshold))) / steps
      if (lum < 0.004) {
        data[i] = data[i + 1] = data[i + 2] = q * 255
      } else {
        const scale = q / lum
        data[i] = r * scale
        data[i + 1] = g * scale
        data[i + 2] = b * scale
      }
    }
  }
}

/** A GIF is drawn from its first frame onto a canvas, so dithering would stop it. */
export function canDither(name: string): boolean {
  return !name.toLowerCase().endsWith('.gif')
}

/** The look for a mode, with the image (and its focus) dark borrows from light. */
export function resolveLook(
  bg: ChatBackground,
  mode: 'light' | 'dark'
): { look: BackgroundLook; image: string; focusX: number; focusY: number; effect: BackgroundEffect } | null {
  const look = bg[mode]
  const owner = look.image ? look : mode === 'dark' ? bg.light : null
  if (!owner?.image) return null
  return {
    look,
    image: owner.image,
    focusX: owner.focusX,
    focusY: owner.focusY,
    effect: canDither(owner.image) ? look.effect : 'none'
  }
}

const urls = new Map<string, Promise<string | null>>()
const resolved = new Map<string, string | null>()

function decode(base64: string, mediaType: string): Blob {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}

async function dither(source: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(source)
  const longest = Math.max(window.screen.width, window.screen.height)
  const scale = Math.min(1, longest / DITHER_CELL / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, width, height)
  ditherPixels(pixels.data, width, height)
  ctx.putImageData(pixels, 0, 0)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

function keyOf(name: string, effect: BackgroundEffect): string {
  return `${name}:${effect}`
}

function load(name: string, effect: BackgroundEffect): Promise<string | null> {
  const key = keyOf(name, effect)
  let pending = urls.get(key)
  if (pending) return pending
  pending = (async () => {
    try {
      const res = await window.api.backgrounds.read(name)
      if (!res.base64 || !res.mediaType) return null
      let blob: Blob | null = decode(res.base64, res.mediaType)
      if (effect === 'dither') blob = await dither(blob)
      return blob ? URL.createObjectURL(blob) : null
    } catch {
      return null
    }
  })()
  pending.then((url) => resolved.set(key, url))
  urls.set(key, pending)
  return pending
}

/** Drop a deleted image's URLs, so a later file with the same name is read afresh. */
export function forgetBackground(name: string): void {
  for (const effect of ['none', 'dither'] as const) {
    const key = keyOf(name, effect)
    const url = resolved.get(key)
    if (url) URL.revokeObjectURL(url)
    resolved.delete(key)
    urls.delete(key)
  }
}

/** A blob URL for the image with its effect applied, or null until it is ready. */
export function useBackgroundUrl(name: string | null, effect: BackgroundEffect): string | null {
  const key = name ? keyOf(name, effect) : null
  const [state, setState] = useState<{ key: string | null; url: string | null }>(() => ({
    key,
    url: key ? (resolved.get(key) ?? null) : null
  }))

  useEffect(() => {
    if (!name || !key) return
    let live = true
    void load(name, effect).then((url) => {
      if (live) setState({ key, url })
    })
    return () => {
      live = false
    }
  }, [name, effect, key])

  if (!key) return null
  return state.key === key ? state.url : (resolved.get(key) ?? null)
}
