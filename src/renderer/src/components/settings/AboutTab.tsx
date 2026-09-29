import React from 'react'
import UpdateRow from '../UpdateRow'
import { SectionLabel, SettingRow, Toggle } from './primitives'
import { useSettingsStore } from '../../store/settings'
import { useUpdatesStore } from '../../store/updates'

export default function AboutTab(): React.JSX.Element {
  const autoUpdate = useSettingsStore((s) => s.autoUpdate)
  const update = useSettingsStore((s) => s.updateSettings)

  return (
    <>
      <SectionLabel>About</SectionLabel>
      <UpdateRow />
      <SettingRow
        label="Update automatically"
        hint="downloads in the background and installs when you quit"
      >
        <Toggle
          checked={autoUpdate}
          onChange={(v) => {
            update({ autoUpdate: v })
            // A release the launch check already found starts downloading now,
            // not on the next launch.
            if (v) void useUpdatesStore.getState().stage()
          }}
        />
      </SettingRow>
    </>
  )
}
