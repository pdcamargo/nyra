import { describe, expect, it } from 'vitest'
import { canDither, ditherPixels, resolveLook } from '@renderer/lib/chatBackground'
import { DEFAULT_BACKGROUND_LOOK, type ChatBackground } from '@shared/types'

const bg = (light: string | null, dark: string | null): ChatBackground => ({
  scope: 'new',
  light: { ...DEFAULT_BACKGROUND_LOOK, image: light, focusX: 10, focusY: 20 },
  dark: { ...DEFAULT_BACKGROUND_LOOK, image: dark, brightness: 60 }
})

describe('resolveLook', () => {
  it('lets dark borrow the light image and its focus, but keeps its own adjustments', () => {
    const r = resolveLook(bg('aa.png', null), 'dark')
    expect(r?.image).toBe('aa.png')
    expect([r?.focusX, r?.focusY]).toEqual([10, 20])
    expect(r?.look.brightness).toBe(60)
  })

  it('never lends dark’s image to light', () => {
    expect(resolveLook(bg(null, 'bb.png'), 'light')).toBeNull()
  })

  it('drops the dither for a GIF, which would freeze on its first frame', () => {
    const b = bg('cc.gif', null)
    b.light.effect = 'dither'
    expect(resolveLook(b, 'light')?.effect).toBe('none')
    expect(canDither('cc.GIF')).toBe(false)
    expect(canDither('cc.webp')).toBe(true)
  })
})

describe('ditherPixels', () => {
  it('snaps every pixel to one of the levels while keeping its hue', () => {
    const w = 8
    const h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) data.set([200, 100, 50, 255], i * 4)
    ditherPixels(data, w, h, 4)
    const levels = new Set<number>()
    for (let i = 0; i < w * h; i++) {
      const [r, g, b, a] = data.slice(i * 4, i * 4 + 4)
      expect(a).toBe(255)
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      levels.add(Math.round(lum * 3))
      // Same ratio of channels: orange stays orange.
      if (g > 0) expect(r / g).toBeCloseTo(2, 0)
    }
    // A flat mid-tone dithers between two neighbouring levels.
    expect(levels.size).toBe(2)
  })
})
