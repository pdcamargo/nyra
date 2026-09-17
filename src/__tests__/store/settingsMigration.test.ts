import { describe, expect, it } from 'vitest'
import { migrateSettings, useSettingsStore } from '@renderer/store/settings'

const base = (): ReturnType<typeof useSettingsStore.getState> => useSettingsStore.getState()

describe('migrateSettings', () => {
  it('treats a user who had picked a working folder as onboarded', () => {
    const merged = migrateSettings({ defaultCwd: '/repo/one' }, base())
    expect(merged.onboardingComplete).toBe(true)
  })

  it('respects an explicit onboarding flag over the inference', () => {
    const merged = migrateSettings({ defaultCwd: '/repo/one', onboardingComplete: false }, base())
    expect(merged.onboardingComplete).toBe(false)
  })

  it('leaves a genuinely new user in onboarding', () => {
    expect(migrateSettings({}, base()).onboardingComplete).toBe(false)
  })

  it('strips the retired key so it never reaches settings_sync', () => {
    const merged = migrateSettings({ defaultCwd: '/repo/one' }, base())
    expect('defaultCwd' in merged).toBe(false)
  })

  it('keeps the settings that still matter', () => {
    const merged = migrateSettings({ model: 'opus', autoApproveTools: ['Bash'] }, base())
    expect(merged.model).toBe('opus')
    expect(merged.autoApproveTools).toEqual(['Bash'])
  })
})
