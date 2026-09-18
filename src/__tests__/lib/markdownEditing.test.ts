import { describe, expect, it } from 'vitest'
import {
  listMarkerAt,
  newlineInList,
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

describe('listMarkerAt', () => {
  it('reads the marker and what follows it', () => {
    expect(listMarkerAt('- one')).toEqual({ indent: '', next: '- ', content: 'one' })
    expect(listMarkerAt('  3) three')).toEqual({ indent: '  ', next: '4) ', content: 'three' })
    expect(listMarkerAt('> quoted')).toEqual({ indent: '', next: '> ', content: 'quoted' })
  })

  it('starts the next checkbox unticked', () => {
    expect(listMarkerAt('- [x] done')).toEqual({ indent: '', next: '- [ ] ', content: 'done' })
  })

  it('is null for anything that is not a list', () => {
    expect(listMarkerAt('just text')).toBeNull()
    // A dash with no space is a word, not a bullet.
    expect(listMarkerAt('-nospace')).toBeNull()
    expect(listMarkerAt('')).toBeNull()
  })
})

describe('newlineInList', () => {
  it('breaks a plain line', () => {
    const r = newlineInList('abc', 3, 3)
    expect(r.text).toBe('abc\n')
    expect(r.selectionStart).toBe(4)
  })

  it('breaks a plain line mid-word', () => {
    const r = newlineInList('abcd', 2, 2)
    expect(r.text).toBe('ab\ncd')
    expect(r.selectionStart).toBe(3)
  })

  it('continues a bullet', () => {
    const r = newlineInList('- one', 5, 5)
    expect(r.text).toBe('- one\n- ')
    expect(r.selectionStart).toBe(8)
  })

  // The capability the old Enter-only rule refused: it bailed unless the caret
  // was at end of line, because Enter still had to be able to send.
  it('splits an item mid-line and carries the tail onto the next one', () => {
    const r = newlineInList('- one', 3, 3)
    expect(r.text).toBe('- o\n- ne')
    expect(r.selectionStart).toBe(6)
  })

  it('increments an ordered list and keeps its delimiter', () => {
    expect(newlineInList('3. three', 8, 8).text).toBe('3. three\n4. ')
    expect(newlineInList('3) three', 8, 8).text).toBe('3) three\n4) ')
  })

  it('continues a quote', () => {
    expect(newlineInList('> quoted', 8, 8).text).toBe('> quoted\n> ')
  })

  it('keeps the indent of a nested item', () => {
    expect(newlineInList('  - deep', 8, 8).text).toBe('  - deep\n  - ')
  })

  it('continues a task list unticked', () => {
    expect(newlineInList('- [x] done', 10, 10).text).toBe('- [x] done\n- [ ] ')
  })

  it('ends the list when the item is empty', () => {
    const r = newlineInList('- one\n- ', 8, 8)
    expect(r.text).toBe('- one\n')
    expect(r.selectionStart).toBe(6)
  })

  it('leaves the rest of the document alone when it ends a list mid-way', () => {
    const r = newlineInList('- one\n- \nafter', 8, 8)
    expect(r.text).toBe('- one\n\nafter')
    expect(r.selectionStart).toBe(6)
  })

  it('replaces a selection, then continues from what is left', () => {
    // "world" selected out of "- hello world"
    const r = newlineInList('- hello world', 8, 13)
    expect(r.text).toBe('- hello \n- ')
    expect(r.selectionStart).toBe(11)
  })

  it('classifies the line that survives a multi-line selection', () => {
    const r = newlineInList('- one\ntwo', 3, 9)
    expect(r.text).toBe('- o\n- ')
  })

  it('does not treat a bare dash as a list', () => {
    expect(newlineInList('-', 1, 1).text).toBe('-\n')
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
