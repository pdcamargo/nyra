import { describe, expect, it } from 'vitest'
import {
  keyEventOf,
  modifiersOf,
  pageFromCanvas
} from '../../renderer/src/lib/browser/input'

const VIEWPORT = { width: 1280, height: 800 }
const rect = { left: 100, top: 50, width: 640, height: 400 }

describe('pageFromCanvas', () => {
  it('scales a click on a half-size canvas back to page coordinates', () => {
    expect(pageFromCanvas({ x: 100, y: 50 }, rect, VIEWPORT)).toEqual({ x: 0, y: 0 })
    expect(pageFromCanvas({ x: 420, y: 250 }, rect, VIEWPORT)).toEqual({ x: 640, y: 400 })
    expect(pageFromCanvas({ x: 740, y: 450 }, rect, VIEWPORT)).toEqual({ x: 1280, y: 800 })
  })

  it('clamps a drag that left the canvas to the edge', () => {
    expect(pageFromCanvas({ x: -500, y: -500 }, rect, VIEWPORT)).toEqual({ x: 0, y: 0 })
    expect(pageFromCanvas({ x: 9999, y: 9999 }, rect, VIEWPORT)).toEqual({
      x: 1280,
      y: 800
    })
  })

  it('survives a canvas that has not been laid out yet', () => {
    expect(pageFromCanvas({ x: 10, y: 10 }, { ...rect, width: 0, height: 0 }, VIEWPORT)).toEqual({
      x: 0,
      y: 0
    })
  })
})

describe('modifiersOf', () => {
  it('uses CDP-s bitmask, which matches no other ordering', () => {
    const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(modifiersOf(none)).toBe(0)
    expect(modifiersOf({ ...none, altKey: true })).toBe(1)
    expect(modifiersOf({ ...none, ctrlKey: true })).toBe(2)
    expect(modifiersOf({ ...none, metaKey: true })).toBe(4)
    expect(modifiersOf({ ...none, shiftKey: true })).toBe(8)
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
  })
})

describe('keyEventOf', () => {
  const base = {
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  }

  it('types a printable key by carrying its text', () => {
    const event = keyEventOf({ ...base, key: 'a', code: 'KeyA', keyCode: 65 }, 'down')
    expect(event.type).toBe('keyDown')
    expect(event.text).toBe('a')
    expect(event.windowsVirtualKeyCode).toBe(65)
  })

  it('does not insert a character for a shortcut', () => {
    // Cmd+A is select-all, not a request to type the letter a.
    const event = keyEventOf({ ...base, metaKey: true, key: 'a', code: 'KeyA', keyCode: 65 }, 'down')
    expect(event.type).toBe('rawKeyDown')
    expect(event.text).toBeUndefined()
    expect(event.modifiers).toBe(4)
  })

  it('sends a command key as rawKeyDown with no text', () => {
    const event = keyEventOf({ ...base, key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, 'down')
    expect(event.type).toBe('rawKeyDown')
    expect(event.text).toBeUndefined()
  })

  it('still submits a form, because Enter carries a carriage return', () => {
    const event = keyEventOf({ ...base, key: 'Enter', code: 'Enter', keyCode: 13 }, 'down')
    expect(event.type).toBe('keyDown')
    expect(event.text).toBe('\r')
  })

  it('marks a release as a release', () => {
    const event = keyEventOf({ ...base, key: 'a', code: 'KeyA', keyCode: 65 }, 'up')
    expect(event.type).toBe('keyUp')
    expect(event.text).toBeUndefined()
  })
})
