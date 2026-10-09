import { DEFAULT_SETTINGS, type ThemePreference } from '../../../shared/types'
import { builtInTheme, isStylesheetTheme, parseTheme, themeCss, type Theme, type ThemeMode } from './themes'

export type ResolvedTheme = 'dark' | 'light'

/** The zustand persist key for the settings store. Renaming it drops user data. */
const SETTINGS_KEY = 'nyra-settings'

export function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

/**
 * The single place the theme reaches the DOM. shadcn's convention is a `.dark`
 * class on <html>; the app used a `data-theme` attribute before the move to a
 * shadcn theme, which is light-by-default with a `.dark` override.
 */
export function applyThemeClass(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

/**
 * Read the persisted preference without pulling in the store.
 *
 * main.tsx needs the theme on the document before React renders: `:root` now
 * holds the *light* palette, so a dark-mode user would otherwise catch a white
 * frame between the window appearing and App's effect running.
 */
export function persistedThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS.theme
    const parsed = JSON.parse(raw) as { state?: { theme?: unknown }; theme?: unknown }
    const theme = parsed?.state?.theme ?? parsed?.theme
    return theme === 'dark' || theme === 'light' || theme === 'system'
      ? theme
      : DEFAULT_SETTINGS.theme
  } catch {
    // Unparseable or unavailable storage is not worth failing a boot over.
    return DEFAULT_SETTINGS.theme
  }
}

const STYLE_ID = 'nyra-theme'

/**
 * Paint a theme's colours, or clear them.
 *
 * Nyra Light and Nyra Dark clear: they are the stylesheet, and the way to show
 * the stylesheet exactly is to take every override off. Anything else becomes a
 * `<style>` block keyed on `html.nyra-themed` — a block rather than inline
 * styles on <html>, because the bubble needs its own palette and an inline
 * style cannot reach a descendant.
 */
export function applyThemeStyles(theme: Theme | null): void {
  const root = document.documentElement
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!theme || isStylesheetTheme(theme)) {
    root.classList.remove('nyra-themed')
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  const css = themeCss(theme)
  if (el.textContent !== css) el.textContent = css
  root.classList.add('nyra-themed')
}

/**
 * The two slot themes, as last applied, for the next boot.
 *
 * A user theme lives in a file the renderer can only read asynchronously, and
 * the first frame cannot wait for IPC. So the themes the slots resolved to are
 * kept here as well, and `bootTheme` paints from this copy. The file stays the
 * source of truth: this is overwritten as soon as the real list loads.
 */
const THEME_CACHE_KEY = 'nyra-theme-slots'

export function writeThemeCache(slots: Record<ThemeMode, Theme>): void {
  try {
    const keep = (t: Theme): Theme | null => (t.builtIn ? null : t)
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ light: keep(slots.light), dark: keep(slots.dark) }))
  } catch {
    // Storage full or unavailable: the next boot paints the default and corrects.
  }
}

export function readThemeCache(): Theme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw) return []
    return [parseTheme(raw.light), parseTheme(raw.dark)].filter((t): t is Theme => t !== null)
  } catch {
    return []
  }
}

function persistedSlot(mode: ThemeMode): string {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const parsed = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> } & Record<string, unknown>) : null
    const stored = parsed?.state ?? parsed
    const id = stored?.[mode === 'light' ? 'lightTheme' : 'darkTheme']
    if (typeof id === 'string') return id
  } catch {
    // Fall through to the default.
  }
  return mode === 'light' ? DEFAULT_SETTINGS.lightTheme : DEFAULT_SETTINGS.darkTheme
}

/** Put the theme on <html> before the first paint: the mode, then its colours. */
export function bootTheme(): void {
  const mode = resolveTheme(persistedThemePreference())
  applyThemeClass(mode)
  const id = persistedSlot(mode)
  const theme = builtInTheme(id) ?? readThemeCache().find((t) => t.id === id && t.mode === mode) ?? null
  applyThemeStyles(theme)
}
