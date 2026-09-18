import { describe, expect, it } from 'vitest'
import {
  chordMatches,
  chordParts,
  eventToChord,
  formatChord,
  isEditableTarget,
  normalizeChord
} from '@renderer/lib/keys'

type EventLike = Parameters<typeof eventToChord>[0]
const ev = (over: Partial<EventLike>): EventLike => ({
  key: 'a',
  code: 'KeyA',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over
})

describe('normalizeChord', () => {
  it('puts modifiers in a fixed order', () => {
    expect(normalizeChord('shift+mod+b', 'mac')).toBe('mod+shift+b')
    expect(normalizeChord('b', 'mac')).toBe('b')
  })

  it('accepts the spellings people write', () => {
    for (const raw of ['Cmd+Shift+B', 'Command+shift+B', 'MOD+SHIFT+b']) {
      expect(normalizeChord(raw, 'mac')).toBe('mod+shift+b')
    }
  })

  it('folds a literal ctrl into mod off macOS, and keeps it on macOS', () => {
    expect(normalizeChord('ctrl+s', 'other')).toBe('mod+s')
    expect(normalizeChord('ctrl+s', 'mac')).toBe('ctrl+s')
  })

  it('names the special keys', () => {
    expect(normalizeChord('Escape', 'mac')).toBe('escape')
    expect(normalizeChord('mod+ArrowLeft', 'mac')).toBe('mod+left')
    expect(normalizeChord('alt+F12', 'mac')).toBe('alt+f12')
  })

  it('keeps punctuation bindings', () => {
    expect(normalizeChord('mod+,', 'mac')).toBe('mod+,')
    expect(normalizeChord('mod+[', 'mac')).toBe('mod+[')
  })

  it('rejects garbage', () => {
    expect(normalizeChord('', 'mac')).toBeNull()
    expect(normalizeChord('mod', 'mac')).toBeNull() // modifiers alone are not a chord
    expect(normalizeChord('mod+a+b', 'mac')).toBeNull()
    expect(normalizeChord('mod+notakey', 'mac')).toBeNull()
  })
})

describe('eventToChord', () => {
  it('maps the platform mod key', () => {
    expect(eventToChord(ev({ key: 'k', code: 'KeyK', metaKey: true }), 'mac')).toBe('mod+k')
    expect(eventToChord(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'other')).toBe('mod+k')
  })

  it('does not treat the Command key as mod off macOS', () => {
    expect(eventToChord(ev({ key: 'k', code: 'KeyK', metaKey: true }), 'other')).toBe('meta+k')
  })

  it('keeps macOS Control distinct from Command', () => {
    expect(eventToChord(ev({ key: 's', code: 'KeyS', ctrlKey: true }), 'mac')).toBe('ctrl+s')
  })

  // The bug this whole module exists to make impossible: with Shift held,
  // `e.key` is 'F', so `e.key === 'f'` never matched and ⌘⇧F never fired.
  it('lowercases a shifted letter', () => {
    expect(eventToChord(ev({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }), 'mac')).toBe(
      'mod+shift+f'
    )
  })

  it('is null for modifiers on their own', () => {
    expect(eventToChord(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 'mac')).toBeNull()
    expect(eventToChord(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), 'mac')).toBeNull()
  })

  it('names arrows and escape', () => {
    expect(eventToChord(ev({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'mac')).toBe('left')
    expect(eventToChord(ev({ key: 'Escape', code: 'Escape' }), 'mac')).toBe('escape')
  })

  it('falls back to e.code for a non-Latin layout', () => {
    // Cyrillic и sits on the physical B key.
    expect(eventToChord(ev({ key: 'и', code: 'KeyB', metaKey: true, shiftKey: true }), 'mac')).toBe(
      'mod+shift+b'
    )
  })

  it('reads shifted punctuation off the physical key', () => {
    // Shift+= gives '+', which is not a token we accept; the code says Equal.
    expect(eventToChord(ev({ key: '+', code: 'Equal', metaKey: true, shiftKey: true }), 'mac')).toBe(
      'mod+shift+='
    )
    expect(eventToChord(ev({ key: '=', code: 'Equal', metaKey: true }), 'mac')).toBe('mod+=')
  })
})

describe('chordMatches', () => {
  it('matches the same chord on its own platform and not the other', () => {
    const press = ev({ key: 'k', code: 'KeyK', metaKey: true })
    expect(chordMatches('mod+k', press, 'mac')).toBe(true)
    expect(chordMatches('mod+k', press, 'other')).toBe(false)
  })
})

describe('formatChord', () => {
  it('renders mac glyphs and spelled-out names elsewhere', () => {
    expect(formatChord('mod+shift+b', 'mac')).toBe('⌘⇧B')
    expect(formatChord('mod+shift+b', 'other')).toBe('Ctrl+Shift+B')
    expect(formatChord('escape', 'mac')).toBe('⎋')
    expect(formatChord('mod+,', 'mac')).toBe('⌘,')
  })

  it('splits into keycaps', () => {
    expect(chordParts('mod+shift+b', 'mac')).toEqual(['⌘', '⇧', 'B'])
    expect(chordParts('nonsense chord', 'mac')).toEqual([])
  })
})

describe('isEditableTarget', () => {
  const el = (html: string): Element => {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host.firstElementChild as Element
  }

  it('is true for text entry', () => {
    expect(isEditableTarget(el('<input />'))).toBe(true)
    expect(isEditableTarget(el('<textarea></textarea>'))).toBe(true)
    expect(isEditableTarget(el('<div contenteditable="true"></div>'))).toBe(true)
  })

  it('is true inside an editor surface', () => {
    const editor = el('<div class="cm-editor"><span class="cm-line">x</span></div>')
    expect(isEditableTarget(editor.querySelector('.cm-line'))).toBe(true)
  })

  it('is false for ordinary elements', () => {
    expect(isEditableTarget(el('<div></div>'))).toBe(false)
    expect(isEditableTarget(el('<button></button>'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
