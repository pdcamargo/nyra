import { describe, it, expect, beforeEach, vi } from 'vitest'

// The module migrates on import, so every case has to seed localStorage and then
// pull in a fresh copy — importing once at the top would run the migration
// against an empty store and never run it again.
async function migrate(): Promise<void> {
  vi.resetModules()
  await import('../../renderer/src/lib/legacy-storage')
}

describe('legacy storage key migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('carries an old key across to its nyra- name', async () => {
    localStorage.setItem('coide-settings', '{"state":{"model":"opus"}}')
    await migrate()
    expect(localStorage.getItem('nyra-settings')).toBe('{"state":{"model":"opus"}}')
  })

  it('leaves the old key in place for whichever build has not updated yet', async () => {
    // Dev and the installed app share one WebKit store. Deleting on migrate
    // would strip the settings of the build still reading the old names.
    localStorage.setItem('coide-shortcuts', '{"state":{}}')
    await migrate()
    expect(localStorage.getItem('coide-shortcuts')).toBe('{"state":{}}')
    expect(localStorage.getItem('nyra-shortcuts')).toBe('{"state":{}}')
  })

  it('leaves an existing nyra- key alone rather than clobbering it', async () => {
    // The case that matters: an install that has already run under the new names
    // and then meets a stale old key. The new state is the real one.
    localStorage.setItem('nyra-ui', 'current')
    localStorage.setItem('coide-ui', 'stale')
    await migrate()
    expect(localStorage.getItem('nyra-ui')).toBe('current')
  })

  it('does nothing on a fresh install', async () => {
    await migrate()
    expect(localStorage.length).toBe(0)
  })

  it('covers every store that was renamed', async () => {
    for (const key of ['settings', 'ui', 'panel-sizes', 'workspace', 'shortcuts']) {
      localStorage.setItem(`coide-${key}`, key)
    }
    await migrate()
    for (const key of ['settings', 'ui', 'panel-sizes', 'workspace', 'shortcuts']) {
      expect(localStorage.getItem(`nyra-${key}`)).toBe(key)
    }
  })

  it('skips the sessions database when IndexedDB is unavailable', async () => {
    // jsdom ships no indexedDB, which is the same shape as a locked-down webview:
    // the migration has to return rather than throw, or the app never boots.
    vi.resetModules()
    const { migrateSessionsDb } = await import('../../renderer/src/lib/legacy-storage')
    await expect(migrateSessionsDb()).resolves.toBeUndefined()
  })
})
