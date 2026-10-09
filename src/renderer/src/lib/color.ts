/**
 * Colour maths for themes.
 *
 * Themes are stored as `#rrggbb`, because that is what a person types and what
 * every other tool exports. Everything a theme derives — the muted text, the
 * hover fills, the text on the bubble — is worked out in OKLab, the space the
 * stylesheet's own tokens are written in: equal steps there look like equal
 * steps, which is what makes a derived ramp read as one family rather than a
 * pile of greys.
 *
 * Contrast is WCAG 2's, on sRGB luminance. It is the number people check
 * against, and the one `contrast.test.ts` is about.
 */

export type Rgb = { r: number; g: number; b: number }
export type Oklch = { l: number; c: number; h: number }
type Oklab = { L: number; a: number; b: number }

const HEX = /^#?([0-9a-f]{6})$/i
const SHORT_HEX = /^#?([0-9a-f]{3})$/i

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

/** `#abc`, `abc`, `#aabbcc` or `aabbcc` as `#aabbcc`, or null. */
export function normalizeHex(value: string): string | null {
  const trimmed = value.trim()
  const short = SHORT_HEX.exec(trimmed)
  if (short) {
    const [r, g, b] = short[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const long = HEX.exec(trimmed)
  return long ? `#${long[1].toLowerCase()}` : null
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

function rgbToOklab({ r, g, b }: Rgb): Oklab {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

/** Linear-light sRGB, unclamped: a value outside 0–1 means out of gamut. */
function oklabToLinear({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  }
}

function inGamut({ r, g, b }: Rgb): boolean {
  const e = 0.0005
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e
}

function labToLch({ L, a, b }: Oklab): Oklch {
  const c = Math.hypot(a, b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L, c, h }
}

function lchToLab({ l, c, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180
  return { L: l, a: c * Math.cos(rad), b: c * Math.sin(rad) }
}

export function hexToOklch(hex: string): Oklch {
  return labToLch(rgbToOklab(hexToRgb(hex)))
}

/**
 * An OKLCH colour as hex, pulled into sRGB by giving up chroma rather than by
 * clipping channels. Clipping shifts the hue — a saturated pink clipped per
 * channel drifts toward magenta — where reducing chroma keeps it the same pink,
 * only less loud. Several published themes, Cyberpunk's among them, sit outside
 * sRGB, so this is the path they take in.
 */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l))
  let lab = lchToLab({ ...color, l })
  let rgb = oklabToLinear(lab)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = color.c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklabToLinear(lchToLab({ l, c: mid, h: color.h })))) lo = mid
      else hi = mid
    }
    lab = lchToLab({ l, c: lo, h: color.h })
    rgb = oklabToLinear(lab)
  }
  return rgbToHex({ r: toGamma(Math.max(0, rgb.r)), g: toGamma(Math.max(0, rgb.g)), b: toGamma(Math.max(0, rgb.b)) })
}

/** `oklch(0.6726 0.2904 341.4084)` as hex. Null for anything else. */
export function parseOklch(css: string): string | null {
  const m = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)/i.exec(css)
  if (!m) return null
  const l = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1])
  return oklchToHex({ l, c: parseFloat(m[2]), h: parseFloat(m[3]) })
}

/**
 * A mix in OKLab, `t` of the way from `a` to `b`. The same operation as CSS's
 * `color-mix(in oklab, a, b t)`, so a value derived here matches one the
 * stylesheet derives the same way.
 */
export function mix(a: string, b: string, t: number): string {
  const x = rgbToOklab(hexToRgb(a))
  const y = rgbToOklab(hexToRgb(b))
  const lab = { L: x.L + (y.L - x.L) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t }
  const rgb = oklabToLinear(lab)
  return rgbToHex({ r: toGamma(Math.max(0, rgb.r)), g: toGamma(Math.max(0, rgb.g)), b: toGamma(Math.max(0, rgb.b)) })
}

export function lightness(hex: string): number {
  return rgbToOklab(hexToRgb(hex)).L
}

/** Whether text on this should be light. The bubble's polarity, in short. */
export function isDark(hex: string): boolean {
  return lightness(hex) < 0.6
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The colour, moved in lightness only until it reaches `min` against
 * `background`. Hue and chroma are kept, so "fix" never turns a brand orange
 * into a brown of a different hue — it makes it a lighter or darker orange.
 *
 * It moves away from the background: lighter on a dark page, darker on a light
 * one. Returns the original when it already passes, and the furthest it can get
 * when no lightness passes (a mid-grey background can rule some ratios out).
 */
export function ensureContrast(color: string, background: string, min: number): string {
  if (contrast(color, background) >= min) return color
  const lch = hexToOklch(color)
  const towardLight = isDark(background)
  let lo = lch.l
  let hi = towardLight ? 1 : 0
  if (contrast(oklchToHex({ ...lch, l: hi }), background) < min) return oklchToHex({ ...lch, l: hi })
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (contrast(oklchToHex({ ...lch, l: mid }), background) >= min) hi = mid
    else lo = mid
  }
  return oklchToHex({ ...lch, l: hi })
}

/** Whichever of the two candidates reads better on `background`. */
export function readableOn(background: string, a: string, b: string): string {
  return contrast(a, background) >= contrast(b, background) ? a : b
}

// ---------------------------------------------------------------- HSV, for the picker

export type Hsv = { h: number; s: number; v: number }

export function hexToHsv(hex: string): Hsv {
  const { r, g, b } = hexToRgb(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return rgbToHex({ r: r + m, g: g + m, b: b + m })
}
