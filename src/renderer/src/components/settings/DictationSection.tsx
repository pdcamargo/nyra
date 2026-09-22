/**
 * Dictation settings.
 *
 * No engine or backend row: which recogniser runs is an implementation detail
 * nobody should have to hold an opinion about. Only multilingual models are
 * offered — the English-only Whisper builds are better per megabyte but cannot
 * transcribe Portuguese at all.
 */
import React from 'react'
import { useSettingsStore } from '../../store/settings'
import { useDictationStore, downloadFraction, formatBytes } from '../../store/dictation'
import { SectionLabel, SectionNote, Select, SettingRow, Toggle } from './primitives'
import type { DictationStatus } from '../../lib/tauri-api'

const LANGUAGES = [
  { value: '', label: 'Detect' },
  { value: 'pt', label: 'Português' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' }
]

export default function DictationSection(): React.JSX.Element {
  const settings = useSettingsStore()
  const update = settings.updateSettings
  const phase = useDictationStore((s) => s.phase)
  const received = useDictationStore((s) => s.received)
  const total = useDictationStore((s) => s.total)
  const [status, setStatus] = React.useState<DictationStatus | null>(null)

  const refresh = React.useCallback(() => {
    // Guarded rather than assumed: `initTauriApi` resolves before the tree
    // mounts in the app, but a test that renders this pane in isolation has
    // no bridge, and a settings modal that throws is worse than one that
    // shows no download state.
    void window.api?.dictation
      ?.status(settings.dictationModel)
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [settings.dictationModel])

  React.useEffect(refresh, [refresh])
  // A download finishing elsewhere — the mic button — should update this too.
  React.useEffect(() => {
    if (phase === 'idle') refresh()
  }, [phase, refresh])

  const catalogue = status?.catalogue ?? []
  const downloading = phase === 'downloading'

  return (
    <>
      <SectionLabel>Dictation</SectionLabel>
      <SectionNote>
        Speech is transcribed on this Mac. Nothing is uploaded and nothing is charged. The model
        downloads once, then dictation works offline.
      </SectionNote>

      <SettingRow
        label="Model"
        hint={status?.installed ? 'downloaded' : 'downloads on first use'}
      >
        <Select
          value={settings.dictationModel}
          onChange={(dictationModel) => update({ dictationModel })}
          options={catalogue.map((m) => ({
            value: m.id,
            label: `${m.label} · ${formatBytes(m.bytes)}`
          }))}
        />
      </SettingRow>

      {downloading ? (
        <SettingRow label="Downloading" hint={`${formatBytes(received)} of ${formatBytes(total)}`}>
          <div className="flex items-center gap-2">
            <div className="h-1 w-24 overflow-hidden rounded-full bg-accent">
              <div
                className="h-full rounded-full bg-info transition-[width] duration-300"
                style={{ width: `${(downloadFraction(received, total) * 100).toFixed(1)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() => void window.api.dictation.modelCancel()}
              className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </SettingRow>
      ) : status && !status.installed ? (
        <SettingRow label="Not downloaded" hint="or press the microphone">
          <button
            type="button"
            onClick={() => {
              useDictationStore.getState().startDownload(settings.dictationModel)
              void window.api.dictation.modelDownload(settings.dictationModel)
            }}
            className="rounded-md bg-info px-3 py-1 text-xs font-medium text-info-foreground transition-colors hover:bg-info/85"
          >
            Download
          </button>
        </SettingRow>
      ) : null}

      <SettingRow
        label="Language"
        hint="detection misreads short phrases. Set one if you always dictate in the same language"
      >
        <Select
          value={settings.dictationLanguage}
          onChange={(dictationLanguage) => update({ dictationLanguage })}
          options={LANGUAGES}
        />
      </SettingRow>

      <SettingRow label="Microphone">
        <Select
          value={settings.dictationDevice}
          onChange={(dictationDevice) => update({ dictationDevice })}
          options={[
            { value: '', label: 'System default' },
            ...(status?.devices ?? []).map((d) => ({ value: d, label: d }))
          ]}
        />
      </SettingRow>

      <SettingRow label="Show a transcript while speaking">
        <Toggle
          checked={settings.dictationLiveTranscript}
          onChange={(dictationLiveTranscript) => update({ dictationLiveTranscript })}
        />
      </SettingRow>

      <SettingRow
        label="Use names from this project"
        hint="so dictation spells them the way your code does"
      >
        <Toggle
          checked={settings.dictationVocabulary}
          onChange={(dictationVocabulary) => update({ dictationVocabulary })}
        />
      </SettingRow>
    </>
  )
}
