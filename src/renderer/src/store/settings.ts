import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { type NyraSettings, DEFAULT_SETTINGS } from '../../../shared/types'

type SettingsStore = NyraSettings & {
  updateSettings: (partial: Partial<NyraSettings>) => void
  resetSettings: () => void
}

/**
 * Fold a persisted blob into the current defaults.
 *
 * Exported so the two things it has to get right stay tested: an existing user is
 * not shown onboarding again, and the retired `defaultCwd` key does not survive
 * into the object `settings_sync` ships to the backend.
 */
export function migrateSettings(
  persisted: unknown,
  current: SettingsStore
): SettingsStore {
  const merged = { ...current, ...(persisted as Partial<SettingsStore>) }
  // Anyone who had already picked a working folder has been through onboarding.
  // `defaultCwd` is gone from the type now that chats belong to projects, so read
  // it off the raw persisted blob rather than the store.
  const raw = persisted as Record<string, unknown> | undefined
  if (raw?.defaultCwd && raw?.onboardingComplete === undefined) {
    merged.onboardingComplete = true
  }
  // Drop retired keys so they stop round-tripping through settings_sync.
  delete (merged as Record<string, unknown>).defaultCwd
  delete (merged as Record<string, unknown>).compactMode
  return merged
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      updateSettings: (partial: Partial<NyraSettings>) => set(partial),
      resetSettings: () => set(DEFAULT_SETTINGS)
    }),
    {
      name: 'nyra-settings',
      merge: (persisted, current) => migrateSettings(persisted, current as SettingsStore)
    }
  )
)
