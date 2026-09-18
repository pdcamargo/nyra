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

  // fontSize was 'small' | 'medium' | 'large' and only styled the message list.
  // The rename is what keeps settings_sync working: settings.rs typed the old key
  // as a String, so shipping a number under the same name would reject every sync.
  it('converts the old font size to pixels', () => {
    expect(migrateSettings({ fontSize: 'small' }, base()).contentFontSize).toBe(13)
    expect(migrateSettings({ fontSize: 'medium' }, base()).contentFontSize).toBe(15)
    expect(migrateSettings({ fontSize: 'large' }, base()).contentFontSize).toBe(17)
  })

  it('never lets the retired key reach settings_sync', () => {
    expect('fontSize' in migrateSettings({ fontSize: 'large' }, base())).toBe(false)
  })

  it('leaves an already-migrated blob alone', () => {
    const merged = migrateSettings({ fontSize: 'small', contentFontSize: 20 }, base())
    expect(merged.contentFontSize).toBe(20)
  })

  it('gives a blob with neither key the default', () => {
    expect(migrateSettings({}, base()).contentFontSize).toBe(15)
  })

  it('keeps the settings that still matter', () => {
    const merged = migrateSettings({ model: 'opus', autoApproveTools: ['Bash'] }, base())
    expect(merged.model).toBe('opus')
    expect(merged.autoApproveTools).toEqual(['Bash'])
  })
})
