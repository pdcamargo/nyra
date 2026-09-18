import { beforeEach, describe, expect, it } from 'vitest'
import {
  bindingMap,
  chordFor,
  conflictFor,
  mergeShortcutOverrides,
  useShortcutsStore
} from '@renderer/store/shortcuts'
import { COMMANDS, COMMANDS_BY_ID } from '@renderer/commands/registry'
import { normalizeChord } from '@renderer/lib/keys'

const base = (): ReturnType<typeof useShortcutsStore.getState> => useShortcutsStore.getState()

describe('chordFor', () => {
  beforeEach(() => useShortcutsStore.setState({ overrides: {}, recording: false }))

  it('falls back to the registry default', () => {
    expect(chordFor('palette.open', {})).toBe('mod+k')
  })

  it('prefers an override', () => {
    expect(chordFor('palette.open', { 'palette.open': 'mod+shift+k' })).toBe('mod+shift+k')
  })

  // The distinction that matters: a missing key means "use the default", an
  // explicit null means "the user took the binding away". They must not collapse.
  it('treats a cleared binding as unbound, not as the default', () => {
    expect(chordFor('palette.open', { 'palette.open': null })).toBeNull()
  })
})

describe('the store', () => {
  beforeEach(() => useShortcutsStore.setState({ overrides: {}, recording: false }))

  it('normalizes what it is given', () => {
    base().setBinding('palette.open', 'Shift+Cmd+K')
    expect(base().overrides['palette.open']).toBe('mod+shift+k')
  })

  it('clears, resets one, and resets all', () => {
    base().setBinding('palette.open', 'mod+shift+k')
    base().clearBinding('session.new')

    expect(chordFor('session.new', base().overrides)).toBeNull()

    base().resetBinding('session.new')
    expect(chordFor('session.new', base().overrides)).toBe('mod+n')
    expect('session.new' in base().overrides).toBe(false)

    base().resetAll()
    expect(base().overrides).toEqual({})
    expect(chordFor('palette.open', base().overrides)).toBe('mod+k')
  })
})

describe('mergeShortcutOverrides', () => {
  beforeEach(() => useShortcutsStore.setState({ overrides: {}, recording: false }))

  it('keeps a cleared binding cleared across a reload', () => {
    const merged = mergeShortcutOverrides({ overrides: { 'session.new': null } }, base(), 'mac')
    expect(chordFor('session.new', merged.overrides)).toBeNull()
  })

  it('drops an override for a command that no longer exists', () => {
    const merged = mergeShortcutOverrides({ overrides: { 'gone.forever': 'mod+g' } }, base(), 'mac')
    expect('gone.forever' in merged.overrides).toBe(false)
  })

  it('drops a chord that no longer parses', () => {
    const merged = mergeShortcutOverrides(
      { overrides: { 'palette.open': 'mod+notakey' } },
      base(),
      'mac'
    )
    expect(chordFor('palette.open', merged.overrides)).toBe('mod+k')
  })

  it('normalizes on the way in', () => {
    const merged = mergeShortcutOverrides({ overrides: { 'palette.open': 'Cmd+K' } }, base(), 'mac')
    expect(merged.overrides['palette.open']).toBe('mod+k')
  })

  it('never restores the recording flag', () => {
    const merged = mergeShortcutOverrides({ overrides: {}, recording: true }, base(), 'mac')
    expect(merged.recording).toBe(false)
  })

  it('survives a garbage blob', () => {
    expect(mergeShortcutOverrides(undefined, base(), 'mac').overrides).toEqual({})
    expect(mergeShortcutOverrides({ overrides: 'nope' }, base(), 'mac').overrides).toEqual({})
  })
})

describe('bindingMap and conflictFor', () => {
  it('is one chord to one command', () => {
    const map = bindingMap({})
    expect(map.get('mod+k')).toBe('palette.open')
    expect(map.size).toBe(new Set(map.keys()).size)
  })

  it('leaves the composer keys out of the bindable map', () => {
    // ⌘B bolds text; it must not read as a free chord.
    expect(bindingMap({}).has('mod+b')).toBe(false)
  })

  it('names the occupant of a taken chord', () => {
    expect(conflictFor('mod+k', 'session.new', {})).toBe('palette.open')
  })

  it('still sees a read-only composer key as a conflict', () => {
    expect(conflictFor('mod+b', 'session.new', {})).toBe('composer.bold')
  })

  it('does not conflict with itself', () => {
    expect(conflictFor('mod+k', 'palette.open', {})).toBeNull()
  })

  it('is null for a free chord', () => {
    expect(conflictFor('mod+shift+y', 'session.new', {})).toBeNull()
  })
})

describe('the registry itself', () => {
  it('has unique ids', () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
    expect(COMMANDS_BY_ID.size).toBe(COMMANDS.length)
  })

  it('ships every default chord already normalized', () => {
    for (const c of COMMANDS) {
      if (!c.defaultChord) continue
      expect(normalizeChord(c.defaultChord, 'mac'), `${c.id} → ${c.defaultChord}`).toBe(
        c.defaultChord
      )
    }
  })

  it('gives no two commands the same default', () => {
    const chords = COMMANDS.map((c) => c.defaultChord).filter((c): c is string => c !== null)
    expect(new Set(chords).size).toBe(chords.length)
  })

  it('gives every runnable command a way to run, and every read-only one none', () => {
    for (const c of COMMANDS) {
      if (c.readOnly) expect(c.run, c.id).toBeUndefined()
      else expect(c.run, c.id).toBeTypeOf('function')
    }
  })

  it('gives every palette action an icon', () => {
    for (const c of COMMANDS.filter((c) => c.palette)) expect(c.icon, c.id).toBeDefined()
  })
})
