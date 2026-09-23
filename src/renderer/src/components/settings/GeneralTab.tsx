import React from 'react'
import { useSettingsStore } from '../../store/settings'
import { NumberField, SectionLabel, SettingRow, Toggle } from './primitives'
import DictationSection from './DictationSection'

export default function GeneralTab(): React.JSX.Element {
  const settings = useSettingsStore()
  const update = settings.updateSettings

  return (
    <>
      <SectionLabel>Notifications</SectionLabel>
      <SettingRow label="Notify when a turn finishes">
        <Toggle checked={settings.notifications} onChange={(v) => update({ notifications: v })} />
      </SettingRow>

      <SectionLabel>Nyra</SectionLabel>
      <SettingRow label="Let Claude drive Nyra">
        <Toggle checked={settings.appTools} onChange={(v) => update({ appTools: v })} />
      </SettingRow>
      <SettingRow
        label="Chat RAM"
        hint="What the active chat is holding, in the summary card"
      >
        <Toggle
          checked={settings.showChatMemory}
          onChange={(v) => update({ showChatMemory: v })}
        />
      </SettingRow>

      <SectionLabel>Browser</SectionLabel>
      <SettingRow label="Browser tools for Claude">
        <Toggle checked={settings.browserTools} onChange={(v) => update({ browserTools: v })} />
      </SettingRow>
      <SettingRow label="Browser preview over the chat">
        <Toggle checked={settings.browserPip} onChange={(v) => update({ browserPip: v })} />
      </SettingRow>

      <DictationSection />

      <SectionLabel>Worktrees</SectionLabel>
      <SettingRow label="Clean up worktrees">
        <Toggle
          checked={settings.worktreeAutoDelete}
          onChange={(v) => update({ worktreeAutoDelete: v })}
        />
      </SettingRow>
      {settings.worktreeAutoDelete && (
        <SettingRow label="Keep" hint="pinned and running chats are never removed">
          <NumberField
            value={settings.worktreeLimit}
            onChange={(worktreeLimit) => update({ worktreeLimit })}
          />
        </SettingRow>
      )}
    </>
  )
}
