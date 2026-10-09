import React, { useState } from 'react'
import { FileDown, FolderOpen, Moon, Plus, Sun } from 'lucide-react'
import { useSettingsStore } from '../../store/settings'
import { slotTheme, useThemeStore } from '../../store/themes'
import { usePreferredMode } from '../../hooks/useResolvedTheme'
import { assignSlot, editTheme, importTheme, newTheme, revealThemesFolder } from '../../lib/themeActions'
import type { Theme, ThemeMode } from '../../lib/themes'
import type { ThemePreference } from '../../../../shared/types'
import { ThemeThumb } from '../theme/ThemeThumb'
import { ThemePicker } from '../theme/ThemePicker'
import { SectionLabel, SegmentedControl } from './primitives'

/**
 * Appearance → Theme: the mode, and a theme for each mode.
 *
 * Both slots are always shown, whichever mode is on. Under System the window
 * moves between them by itself, and someone who only ever sees one would be
 * surprised by the other at sunset.
 */
export default function ThemeSection(): React.JSX.Element {
  const preference = useSettingsStore((s) => s.theme)
  const lightId = useSettingsStore((s) => s.lightTheme)
  const darkId = useSettingsStore((s) => s.darkTheme)
  const update = useSettingsStore((s) => s.updateSettings)
  const userThemes = useThemeStore((s) => s.userThemes)
  const preferred = usePreferredMode()
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)

  const runImport = async (): Promise<void> => {
    const result = await importTheme()
    if (result.canceled) return
    if (result.error) setNotice({ error: true, text: result.error })
    else if (result.theme)
      setNotice({ error: false, text: `Added ${result.theme.name} to your ${result.theme.mode} themes, and switched to it.` })
  }

  const slot = (mode: ThemeMode, theme: Theme): React.JSX.Element => {
    const active = preferred === mode
    const Icon = mode === 'light' ? Sun : Moon
    return (
      <div
        className={`flex min-w-0 flex-1 flex-col gap-3 rounded-lg border p-3 ${
          active ? 'border-info' : 'border-border'
        }`}
      >
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">{mode === 'light' ? 'Light' : 'Dark'}</span>
          <span className="grow" />
          {active && (
            <span className="flex items-center gap-1 text-[11px] text-info">
              <span className="size-1.5 rounded-full bg-info" />
              In use now
            </span>
          )}
        </div>
        <ThemeThumb theme={theme} />
        <div className="flex items-center gap-2">
          <ThemePicker
            mode={mode}
            value={theme}
            onChoose={assignSlot}
            onNew={() => newTheme(mode)}
            onImport={() => void runImport()}
          />
          <button
            type="button"
            onClick={() => editTheme(theme)}
            className="h-7 shrink-0 rounded-lg border border-border-strong px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            {theme.builtIn ? 'Customize' : 'Edit'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <SectionLabel>Theme</SectionLabel>
      <div className="flex items-center justify-between gap-4 pb-3">
        <div className="min-w-0">
          <p className="text-xs text-foreground/80">Appearance</p>
          <p className="text-[11px] text-muted-foreground">
            {preference === 'system'
              ? 'Follows your system, switching between the two themes below.'
              : `Always ${preference}. The other theme is kept for when you switch.`}
          </p>
        </div>
        <SegmentedControl
          value={preference}
          onChange={(v) => update({ theme: v as ThemePreference })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' }
          ]}
        />
      </div>

      <div className="flex items-stretch gap-3">
        {slot('light', slotTheme('light', lightId, userThemes))}
        {slot('dark', slotTheme('dark', darkId, userThemes))}
      </div>

      <div className="mt-3 flex items-center gap-1">
        <button
          type="button"
          onClick={() => newTheme(preferred)}
          className="flex h-7 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="size-3.5 text-muted-foreground" />
          New theme
        </button>
        <button
          type="button"
          onClick={() => void runImport()}
          className="flex h-7 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FileDown className="size-3.5" />
          Import…
        </button>
        <span className="grow" />
        <button
          type="button"
          onClick={() => void revealThemesFolder()}
          className="flex h-7 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="size-3.5" />
          Themes folder
        </button>
      </div>
      <p className={`mt-2 text-[11px] leading-relaxed ${notice?.error ? 'text-danger' : 'text-muted-foreground'}`}>
        {notice?.text ?? (
          <>
            New theme starts as a copy of the one in use. Themes are files in{' '}
            <span className="font-mono">~/.nyra/themes</span>, so you can share one by sending it.
          </>
        )}
      </p>
    </>
  )
}
