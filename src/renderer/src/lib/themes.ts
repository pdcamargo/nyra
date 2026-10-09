import type React from 'react'
import {
  contrast,
  ensureContrast,
  hexToOklch,
  isDark,
  isHex,
  mix,
  oklchToHex,
  parseOklch,
  readableOn
} from './color'

/**
 * Themes: what a person can change, and everything Nyra works out from it.
 *
 * A theme is one mode, light or dark, never a pair. Plenty of palettes only
 * exist in one (Tokyo Night has no light), and deriving the other mode by
 * formula gets the part that matters wrong — the stylesheet's own accent is
 * hand-tuned per mode, 0.52 lightness on white and 0.70 on black. Appearance
 * holds one theme per mode instead, and "Make a light version" is a one-off
 * copy, not a live link.
 *
 * Fifteen colours are editable, four of them required. Everything else is
 * derived, and some of it is derived *only*: muted text, hover fills,
 * separators and text drawn on a fill are where AGENTS.md's contrast rules get
 * broken, so nobody gets to set them by hand. They are computed to clear AA
 * against the surfaces they sit on.
 *
 * Nyra Light and Nyra Dark are the stylesheet itself: applying one removes
 * every override, so the shipped look is exactly what `index.css` says rather
 * than this file's reconstruction of it. The reconstruction only matters when
 * someone customises one, and the step constants below are tuned so a copy
 * comes out within a hair of the original.
 */

export type ThemeMode = 'light' | 'dark'

export const CORE_KEYS = ['accent', 'background', 'text', 'chrome'] as const
export const OPTIONAL_KEYS = [
  'rail',
  'sidebar',
  'sidePanel',
  'popover',
  'border',
  'bubble',
  'composer',
  'code',
  'success',
  'warning',
  'danger'
] as const

export type CoreKey = (typeof CORE_KEYS)[number]
export type OptionalKey = (typeof OPTIONAL_KEYS)[number]
export type ColorKey = CoreKey | OptionalKey

export type ThemeColors = Record<CoreKey, string> & Partial<Record<OptionalKey, string>>

export type Theme = {
  id: string
  name: string
  mode: ThemeMode
  colors: ThemeColors
  /** The theme this one started as a copy of, by name. Shown, never followed. */
  basedOn?: string
  builtIn?: boolean
  /** ms since epoch, written on save. */
  updatedAt?: number
}

export type TokenGroup = 'core' | 'surfaces' | 'conversation' | 'status'

/** What the editor lists, in order, in the words it lists them with. */
export const TOKENS: { key: ColorKey; group: TokenGroup; label: string; where: string }[] = [
  { key: 'accent', group: 'core', label: 'Accent', where: 'Links, toggles, focus, the send button' },
  { key: 'background', group: 'core', label: 'Background', where: 'The conversation' },
  { key: 'text', group: 'core', label: 'Text', where: 'Everything you read; muted text derives from it' },
  { key: 'chrome', group: 'core', label: 'Chrome', where: 'The base the rails and panels are cut from' },
  { key: 'rail', group: 'surfaces', label: 'Workspace rail', where: 'The strip of workspaces at the far left' },
  { key: 'sidebar', group: 'surfaces', label: 'Sidebar', where: 'Chats, projects and the title bar' },
  { key: 'sidePanel', group: 'surfaces', label: 'Side panel', where: 'Changes, files and the browser' },
  { key: 'popover', group: 'surfaces', label: 'Menus and popovers', where: 'Dropdowns, dialogs, the command palette' },
  { key: 'border', group: 'surfaces', label: 'Borders', where: 'Edges and dividers' },
  { key: 'bubble', group: 'conversation', label: 'Your messages', where: 'The bubble; its text is picked for you' },
  { key: 'composer', group: 'conversation', label: 'Composer', where: 'Where you type' },
  { key: 'code', group: 'conversation', label: 'Code blocks', where: 'Fenced code in the conversation' },
  { key: 'success', group: 'status', label: 'Success', where: 'Added lines, passing checks' },
  { key: 'warning', group: 'status', label: 'Warning', where: 'Things that need a look' },
  { key: 'danger', group: 'status', label: 'Danger', where: 'Removed lines, errors, delete' }
]

export const GROUPS: { id: TokenGroup; title: string }[] = [
  { id: 'core', title: 'Core' },
  { id: 'surfaces', title: 'Surfaces' },
  { id: 'conversation', title: 'Conversation' },
  { id: 'status', title: 'Status' }
]

export function isCoreKey(key: ColorKey): key is CoreKey {
  return (CORE_KEYS as readonly string[]).includes(key)
}

/** Text has to reach this on what it sits on. AA for body text. */
export const MIN_CONTRAST = 4.5

// ---------------------------------------------------------------- derivation

/**
 * How far from the background toward the text each derived surface sits, per
 * mode. Read off index.css: in dark mode the popover is 0.2686 on a 0.1448 page
 * with 0.9851 text, which is 0.147 of the way across, and so on down the list.
 * Mixing rather than adding lightness is what lets a tinted theme keep its tint
 * in the derived greys: a step from a blue-black toward a blue-white stays blue.
 */
const STEPS: Record<ThemeMode, Record<string, number>> = {
  dark: { card: 0.082, secondary: 0.147, hover: 0.27, border: 0.233, input: 0.35, muted: 0.672, popover: 0.147, rail: 0 },
  light: { card: 0, secondary: 0.035, hover: 0.035, border: 0.091, input: 0.091, muted: 0.5556, popover: 0, rail: 0.0585 }
}

/** The stylesheet's status colours, the starting point when a theme sets none. */
const STATUS: Record<ThemeMode, Record<'success' | 'warning' | 'danger', string>> = {
  light: {
    success: oklchToHex({ l: 0.52, c: 0.14, h: 150 }),
    warning: oklchToHex({ l: 0.62, c: 0.14, h: 75 }),
    danger: oklchToHex({ l: 0.583, c: 0.2387, h: 28.48 })
  },
  dark: {
    success: oklchToHex({ l: 0.72, c: 0.15, h: 150 }),
    warning: oklchToHex({ l: 0.78, c: 0.14, h: 75 }),
    danger: oklchToHex({ l: 0.7022, c: 0.1892, h: 22.23 })
  }
}

/** The fixed hues the themes leave alone, lifted to stay readable on a bubble. */
const FIXED_HUES = {
  design: oklchToHex({ l: 0.74, c: 0.16, h: 350 }),
  merged: oklchToHex({ l: 0.72, c: 0.15, h: 300 }),
  designAccent: oklchToHex({ l: 0.7081, c: 0.1591, h: 293 })
}

/** Every colour a theme resolves to, with the ones it does not set filled in. */
export function resolveColors(theme: Theme): Record<ColorKey, string> {
  const c = theme.colors
  const s = STEPS[theme.mode]
  const dark = theme.mode === 'dark'
  const bg = c.background
  const text = c.text
  const secondary = mix(bg, text, s.secondary)
  const sidebar = c.sidebar ?? c.chrome
  return {
    accent: c.accent,
    background: bg,
    text,
    chrome: c.chrome,
    rail: c.rail ?? (dark ? bg : mix(bg, text, s.rail)),
    sidebar,
    sidePanel: c.sidePanel ?? sidebar,
    popover: c.popover ?? mix(bg, text, s.popover),
    border: c.border ?? mix(bg, text, s.border),
    bubble: c.bubble ?? (dark ? mix(secondary, '#ffffff', 0.05) : mix(bg, text, 0.7956)),
    composer: c.composer ?? (dark ? secondary : bg),
    code: c.code ?? secondary,
    success: c.success ?? ensureContrast(STATUS[theme.mode].success, bg, MIN_CONTRAST),
    warning: c.warning ?? ensureContrast(STATUS[theme.mode].warning, bg, MIN_CONTRAST),
    danger: c.danger ?? ensureContrast(STATUS[theme.mode].danger, bg, MIN_CONTRAST)
  }
}

/** What an optional colour would be if it were left on Auto. */
export function autoValue(theme: Theme, key: OptionalKey): string {
  const rest = { ...theme.colors }
  delete rest[key]
  return resolveColors({ ...theme, colors: rest })[key]
}

/**
 * The text colour Nyra puts on a fill: whichever of the theme's two extremes
 * reads better, pushed further if even that falls short — Solarized's text is
 * soft enough that neither end clears AA on a mid-tone bubble.
 */
export function textOn(theme: Theme, fill: string): string {
  return ensureContrast(readableOn(fill, theme.colors.background, theme.colors.text), fill, MIN_CONTRAST)
}

/** The ratio a token is judged by, for the ones where readability is the point. */
export function tokenContrast(theme: Theme, key: ColorKey): number | null {
  const r = resolveColors(theme)
  switch (key) {
    case 'accent':
    case 'success':
    case 'warning':
    case 'danger':
      return contrast(r[key], r.background)
    case 'text':
      return contrast(r.text, r.background)
    case 'bubble':
      return contrast(textOn(theme, r.bubble), r.bubble)
    default:
      return null
  }
}

/** What a failing token would have to be to pass, keeping its hue. */
export function fixContrast(theme: Theme, key: ColorKey): string | null {
  const r = resolveColors(theme)
  switch (key) {
    case 'accent':
    case 'success':
    case 'warning':
    case 'danger':
    case 'text':
      return ensureContrast(r[key], r.background, MIN_CONTRAST)
    default:
      return null
  }
}

export type ThemeVars = { root: Record<string, string>; bubble: Record<string, string> }

/**
 * The CSS custom properties a theme sets, on the document and inside the bubble.
 *
 * The bubble gets its own block because it is an island: in Nyra Light it is a
 * near-black slab in a white app, and the links, chips and muted text rendered
 * into it would otherwise use the page's colours. Its palette is worked out
 * against the bubble's own fill, whichever way that fill points.
 */
export function themeVars(theme: Theme): ThemeVars {
  const r = resolveColors(theme)
  const s = STEPS[theme.mode]
  const dark = theme.mode === 'dark'
  const { background: bg, text, accent } = r
  const secondary = mix(bg, text, s.secondary)
  const hover = mix(bg, text, s.hover)

  let muted = mix(bg, text, s.muted)
  for (const surface of [bg, r.sidebar, r.popover, r.composer, r.sidePanel]) {
    muted = ensureContrast(muted, surface, MIN_CONTRAST)
  }

  const on = (fill: string): string => textOn(theme, fill)

  const root: Record<string, string> = {
    '--background': bg,
    '--foreground': text,
    '--card': mix(bg, text, s.card),
    '--card-foreground': text,
    '--popover': r.popover,
    '--popover-foreground': text,
    '--primary': accent,
    '--primary-foreground': on(accent),
    '--secondary': secondary,
    '--secondary-foreground': text,
    '--muted': secondary,
    '--muted-foreground': muted,
    '--accent': hover,
    '--accent-foreground': text,
    '--destructive': r.danger,
    '--destructive-foreground': on(r.danger),
    '--danger': r.danger,
    '--danger-foreground': on(r.danger),
    '--border': r.border,
    '--input': dark ? mix(bg, text, s.input) : r.border,
    '--ring': accent,
    '--sidebar': r.sidebar,
    '--sidebar-foreground': text,
    '--sidebar-primary': text,
    '--sidebar-primary-foreground': bg,
    '--sidebar-accent': hover,
    '--sidebar-accent-foreground': text,
    '--sidebar-border': r.border,
    '--sidebar-ring': accent,
    '--success': r.success,
    '--success-foreground': on(r.success),
    '--warning': r.warning,
    '--warning-foreground': on(r.warning),
    '--info': accent,
    '--info-foreground': on(accent),
    '--side-panel': r.sidePanel,
    '--composer': r.composer,
    '--code': r.code,
    '--bubble': r.bubble,
    '--bubble-foreground': on(r.bubble),
    '--workspace-rail': r.rail,
    '--workspace-tile': dark ? secondary : bg,
    '--workspace-tile-active': dark ? hover : bg
  }
  // Dark mode's rail hover is a mix of --accent in the stylesheet, so it follows
  // on its own. Light mode's is a literal, and has to be restated.
  if (!dark) root['--rail-hover'] = mix(r.sidebar, text, 0.03)

  const fill = r.bubble
  const fg = on(fill)
  const lift = (color: string): string => ensureContrast(color, fill, MIN_CONTRAST)
  const designAccent = lift(FIXED_HUES.designAccent)
  const bubble: Record<string, string> = {
    '--foreground': fg,
    '--muted-foreground': lift(mix(fill, fg, 0.7)),
    '--border': mix(fill, fg, 0.22),
    '--accent': mix(fill, fg, 0.12),
    '--accent-foreground': fg,
    '--secondary': mix(fill, fg, 0.08),
    '--secondary-foreground': fg,
    '--success': lift(r.success),
    '--warning': lift(r.warning),
    '--info': lift(accent),
    '--design': lift(FIXED_HUES.design),
    '--merged': lift(FIXED_HUES.merged),
    '--design-accent': designAccent,
    '--design-accent-foreground': readableOn(designAccent, fill, fg),
    '--destructive': lift(r.danger),
    '--danger': lift(r.danger),
    'color-scheme': isDark(fill) ? 'dark' : 'light'
  }
  return { root, bubble }
}

/**
 * The stylesheet a theme becomes.
 *
 * `html.nyra-themed` outranks both `:root` and `.dark`, so the overrides win
 * without !important and without touching the order the stylesheets load in.
 * The bubble selector doubles the class to beat `html:not(.dark) .nyra-on-bubble`,
 * which has the same weight as one class and would otherwise win on order.
 */
export function themeCss(theme: Theme): string {
  const { root, bubble } = themeVars(theme)
  const block = (vars: Record<string, string>): string =>
    Object.entries(vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n')
  return `html.nyra-themed {\n${block(root)}\n}\nhtml.nyra-themed.nyra-themed .nyra-on-bubble {\n${block(bubble)}\n}\n`
}

/** Whether applying this theme means "the stylesheet as shipped". */
export function isStylesheetTheme(theme: Theme): boolean {
  return theme.id === NYRA_LIGHT || theme.id === NYRA_DARK
}

// ---------------------------------------------------------------- built in

export const NYRA_LIGHT = 'nyra-light'
export const NYRA_DARK = 'nyra-dark'

const ok = (css: string): string => parseOklch(css) ?? '#000000'

function builtIn(id: string, name: string, mode: ThemeMode, colors: ThemeColors): Theme {
  // Status colours and the accent are lifted to AA against their page here,
  // once, so a palette ported from elsewhere arrives readable.
  const fixed: ThemeColors = { ...colors }
  for (const key of ['accent', 'success', 'warning', 'danger'] as const) {
    const value = fixed[key]
    if (value) fixed[key] = ensureContrast(value, colors.background, MIN_CONTRAST)
  }
  return { id, name, mode, colors: fixed, builtIn: true }
}

export const BUILT_IN_THEMES: Theme[] = [
  // What index.css says, as seeds. Applying either clears the overrides instead.
  {
    id: NYRA_LIGHT,
    name: 'Nyra Light',
    mode: 'light',
    builtIn: true,
    colors: {
      accent: ok('oklch(0.52 0.15 255)'),
      background: '#ffffff',
      text: ok('oklch(0.1448 0 0)'),
      chrome: ok('oklch(0.974 0 0)')
    }
  },
  {
    id: NYRA_DARK,
    name: 'Nyra Dark',
    mode: 'dark',
    builtIn: true,
    colors: {
      accent: ok('oklch(0.70 0.14 255)'),
      background: ok('oklch(0.1448 0 0)'),
      text: ok('oklch(0.9851 0 0)'),
      chrome: ok('oklch(0.2046 0 0)')
    }
  },
  // Lifted from the published Cyberpunk shadcn theme. Its sidebar is the page
  // colour, which leaves Nyra's rails with no edge, so chrome takes its --muted.
  // The bubble is its chart violet: the theme is loud on purpose.
  builtIn('cyberpunk', 'Cyberpunk', 'dark', {
    accent: ok('oklch(0.6726 0.2904 341.4084)'),
    background: ok('oklch(0.1649 0.0352 281.8285)'),
    text: ok('oklch(0.9513 0.0074 260.7315)'),
    chrome: ok('oklch(0.2123 0.0522 280.9917)'),
    popover: ok('oklch(0.2542 0.0611 281.1423)'),
    border: ok('oklch(0.3279 0.0832 280.7890)'),
    bubble: ok('oklch(0.5488 0.2944 299.0954)'),
    success: ok('oklch(0.8903 0.1739 171.2690)'),
    warning: ok('oklch(0.9168 0.1915 101.4070)'),
    danger: ok('oklch(0.6535 0.2348 34.0370)')
  }),
  builtIn('nord', 'Nord', 'dark', {
    accent: '#88c0d0',
    background: '#2e3440',
    text: '#eceff4',
    chrome: '#3b4252',
    popover: '#3b4252',
    border: '#434c5e',
    bubble: '#434c5e',
    success: '#a3be8c',
    warning: '#ebcb8b',
    danger: '#bf616a'
  }),
  builtIn('solarized-dark', 'Solarized Dark', 'dark', {
    accent: '#268bd2',
    background: '#002b36',
    text: '#93a1a1',
    chrome: '#073642',
    border: '#0e4552',
    success: '#859900',
    warning: '#b58900',
    danger: '#dc322f'
  }),
  builtIn('rose-pine', 'Rosé Pine', 'dark', {
    accent: '#ebbcba',
    background: '#191724',
    text: '#e0def4',
    chrome: '#1f1d2e',
    popover: '#26233a',
    border: '#403d52',
    bubble: '#26233a',
    success: '#9ccfd8',
    warning: '#f6c177',
    danger: '#eb6f92'
  }),
  builtIn('tokyo-night', 'Tokyo Night', 'dark', {
    accent: '#7aa2f7',
    background: '#1a1b26',
    text: '#c0caf5',
    chrome: '#16161e',
    rail: '#13131a',
    popover: '#1f2335',
    border: '#292e42',
    bubble: '#283457',
    success: '#9ece6a',
    warning: '#e0af68',
    danger: '#f7768e'
  }),
  builtIn('solarized-light', 'Solarized Light', 'light', {
    accent: '#268bd2',
    background: '#fdf6e3',
    text: '#475b62',
    chrome: '#eee8d5',
    border: '#e0d9c4',
    success: '#859900',
    warning: '#b58900',
    danger: '#dc322f'
  }),
  builtIn('rose-pine-dawn', 'Rosé Pine Dawn', 'light', {
    accent: '#d7827e',
    background: '#faf4ed',
    text: '#575279',
    chrome: '#f2e9e1',
    popover: '#fffaf3',
    border: '#dfdad9',
    bubble: '#575279',
    success: '#56949f',
    warning: '#ea9d34',
    danger: '#b4637a'
  })
]

export function builtInTheme(id: string): Theme | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id)
}

export const DEFAULT_THEME_ID: Record<ThemeMode, string> = { light: NYRA_LIGHT, dark: NYRA_DARK }

// ---------------------------------------------------------------- files

/** The version written into every theme file. A breaking change bumps it. */
export const THEME_FILE_VERSION = 1

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

/**
 * A theme read off disk or out of an imported file, or null.
 *
 * Lenient about what it does not know and strict about what it draws with: an
 * unknown key is dropped, an optional colour that is not a hex is treated as
 * Auto, and a missing or malformed core colour rejects the file — there is no
 * sensible page without a background.
 */
export function parseTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isThemeId(r.id)) return null
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  if (r.mode !== 'light' && r.mode !== 'dark') return null
  const src = r.colors as Record<string, unknown> | undefined
  if (!src || typeof src !== 'object') return null
  const colors: Partial<ThemeColors> = {}
  for (const key of CORE_KEYS) {
    const v = src[key]
    if (!isHex(v)) return null
    colors[key] = v.toLowerCase()
  }
  for (const key of OPTIONAL_KEYS) {
    const v = src[key]
    if (isHex(v)) colors[key] = v.toLowerCase()
  }
  return {
    id: r.id,
    name: r.name.trim().slice(0, 60),
    mode: r.mode,
    colors: colors as ThemeColors,
    ...(typeof r.basedOn === 'string' ? { basedOn: r.basedOn } : {}),
    ...(typeof r.updatedAt === 'number' ? { updatedAt: r.updatedAt } : {})
  }
}

/** What gets written: the theme, minus anything that only exists in memory. */
export function serializeTheme(theme: Theme): string {
  const file = {
    nyraTheme: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.name,
    mode: theme.mode,
    ...(theme.basedOn ? { basedOn: theme.basedOn } : {}),
    colors: theme.colors,
    updatedAt: Date.now()
  }
  return JSON.stringify(file, null, 2) + '\n'
}

/** A file-safe id for a name, unique among `taken`. */
export function themeIdFor(name: string, taken: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'theme'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const next = `${base}-${i}`
    if (!used.has(next)) return next
  }
}

/** Names are unique across built-in and yours, case and spacing aside. */
export function nameTaken(name: string, themes: Theme[], exceptId?: string): boolean {
  const n = name.trim().toLowerCase()
  return themes.some((t) => t.id !== exceptId && t.name.trim().toLowerCase() === n)
}

/** "Ember copy", "Ember copy 2", … */
export function copyName(name: string, themes: Theme[]): string {
  let candidate = `${name} copy`
  for (let i = 2; nameTaken(candidate, themes); i++) candidate = `${name} copy ${i}`
  return candidate
}

// ---------------------------------------------------------------- the other mode

const NEUTRAL_KEYS: ColorKey[] = ['background', 'text', 'chrome', 'rail', 'sidebar', 'sidePanel', 'popover', 'border', 'bubble', 'composer', 'code']

/**
 * The same theme for the other mode, as a starting point.
 *
 * Surfaces and text have their lightness reflected around the middle — 1.13
 * minus L, which takes Nyra's dark page (0.14) to just under white and back
 * again, so doing it twice returns where you started. Hue and chroma are kept,
 * so a warm theme stays warm. The accent and status colours keep their
 * lightness where they can and are pushed only as far as they have to go to
 * read on the new page.
 */
export function flipTheme(theme: Theme, themes: Theme[]): Theme {
  const mode: ThemeMode = theme.mode === 'dark' ? 'light' : 'dark'
  const colors: Partial<ThemeColors> = {}
  for (const key of NEUTRAL_KEYS) {
    const v = theme.colors[key as keyof ThemeColors]
    if (!v) continue
    const lch = hexToOklch(v)
    colors[key as keyof ThemeColors] = oklchToHex({ ...lch, l: Math.min(0.99, Math.max(0.1, 1.13 - lch.l)) })
  }
  const bg = colors.background as string
  for (const key of ['accent', 'success', 'warning', 'danger'] as const) {
    const v = theme.colors[key]
    if (v) colors[key] = ensureContrast(v, bg, MIN_CONTRAST)
  }
  const stem = theme.name.replace(/\s+(light|dark)$/i, '')
  let name = `${stem} ${mode === 'light' ? 'Light' : 'Dark'}`
  if (nameTaken(name, themes)) name = copyName(name, themes)
  return {
    id: themeIdFor(name, themes.map((t) => t.id)),
    name,
    mode,
    colors: colors as ThemeColors,
    basedOn: theme.name
  }
}

/** Eight steps of the accent's own hue, dark to light, for the picker. */
export function shadesOf(color: string): string[] {
  const { c, h } = hexToOklch(color)
  return [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.93].map((l) => oklchToHex({ l, c, h }))
}

/** Colours for a thumbnail or a strip, in one shape whatever the theme sets. */
export function previewColors(theme: Theme): Record<ColorKey, string> & { muted: string } {
  const r = resolveColors(theme)
  return { ...r, muted: themeVars(theme).root['--muted-foreground'] }
}

/**
 * The colours the theme editor itself is drawn in: Nyra's own, for the mode on
 * screen, whatever the draft says.
 *
 * Painted onto the editor's root (and its popovers) as inline custom
 * properties, so the draft repaints everything else while the tool you are
 * using to fix it stays readable. A theme with white text on white would
 * otherwise take its own Undo button with it.
 */
export function islandStyle(mode: ThemeMode): React.CSSProperties {
  const theme = BUILT_IN_THEMES.find((t) => t.id === DEFAULT_THEME_ID[mode]) as Theme
  return themeVars(theme).root as React.CSSProperties
}
