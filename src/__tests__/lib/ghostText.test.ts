import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ghostText, setGhostText } from '@renderer/lib/ghostText'

const view = (doc = ''): EditorView =>
  new EditorView({ state: EditorState.create({ doc, extensions: [ghostText] }) })

const ghostOf = (v: EditorView): string | null => {
  const el = v.dom.querySelector('.cm-ghost-text')
  return el ? el.textContent : null
}

const show = (v: EditorView, text: string, settling = false): void => {
  v.dispatch({ effects: setGhostText.of({ text, settling }) })
}

const ghostEl = (v: EditorView): Element | null => v.dom.querySelector('.cm-ghost-text')

describe('ghost text', () => {
  it('draws nothing until there is something to draw', () => {
    expect(ghostOf(view())).toBeNull()
  })

  it('draws the provisional transcript', () => {
    const v = view()
    show(v, 'refactor the ComposerBar')
    expect(ghostOf(v)).toBe('refactor the ComposerBar')
  })

  /**
   * The whole reason for a decoration rather than an edit: whatever is typed
   * has to survive the transcript updating underneath it.
   */
  it('never enters the document', () => {
    const v = view('already typed')
    show(v, 'and this is only heard')
    expect(v.state.doc.toString()).toBe('already typed')
  })

  it('adds no undo history', () => {
    const v = view('typed')
    const before = v.state.doc.toString()
    show(v, 'heard')
    show(v, 'heard more')
    expect(v.state.doc.toString()).toBe(before)
  })

  it('separates itself from text already in the composer', () => {
    const v = view('write a test')
    show(v, 'for the resampler')
    expect(ghostOf(v)).toBe(' for the resampler')
  })

  it('does not add a separator after existing whitespace', () => {
    const v = view('write a test ')
    show(v, 'for the resampler')
    expect(ghostOf(v)).toBe('for the resampler')
  })

  it('does not lead with a space in an empty composer', () => {
    const v = view()
    show(v, 'hello')
    expect(ghostOf(v)).toBe('hello')
  })

  it('follows the text as it is typed', () => {
    const v = view('one')
    show(v, 'heard')
    v.dispatch({ changes: { from: 3, insert: ' two' } })
    expect(v.state.doc.toString()).toBe('one two')
    expect(ghostOf(v)).toBe(' heard')
  })

  it('clears when dictation stops', () => {
    const v = view('typed')
    show(v, 'heard')
    show(v, '')
    expect(ghostOf(v)).toBeNull()
  })

  it('ignores a transcript that is only whitespace', () => {
    const v = view()
    show(v, '   ')
    expect(ghostOf(v)).toBeNull()
  })

  /** It is a preview, not content: nothing should be able to click or select it. */
  it('is hidden from assistive tech and from the pointer', () => {
    const v = view()
    show(v, 'heard')
    expect(ghostEl(v)!.getAttribute('aria-hidden')).toBe('true')
  })

  /**
   * The gap this closes: recording stops, the model takes a second or two, and
   * the composer used to go blank in between. The words stay put and shimmer
   * until the real transcript replaces them.
   */
  it('shimmers while the model is still working', () => {
    const v = view()
    show(v, 'refactor the ComposerBar', true)
    expect(ghostEl(v)!.className).toContain('nyra-shimmer')
    expect(ghostEl(v)!.textContent).toBe('refactor the ComposerBar')
  })

  it('does not shimmer while still listening', () => {
    const v = view()
    show(v, 'refactor the')
    expect(ghostEl(v)!.className).not.toContain('nyra-shimmer')
  })

  it('keeps the words when listening turns into transcribing', () => {
    const v = view()
    show(v, 'refactor the ComposerBar')
    show(v, 'refactor the ComposerBar', true)
    expect(ghostEl(v)!.textContent).toBe('refactor the ComposerBar')
    expect(ghostEl(v)!.className).toContain('nyra-shimmer')
  })
})
