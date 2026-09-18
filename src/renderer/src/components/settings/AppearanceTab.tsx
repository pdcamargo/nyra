import React, { useMemo } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useSettingsStore } from '../../store/settings'
import { useSystemFonts } from '../../hooks/useSystemFonts'
import {
  BUNDLED_CODE_FONT,
  BUNDLED_UI_FONT,
  CONTENT_FONT_SIZES,
  FONT_WEIGHTS,
  UI_FONT_SIZES
} from '../../lib/appearance'
import { MAX_ZOOM, MIN_ZOOM, nextZoom } from '../../lib/zoom'
import { type ChatWidth, type ThemePreference } from '../../../../shared/types'
import FontPicker from './FontPicker'
import { SectionLabel, SectionNote, SegmentedControl, Select, SettingRow } from './primitives'

export default function AppearanceTab(): React.JSX.Element {
  const settings = useSettingsStore()
  const update = settings.updateSettings
  const { fonts, loading } = useSystemFonts()

  const codeFonts = useMemo(() => fonts.filter((f) => f.monospaced), [fonts])

  const weightOptions = FONT_WEIGHTS.map((w) => ({ value: String(w.value), label: w.label }))

  return (
    <>
      <SectionLabel>Theme</SectionLabel>
      <SettingRow label="Appearance">
        <SegmentedControl
          value={settings.theme}
          onChange={(v) => update({ theme: v as ThemePreference })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' }
          ]}
        />
      </SettingRow>

      <SectionLabel>Fonts</SectionLabel>
      <SectionNote>
        Every family installed on this machine. A font you later uninstall falls back to the
        bundled one rather than disappearing.
      </SectionNote>

      <SettingRow label="UI font">
        <FontPicker
          value={settings.uiFont}
          onChange={(uiFont) => update({ uiFont })}
          fonts={fonts}
          loading={loading}
          defaultLabel={BUNDLED_UI_FONT}
        />
        <Select
          value={String(settings.uiFontWeight)}
          onChange={(v) => update({ uiFontWeight: Number(v) })}
          options={weightOptions}
        />
      </SettingRow>

      <SettingRow label="Content font" hint="the conversation and the composer">
        <FontPicker
          value={settings.contentFont}
          onChange={(contentFont) => update({ contentFont })}
          fonts={fonts}
          loading={loading}
          defaultLabel="Same as UI font"
        />
        <Select
          value={String(settings.contentFontWeight)}
          onChange={(v) => update({ contentFontWeight: Number(v) })}
          options={weightOptions}
        />
      </SettingRow>

      <SettingRow label="Code font">
        <FontPicker
          value={settings.codeFont}
          onChange={(codeFont) => update({ codeFont })}
          fonts={codeFonts}
          loading={loading}
          defaultLabel={BUNDLED_CODE_FONT}
        />
        <Select
          value={String(settings.codeFontWeight)}
          onChange={(v) => update({ codeFontWeight: Number(v) })}
          options={weightOptions}
        />
      </SettingRow>

      <SectionLabel>Size</SectionLabel>
      <SectionNote>
        Zoom scales the whole window. The two text sizes are independent, because making the
        conversation easier to read and making the rails easier to see are different wants.
      </SectionNote>

      <SettingRow label="Interface text" hint="rails, panels, title bar">
        <Select
          value={String(settings.uiFontSize)}
          onChange={(v) => update({ uiFontSize: Number(v) })}
          options={UI_FONT_SIZES.map((s) => ({ value: String(s), label: `${s} px` }))}
        />
      </SettingRow>

      <SettingRow label="Conversation text" hint="messages and composer">
        <Select
          value={String(settings.contentFontSize)}
          onChange={(v) => update({ contentFontSize: Number(v) })}
          options={CONTENT_FONT_SIZES.map((s) => ({ value: String(s), label: `${s} px` }))}
        />
      </SettingRow>

      <SettingRow label="Zoom">
        <div className="flex items-center gap-1 rounded-lg border border-border">
          <button
            onClick={() => update({ zoom: nextZoom(settings.zoom, -1) })}
            disabled={settings.zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <Minus className="size-3" />
          </button>
          <button
            onClick={() => update({ zoom: 1 })}
            className="min-w-12 text-xs text-foreground/80 tabular-nums"
          >
            {Math.round(settings.zoom * 100)}%
          </button>
          <button
            onClick={() => update({ zoom: nextZoom(settings.zoom, 1) })}
            disabled={settings.zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3" />
          </button>
        </div>
      </SettingRow>

      <SectionLabel>Layout</SectionLabel>
      <SettingRow label="Chat width" hint="how wide the conversation is allowed to get">
        <SegmentedControl
          value={settings.chatWidth}
          onChange={(v) => update({ chatWidth: v as ChatWidth })}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'default', label: 'Default' },
            { value: 'wide', label: 'Wide' },
            { value: 'full', label: 'Full' }
          ]}
        />
      </SettingRow>
    </>
  )
}
