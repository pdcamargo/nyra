import { useEffect } from 'react'
import { applyThemeClass, applyThemeStyles, writeThemeCache } from '../lib/theme'
import { useSettingsStore } from '../store/settings'
import { slotTheme, useThemeStore } from '../store/themes'
import { useActiveTheme } from './useResolvedTheme'

/**
 * The one place a theme reaches the DOM, mounted once in App.
 *
 * Also keeps the user's themes current — read on launch and again whenever the
 * folder changes, which includes the other instance saving one — and refreshes
 * the copy `bootTheme` paints the next launch's first frame from.
 */
export function useApplyTheme(): void {
  const active = useActiveTheme()

  useEffect(() => {
    applyThemeClass(active.mode)
    applyThemeStyles(active)
  }, [active])

  const lightId = useSettingsStore((s) => s.lightTheme)
  const darkId = useSettingsStore((s) => s.darkTheme)
  const userThemes = useThemeStore((s) => s.userThemes)
  const loaded = useThemeStore((s) => s.loaded)

  useEffect(() => {
    if (!loaded) return
    writeThemeCache({ light: slotTheme('light', lightId, userThemes), dark: slotTheme('dark', darkId, userThemes) })
  }, [loaded, lightId, darkId, userThemes])

  useEffect(() => {
    const { load } = useThemeStore.getState()
    void load()
    return window.api.themes.onChanged(() => void load())
  }, [])
}
