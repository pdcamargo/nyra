import { DEFAULT_SETTINGS, type ThemePreference } from '../../../shared/types'

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

/** Put the theme on <html> before the first paint. */
export function bootTheme(): void {
  applyThemeClass(resolveTheme(persistedThemePreference()))
}
