import { describe, expect, it } from 'vitest'
import { resolveCommandForEvent } from '@renderer/hooks/useKeyboardShortcuts'

type Ev = Parameters<typeof resolveCommandForEvent>[0]
const press = (over: Partial<Ev>): Ev => ({
  key: 'a',
  code: 'KeyA',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target: null,
  ...over
})

const textarea = (): HTMLElement => {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  return el
}

describe('resolveCommandForEvent', () => {
  it('resolves a default binding', () => {
    const cmd = resolveCommandForEvent(press({ key: 'k', code: 'KeyK', metaKey: true }), {}, 'mac')
    expect(cmd?.id).toBe('palette.open')
  })

  it('follows an override instead of the default', () => {
    const overrides = { 'palette.open': 'mod+shift+k' }
    expect(resolveCommandForEvent(press({ key: 'k', code: 'KeyK', metaKey: true }), overrides, 'mac')).toBeNull()
    expect(
      resolveCommandForEvent(
        press({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }),
        overrides,
        'mac'
      )?.id
    ).toBe('palette.open')
  })

  it('respects a cleared binding', () => {
    expect(
      resolveCommandForEvent(press({ key: 'k', code: 'KeyK', metaKey: true }), { 'palette.open': null }, 'mac')
    ).toBeNull()
  })

  it('uses Ctrl as the mod key off macOS', () => {
    expect(resolveCommandForEvent(press({ key: 'k', code: 'KeyK', ctrlKey: true }), {}, 'other')?.id).toBe(
      'palette.open'
    )
    expect(resolveCommandForEvent(press({ key: 'k', code: 'KeyK', metaKey: true }), {}, 'other')).toBeNull()
  })

  it('lets a modified chord through while you are typing', () => {
    const cmd = resolveCommandForEvent(
      press({ key: 'k', code: 'KeyK', metaKey: true, target: textarea() }),
      {},
      'mac'
    )
    expect(cmd?.id).toBe('palette.open')
  })

  // Escape has to abort the run from inside the composer, which is where you are
  // when you decide to stop it. It is the only bare key that opts in.
  it('lets Escape through while you are typing, because it asked to', () => {
    expect(
      resolveCommandForEvent(press({ key: 'Escape', code: 'Escape', target: textarea() }), {}, 'mac')?.id
    ).toBe('session.abort')
  })

  it('holds a bare key back when a bare key would be typing', () => {
    // Rebind the palette to a bare key and it stops firing inside a text field.
    expect(
      resolveCommandForEvent(
        press({ key: 'k', code: 'KeyK', target: textarea() }),
        { 'palette.open': 'k' },
        'mac'
      )
    ).toBeNull()
    expect(resolveCommandForEvent(press({ key: 'k', code: 'KeyK' }), { 'palette.open': 'k' }, 'mac')?.id).toBe(
      'palette.open'
    )
  })

  it('never resolves a composer key, which its own surface owns', () => {
    expect(resolveCommandForEvent(press({ key: 'b', code: 'KeyB', metaKey: true }), {}, 'mac')).toBeNull()
  })

  it('is null for modifiers on their own', () => {
    expect(resolveCommandForEvent(press({ key: 'Meta', code: 'MetaLeft', metaKey: true }), {}, 'mac')).toBeNull()
  })

  it('resolves the bindings that were added for this change', () => {
    const cases: [Partial<Ev>, string][] = [
      [{ key: ',', code: 'Comma', metaKey: true }, 'app.settings'],
      [{ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true }, 'panel.left'],
      [{ key: 'S', code: 'KeyS', metaKey: true, shiftKey: true }, 'panel.summary'],
      [{ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }, 'chat.planMode'],
      [{ key: 'j', code: 'KeyJ', metaKey: true }, 'panel.bottom'],
      [{ key: '0', code: 'Digit0', metaKey: true }, 'view.zoomReset']
    ]
    for (const [ev, id] of cases) {
      expect(resolveCommandForEvent(press(ev), {}, 'mac')?.id, id).toBe(id)
    }
  })
})
