import { describe, expect, it } from 'vitest'
import {
  continueListOnEnter,
  insertLink,
  toggleHeading,
  toggleInlineMarker
} from '../../renderer/src/lib/markdownEditing'

describe('toggleInlineMarker', () => {
  it('wraps a selection and keeps it selected', () => {
    const r = toggleInlineMarker('make me bold', 8, 12, 'bold')
    expect(r.text).toBe('make me **bold**')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('bold')
  })

  it('unwraps when the markers sit just outside the selection', () => {
    const r = toggleInlineMarker('make me **bold**', 10, 14, 'bold')
    expect(r.text).toBe('make me bold')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('bold')
  })

  it('unwraps when the markers are inside the selection', () => {
    const r = toggleInlineMarker('make me **bold**', 8, 16, 'bold')
    expect(r.text).toBe('make me bold')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('bold')
  })

  it('inserts an empty pair and puts the caret between them', () => {
    const r = toggleInlineMarker('ab', 1, 1, 'italic')
    expect(r.text).toBe('a**b')
    expect(r.selectionStart).toBe(2)
    expect(r.selectionEnd).toBe(2)
  })

  it('does not mistake bold for italic', () => {
    // The selection is wrapped in ** — asking for italic adds its own pair
    // rather than unwrapping half of the bold.
    const r = toggleInlineMarker('**x**', 2, 3, 'italic')
    expect(r.text).toBe('***x***')
  })
})

describe('insertLink', () => {
  it('wraps the selection and lands the caret in the url', () => {
    const r = insertLink('see docs here', 4, 8)
    expect(r.text).toBe('see [docs]() here')
    expect(r.selectionStart).toBe(11)
    expect(r.text.slice(0, r.selectionStart).endsWith('](')).toBe(true)
  })

  it('uses a placeholder label when nothing is selected', () => {
    expect(insertLink('', 0, 0).text).toBe('[text]()')
  })
})

describe('continueListOnEnter', () => {
  it('continues a bullet', () => {
    const r = continueListOnEnter('- one', 5, 5)!
    expect(r.text).toBe('- one\n- ')
    expect(r.selectionStart).toBe(8)
  })

  it('increments an ordered list', () => {
    expect(continueListOnEnter('3. three', 8, 8)!.text).toBe('3. three\n4. ')
  })

  it('continues a quote', () => {
    expect(continueListOnEnter('> quoted', 8, 8)!.text).toBe('> quoted\n> ')
  })

  it('keeps the indent of a nested item', () => {
    expect(continueListOnEnter('  - deep', 8, 8)!.text).toBe('  - deep\n  - ')
  })

  it('ends the list when the marker is empty', () => {
    const r = continueListOnEnter('- one\n- ', 8, 8)!
    expect(r.text).toBe('- one\n')
    expect(r.selectionStart).toBe(6)
  })

  it('returns null on a plain line, so Enter keeps its usual meaning', () => {
    expect(continueListOnEnter('just text', 9, 9)).toBeNull()
  })

  it('returns null mid-line, so Enter there does not duplicate a marker', () => {
    expect(continueListOnEnter('- one', 3, 3)).toBeNull()
  })

  it('returns null when there is a selection', () => {
    expect(continueListOnEnter('- one', 2, 5)).toBeNull()
  })
})

describe('toggleHeading', () => {
  it('adds a level', () => {
    expect(toggleHeading('Title', 0, 0, 3).text).toBe('### Title')
  })

  it('removes the same level again', () => {
    expect(toggleHeading('### Title', 4, 4, 3).text).toBe('Title')
  })

  it('replaces a different level rather than stacking', () => {
    expect(toggleHeading('# Title', 2, 2, 3).text).toBe('### Title')
  })

  it('only touches the line the caret is on', () => {
    expect(toggleHeading('one\ntwo', 5, 5, 2).text).toBe('one\n## two')
  })
})
