import React, { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { forgetAlways } from '../../lib/desktopControl'
import { useUiStore } from '../../store/ui'
import type { DesktopPermission } from '../../lib/tauri-api'
import { SectionLabel, SectionNote, SettingRow, Toggle } from './primitives'

/**
 * Claude operating other apps: the switch, what the OS allows, and the apps
 * answered "always". Off by default — see `desktop_tools` in settings.rs for
 * why this one is not on like the browser and app tools.
 */
export default function DesktopSection(): React.JSX.Element {
  const enabled = useSettingsStore((s) => s.desktopTools)
  const allowed = useSettingsStore((s) => s.desktopAllowedApps)
  const names = useSettingsStore((s) => s.desktopAppNames)
  const update = useSettingsStore((s) => s.updateSettings)
  const [permissions, setPermissions] = useState<DesktopPermission[]>([])
  const openSettings = useUiStore((s) => s.openSettings)
  // The grants themselves are listed in Settings → System, with the others.
  const missing = permissions.some((p) => !p.granted)

  const refresh = useCallback(() => {
    void window.api.desktop.permissions().then(setPermissions)
  }, [])

  // Granting happens in another app, so check again whenever the window comes back.
  useEffect(() => {
    if (!enabled) return
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [enabled, refresh])

  return (
    <>
      <SectionLabel>Other apps</SectionLabel>
      <SettingRow label="Let Claude use other apps" hint="asks before each app; new chats only">
        <Toggle checked={enabled} onChange={(v) => update({ desktopTools: v })} />
      </SettingRow>
      {enabled && missing && (
        <SettingRow label="The system has not allowed all of it yet">
          <button
            type="button"
            onClick={() => openSettings('system')}
            className="rounded-md border border-input px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-input/40"
          >
            Review in System
          </button>
        </SettingRow>
      )}
      {enabled &&
        allowed.map((id) => (
          <SettingRow key={id} label={names[id] ?? id} hint="always allowed">
            <button
              type="button"
              onClick={() => forgetAlways(id)}
              className="rounded-md border border-input px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-input/40"
            >
              Remove
            </button>
          </SettingRow>
        ))}
      {enabled && (
        <SectionNote>
          Password managers, Keychain, System Settings, terminals and Nyra itself are never touched,
          whatever you allow here.
        </SectionNote>
      )}
    </>
  )
}
