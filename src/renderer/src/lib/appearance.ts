import type { NyraSettings } from '../../../shared/types'

/**
 * Fonts and type size, as CSS variables on <html>.
 *
 * The families are whatever is installed — `fonts_list` enumerates them — so
 * what is stored is a family *name*, not an id from a fixed list. That is why
 * every stack keeps the bundled face behind it: a font uninstalled since it was
 * chosen then degrades instead of disappearing.
 *
 * Nothing here is blocked by the CSP. `font-src 'self' data:` governs @font-face
 * URL fetches; a locally installed family named in `font-family` is never
 * fetched in the first place.
 */

/** The two faces that ship with the app, and the stacks they anchor. */
export const BUNDLED_UI_FONT = 'Inter Variable'
export const BUNDLED_CODE_FONT = 'Fira Code Variable'

const UI_FALLBACK = `'${BUNDLED_UI_FONT}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
const CODE_FALLBACK = `'${BUNDLED_CODE_FONT}', ui-monospace, 'SF Mono', Menlo, monospace`

export const FONT_WEIGHTS: { value: number; label: string }[] = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' }
]

/** Type sizes offered for the conversation, in px. */
export const CONTENT_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20] as const

/** And for the chrome. Smaller range: the rails are dense by design. */
export const UI_FONT_SIZES = [11, 12, 13, 14, 15, 16] as const

/**
 * A family name as a CSS `font-family` value, with the bundled stack behind it.
 *
 * The name is a string the user picked from their own system, so the quotes and
 * backslashes come out before it is interpolated — a family called `a", b` would
 * otherwise close the string and inject whatever followed.
 */
export function fontStack(name: string, fallback: string): string {
  const clean = name.replace(/["\\]/g, '').trim()
  return clean ? `"${clean}", ${fallback}` : fallback
}

export function uiFontStack(name: string): string {
  return fontStack(name, UI_FALLBACK)
}

export function codeFontStack(name: string): string {
  return fontStack(name, CODE_FALLBACK)
}

export type AppearanceSettings = Pick<
  NyraSettings,
  | 'uiFont'
  | 'uiFontWeight'
  | 'contentFont'
  | 'contentFontWeight'
  | 'codeFont'
  | 'codeFontWeight'
  | 'contentFontSize'
  | 'uiFontSize'
>

export function appearanceOf(settings: NyraSettings): AppearanceSettings {
  return {
    uiFont: settings.uiFont,
    uiFontWeight: settings.uiFontWeight,
    contentFont: settings.contentFont,
    contentFontWeight: settings.contentFontWeight,
    codeFont: settings.codeFont,
    codeFontWeight: settings.codeFontWeight,
    contentFontSize: settings.contentFontSize,
    uiFontSize: settings.uiFontSize
  }
}

/**
 * Put the choices on the document.
 *
 * Inline styles on <html> rather than a stylesheet rule: they outrank the
 * `:root` block Tailwind emits for the theme, so both the `font-sans` utilities
 * and the places that name `var(--font-sans)` directly follow along.
 */
export function applyAppearance(s: AppearanceSettings): void {
  const root = document.documentElement.style
  root.setProperty('--font-sans', uiFontStack(s.uiFont))
  root.setProperty('--font-content', fontStack(s.contentFont, uiFontStack(s.uiFont)))
  root.setProperty('--font-mono', codeFontStack(s.codeFont))
  root.setProperty('--ui-font-weight', String(s.uiFontWeight))
  root.setProperty('--content-font-weight', String(s.contentFontWeight))
  root.setProperty('--code-font-weight', String(s.codeFontWeight))
  root.setProperty('--content-font-size', `${s.contentFontSize}px`)
  root.setProperty('--ui-font-size', `${s.uiFontSize}px`)
}

/** The zustand persist key for the settings store. Renaming it drops user data. */
const SETTINGS_KEY = 'nyra-settings'

/**
 * Apply the persisted appearance before React mounts.
 *
 * Same trick, and the same reason, as `bootTheme`: read the blob directly rather
 * than waiting for the store to rehydrate, so the first paint is not the
 * defaults followed by a visible correction.
 */
export function bootAppearance(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { state?: Partial<NyraSettings> } & Partial<NyraSettings>
    const stored = parsed?.state ?? parsed
    applyAppearance({
      uiFont: typeof stored.uiFont === 'string' ? stored.uiFont : '',
      uiFontWeight: Number(stored.uiFontWeight) || 400,
      contentFont: typeof stored.contentFont === 'string' ? stored.contentFont : '',
      contentFontWeight: Number(stored.contentFontWeight) || 400,
      codeFont: typeof stored.codeFont === 'string' ? stored.codeFont : '',
      codeFontWeight: Number(stored.codeFontWeight) || 400,
      contentFontSize: Number(stored.contentFontSize) || 15,
      uiFontSize: Number(stored.uiFontSize) || 13
    })
  } catch {
    // Unparseable or unavailable storage is not worth failing a boot over.
  }
}
