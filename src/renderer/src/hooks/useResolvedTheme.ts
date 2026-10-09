import { useEffect, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { slotTheme, useThemeStore } from '../store/themes'
import type { Theme } from '../lib/themes'

export type ResolvedTheme = 'dark' | 'light'

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** The mode the Appearance setting asks for, following the OS under System. */
export function usePreferredMode(): ResolvedTheme {
  const preference = useSettingsStore((s) => s.theme)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  useEffect(() => {
    if (preference !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = (e: MediaQueryListEvent): void => setSystemTheme(e.matches ? 'light' : 'dark')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [preference])

  return preference === 'system' ? systemTheme : preference
}

/**
 * The theme the window is painting right now.
 *
 * Usually the one in the slot for the preferred mode. While the theme editor is
 * open it is the draft (or, with ⌥ held, what was there before), and while the
 * picker is previewing it is that — either of which can be the other mode: a
 * dark theme being edited in light mode turns the window dark until it closes.
 */
export function useActiveTheme(): Theme {
  const mode = usePreferredMode()
  const slotId = useSettingsStore((s) => (mode === 'light' ? s.lightTheme : s.darkTheme))
  const userThemes = useThemeStore((s) => s.userThemes)
  const preview = useThemeStore((s) => s.preview)
  const edit = useThemeStore((s) => s.edit)
  if (edit) return edit.comparing ? edit.baseline : edit.draft
  if (preview) return preview
  return slotTheme(mode, slotId, userThemes)
}

/** Light or dark, as painted — which is what Monaco and Shiki need to follow. */
export function useResolvedTheme(): ResolvedTheme {
  return useActiveTheme().mode
}
