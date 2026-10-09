import { beforeEach, describe, expect, it } from 'vitest'
import { changeCount, isDirty, slotTheme, useThemeStore } from '@renderer/store/themes'
import { builtInTheme, type Theme } from '@renderer/lib/themes'

const ember: Theme = {
  id: 'ember',
  name: 'Ember',
  mode: 'dark',
  colors: { accent: '#f08a4b', background: '#1a1614', text: '#ede6df', chrome: '#221c19' }
}

describe('slotTheme', () => {
  it('resolves a slot to its theme, or to Nyra when it cannot', () => {
    expect(slotTheme('dark', 'ember', [ember]).id).toBe('ember')
    expect(slotTheme('dark', 'cyberpunk', []).id).toBe('cyberpunk')
    // Deleted, or the wrong mode: never paint a dark theme in light mode.
    expect(slotTheme('dark', 'gone', []).id).toBe('nyra-dark')
    expect(slotTheme('light', 'ember', [ember]).id).toBe('nyra-light')
  })
})

describe('editing', () => {
  beforeEach(() => useThemeStore.setState({ edit: null, preview: null }))

  it('tracks changes against the saved theme and undoes them', () => {
    const s = useThemeStore.getState()
    s.startEdit(ember, { saved: ember, baseline: ember })
    expect(isDirty(useThemeStore.getState().edit!)).toBe(false)

    s.setColor('bubble', '#5a3322')
    s.setColor('accent', '#ff0000')
    const edit = useThemeStore.getState().edit!
    expect(isDirty(edit)).toBe(true)
    expect(changeCount(edit)).toBe(2)

    s.undo()
    expect(useThemeStore.getState().edit!.draft.colors.accent).toBe('#f08a4b')
    s.setColor('bubble', undefined)
    expect(useThemeStore.getState().edit!.draft.colors.bubble).toBeUndefined()
  })

  it('keeps one undo step per drag', () => {
    const s = useThemeStore.getState()
    s.startEdit(ember, { saved: ember, baseline: ember })
    s.setColor('accent', '#ff0000')
    s.setColor('accent', '#ff1111', { coalesce: true })
    s.setColor('accent', '#ff2222', { coalesce: true })
    s.undo()
    expect(useThemeStore.getState().edit!.draft.colors.accent).toBe('#f08a4b')
  })

  it('refuses to clear a core colour', () => {
    const s = useThemeStore.getState()
    s.startEdit(ember, { saved: ember, baseline: ember })
    s.setColor('background', undefined)
    expect(useThemeStore.getState().edit!.draft.colors.background).toBe('#1a1614')
  })

  it('counts a never-saved copy as dirty even before any change', () => {
    const nord = builtInTheme('nord')!
    useThemeStore.getState().startEdit({ ...nord, id: 'nord-copy', name: 'Nord copy', builtIn: undefined }, { saved: null, baseline: nord })
    const edit = useThemeStore.getState().edit!
    expect(isDirty(edit)).toBe(true)
    expect(changeCount(edit)).toBe(0)
  })
})
