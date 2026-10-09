import { describe, expect, it } from 'vitest'
import {
  contrast,
  ensureContrast,
  hexToHsv,
  hexToOklch,
  hsvToHex,
  lightness,
  mix,
  normalizeHex,
  oklchToHex,
  parseOklch
} from '@renderer/lib/color'
import {
  BUILT_IN_THEMES,
  MIN_CONTRAST,
  NYRA_DARK,
  NYRA_LIGHT,
  autoValue,
  builtInTheme,
  copyName,
  flipTheme,
  nameTaken,
  parseTheme,
  resolveColors,
  serializeTheme,
  themeCss,
  themeIdFor,
  themeVars,
  type Theme
} from '@renderer/lib/themes'

const near = (a: number, b: number, eps = 0.006): boolean => Math.abs(a - b) <= eps

describe('colour maths', () => {
  it('round-trips hex through OKLCH', () => {
    for (const hex of ['#ffffff', '#000000', '#f08a4b', '#1a1614', '#7aa2f7']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    }
  })

  it('reads the stylesheet notation', () => {
    expect(parseOklch('oklch(1.0000 0 0)')).toBe('#ffffff')
    expect(parseOklch('oklch(50% 0 0)')).not.toBeNull()
    expect(parseOklch('rgb(0 0 0)')).toBeNull()
  })

  it('pulls an out-of-gamut colour in by chroma, keeping the hue', () => {
    // Cyberpunk's pink is outside sRGB.
    const hex = parseOklch('oklch(0.6726 0.2904 341.4084)') as string
    const back = hexToOklch(hex)
    expect(near(back.l, 0.6726, 0.02)).toBe(true)
    expect(Math.abs(back.h - 341.4)).toBeLessThan(3)
  })

  it('normalises the hex people type', () => {
    expect(normalizeHex('ABC')).toBe('#aabbcc')
    expect(normalizeHex(' #F08A4B ')).toBe('#f08a4b')
    expect(normalizeHex('#12345')).toBeNull()
  })

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('fixes contrast by lightness alone', () => {
    const fixed = ensureContrast('#6e625a', '#1a1614', MIN_CONTRAST)
    expect(contrast(fixed, '#1a1614')).toBeGreaterThanOrEqual(MIN_CONTRAST)
    expect(lightness(fixed)).toBeGreaterThan(lightness('#6e625a'))
    expect(Math.abs(hexToOklch(fixed).h - hexToOklch('#6e625a').h)).toBeLessThan(4)
    // Already passing is left alone.
    expect(ensureContrast('#ffffff', '#000000', MIN_CONTRAST)).toBe('#ffffff')
  })

  it('round-trips HSV for the picker', () => {
    for (const hex of ['#5a3322', '#f08a4b', '#0000ff', '#808080']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex)
    }
  })

  it('mixes in OKLab like color-mix does', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(near(lightness(mix('#000000', '#ffffff', 0.5)), 0.5, 0.01)).toBe(true)
  })
})

describe('deriving a theme', () => {
  // A copy of Nyra has no overrides, so this is what Customize produces. It has
  // to land on the stylesheet's own values or the copy visibly differs.
  it('rebuilds Nyra Dark from its four seeds', () => {
    const vars = themeVars(builtInTheme(NYRA_DARK) as Theme).root
    const L = (k: string): number => lightness(vars[k])
    expect(near(L('--popover'), 0.2686)).toBe(true)
    expect(near(L('--card'), 0.2134)).toBe(true)
    expect(near(L('--border'), 0.3407)).toBe(true)
    expect(near(L('--accent'), 0.3715)).toBe(true)
    expect(near(L('--input'), 0.4386)).toBe(true)
    expect(near(L('--muted-foreground'), 0.709)).toBe(true)
    expect(near(L('--bubble'), 0.305)).toBe(true)
  })

  it('rebuilds Nyra Light from its four seeds', () => {
    const vars = themeVars(builtInTheme(NYRA_LIGHT) as Theme).root
    const L = (k: string): number => lightness(vars[k])
    expect(near(L('--secondary'), 0.9702)).toBe(true)
    expect(near(L('--border'), 0.9219)).toBe(true)
    expect(near(L('--workspace-rail'), 0.95)).toBe(true)
    expect(near(L('--bubble'), 0.32)).toBe(true)
    expect(L('--bubble-foreground')).toBeGreaterThan(0.98)
  })

  it.each(BUILT_IN_THEMES.map((t) => [t.name, t] as const))('%s is readable', (_name, theme) => {
    const r = resolveColors(theme)
    const vars = themeVars(theme)
    expect(contrast(r.text, r.background)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    expect(contrast(r.accent, r.background)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    for (const surface of [r.background, r.sidebar, r.popover, r.composer, r.sidePanel]) {
      expect(contrast(vars.root['--muted-foreground'], surface)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
    for (const status of [r.success, r.warning, r.danger]) {
      expect(contrast(status, r.background)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
    expect(contrast(vars.root['--bubble-foreground'], r.bubble)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    // Inside the bubble, links and muted text are judged against the bubble.
    expect(contrast(vars.bubble['--info'], r.bubble)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    expect(contrast(vars.bubble['--muted-foreground'], r.bubble)).toBeGreaterThanOrEqual(MIN_CONTRAST)
  })

  it('ships Cyberpunk as a dark built-in in its own colours', () => {
    const cyber = builtInTheme('cyberpunk') as Theme
    expect(cyber.mode).toBe('dark')
    const accent = hexToOklch(cyber.colors.accent)
    expect(Math.abs(accent.h - 341.4)).toBeLessThan(4)
    expect(near(lightness(cyber.colors.background), 0.1649, 0.01)).toBe(true)
  })

  it('fills Auto from the core colours and reports it', () => {
    const theme: Theme = {
      id: 'ember',
      name: 'Ember',
      mode: 'dark',
      colors: { accent: '#f08a4b', background: '#1a1614', text: '#ede6df', chrome: '#221c19', sidePanel: '#1e1a17' }
    }
    const r = resolveColors(theme)
    expect(r.sidePanel).toBe('#1e1a17')
    expect(r.sidebar).toBe('#221c19')
    expect(autoValue(theme, 'sidePanel')).toBe('#221c19')
  })

  it('writes a stylesheet that outranks :root and .dark', () => {
    const css = themeCss(builtInTheme('nord') as Theme)
    expect(css).toMatch(/^html\.nyra-themed \{/)
    expect(css).toContain('html.nyra-themed.nyra-themed .nyra-on-bubble')
    expect(css).toContain('--side-panel:')
  })
})

describe('theme files', () => {
  const file = {
    nyraTheme: 1,
    id: 'ember',
    name: 'Ember',
    mode: 'dark',
    colors: { accent: '#F08A4B', background: '#1a1614', text: '#ede6df', chrome: '#221c19', bubble: 'red', bogus: '#ffffff' }
  }

  it('reads a theme, lowercasing colours and dropping what is not a colour', () => {
    const t = parseTheme(file) as Theme
    expect(t.colors.accent).toBe('#f08a4b')
    expect(t.colors.bubble).toBeUndefined()
    expect((t.colors as Record<string, string>).bogus).toBeUndefined()
  })

  it('rejects a theme without its core colours or with an unsafe id', () => {
    expect(parseTheme({ ...file, colors: { accent: '#ffffff' } })).toBeNull()
    expect(parseTheme({ ...file, id: '../evil' })).toBeNull()
    expect(parseTheme({ ...file, mode: 'sepia' })).toBeNull()
  })

  it('round-trips through serialize', () => {
    const t = parseTheme(file) as Theme
    expect(parseTheme(JSON.parse(serializeTheme(t)))).toMatchObject({ id: 'ember', name: 'Ember', mode: 'dark' })
  })

  it('makes unique, file-safe ids and names', () => {
    expect(themeIdFor('Rosé Pine', [])).toBe('rose-pine')
    expect(themeIdFor('Rosé Pine', ['rose-pine'])).toBe('rose-pine-2')
    expect(themeIdFor('!!!', [])).toBe('theme')
    expect(nameTaken(' nord ', BUILT_IN_THEMES)).toBe(true)
    expect(copyName('Nord', BUILT_IN_THEMES)).toBe('Nord copy')
  })
})

describe('the other mode', () => {
  it('makes a light version that reads, and flipping twice comes back', () => {
    const ember: Theme = {
      id: 'ember',
      name: 'Ember',
      mode: 'dark',
      colors: { accent: '#f08a4b', background: '#1a1614', text: '#ede6df', chrome: '#221c19' }
    }
    const light = flipTheme(ember, BUILT_IN_THEMES)
    expect(light.mode).toBe('light')
    expect(light.name).toBe('Ember Light')
    expect(light.basedOn).toBe('Ember')
    expect(lightness(light.colors.background)).toBeGreaterThan(0.9)
    expect(contrast(light.colors.accent, light.colors.background)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    const back = flipTheme(light, BUILT_IN_THEMES)
    expect(near(lightness(back.colors.background), lightness(ember.colors.background), 0.01)).toBe(true)
  })
})
