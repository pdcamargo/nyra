import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { composerDecorations } from '@renderer/lib/composerDecorations'

/**
 * The decoration plugin against a real EditorView.
 *
 * jsdom does not lay text out, but CodeMirror still builds and applies
 * decorations — which is the part that was wrong: a pasted attachment stayed as
 * raw `[Image: …]` markdown until you broke the line.
 */
let view: EditorView | null = null

function mount(doc: string, caret: number): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [composerDecorations]
    }),
    parent
  })
  return view
}

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

const chips = (v: EditorView): number => v.dom.querySelectorAll('.cm-attach-chip').length
const fileChips = (v: EditorView): number => v.dom.querySelectorAll('.cm-file-chip').length

describe('attachment chips', () => {
  // The exact case from the bug report: paste puts the marker in at the caret,
  // so the caret is always on that line. Under the old line-granularity rule the
  // chip only appeared once you pressed Enter.
  it('is a chip the moment it is pasted, with the caret right after it', () => {
    const doc = 'look [Image: /tmp/a.png] '
    const v = mount(doc, doc.length)
    expect(chips(v)).toBe(1)
    expect(v.dom.textContent).not.toContain('/tmp/a.png')
  })

  it('stays a chip with the caret inside the marker', () => {
    const doc = '[Image: /tmp/a.png]'
    expect(chips(mount(doc, 10))).toBe(1)
  })

  it('chips every attachment in the draft', () => {
    const doc = '[Image: /tmp/a.png] and [File: notes.pdf]'
    expect(chips(mount(doc, doc.length))).toBe(2)
  })

  it('treats a chip as one unit for the caret', () => {
    const doc = 'x [Image: /tmp/a.png] y'
    const v = mount(doc, doc.length)
    // Backspace-style: move the caret left off the trailing text and into the
    // chip. atomicRanges makes it skip the whole marker rather than land inside.
    v.dispatch({ selection: { anchor: 20 } })
    expect(v.state.selection.main.anchor).not.toBeGreaterThan(20)
    expect(chips(v)).toBe(1)
  })
})

describe('@file mentions', () => {
  it('is a chip when the caret is elsewhere', () => {
    const doc = 'see @src/App.tsx now'
    expect(fileChips(mount(doc, 0))).toBe(1)
  })

  // Inclusive edges: the caret sits at the end of what you have typed so far,
  // and collapsing the mention there would take the word out from under you.
  it('stays editable text while you are typing it', () => {
    const doc = 'see @src/App'
    const v = mount(doc, doc.length)
    expect(fileChips(v)).toBe(0)
    expect(v.dom.textContent).toContain('@src/App')
  })

  it('becomes a chip once the caret leaves it, without needing a new line', () => {
    const doc = 'see @src/App.tsx now'
    expect(fileChips(mount(doc, doc.length))).toBe(1)
  })
})
