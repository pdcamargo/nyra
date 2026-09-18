import React from 'react'
import { modelOptions } from '../../lib/models'
import { useSettingsStore } from '../../store/settings'
import { type NyraSettings } from '../../../../shared/types'
import { Field, NumberField, SectionLabel, Select, SettingRow, Toggle } from './primitives'

export default function ModelTab(): React.JSX.Element {
  const settings = useSettingsStore()
  const update = settings.updateSettings

  return (
    <>
      <SectionLabel>Model</SectionLabel>

      {/* No version numbers: an alias means "the latest", so "Opus 4" was wrong
          the day Opus 5 shipped. A model set from the composer that is not one
          of these still shows here, rather than the row quietly reading
          Default while the session runs on something else. */}
      <SettingRow label="Model">
        <Select
          value={settings.model}
          onChange={(model) => update({ model })}
          options={modelOptions(settings.model)}
        />
      </SettingRow>

      <SettingRow label="Effort">
        <Select
          value={settings.effort}
          onChange={(v) => update({ effort: v as NyraSettings['effort'] })}
          options={[
            { value: '', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
          ]}
        />
      </SettingRow>

      <SettingRow label="Plan mode" hint="start every chat in plan mode">
        <Toggle checked={settings.planMode} onChange={(planMode) => update({ planMode })} />
      </SettingRow>

      <SectionLabel>Context</SectionLabel>
      <SettingRow label="Auto-compact">
        <Toggle checked={settings.autoCompact} onChange={(v) => update({ autoCompact: v })} />
      </SettingRow>
      {settings.autoCompact && (
        <SettingRow label="Compact at" hint="percent of the context window">
          <NumberField
            value={settings.autoCompactThreshold}
            min={50}
            max={99}
            onChange={(autoCompactThreshold) => update({ autoCompactThreshold })}
          />
        </SettingRow>
      )}

      <Field label="System prompt">
        <textarea
          value={settings.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
          placeholder="Appended to Claude's system prompt..."
          rows={4}
          className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong transition-colors resize-none"
        />
      </Field>
    </>
  )
}
