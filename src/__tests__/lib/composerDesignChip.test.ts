import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { composerDecorations } from '@renderer/lib/composerDecorations'

/**
 * Which chip the composer actually draws.
 *
 * The earlier test checked `findFileMentions` and `isDesignPath` separately and
 * passed while the composer still drew a blue file chip — because neither of
 * them is what chooses the widget. This mounts the real plugin and looks at the
 * DOM, which is the only thing that would have caught it.
 */
const DESIGN = '/Users/me/.nyra/designs/files/vpn-settings-d_ac7eca37b7.nyui.json'

function composerDom(text: string): HTMLElement {
  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [composerDecorations] }),
    parent: document.body
  })
  // The caret sits at 0; a mention under the caret deliberately stays raw text.
  view.dispatch({ selection: { anchor: text.length } })
  return view.dom
}

beforeEach(() => {
  window.api.design = {
    ...(window.api.design ?? {}),
    list: vi.fn().mockResolvedValue([])
  } as never
})

describe('the composer draws a design mention as a design chip', () => {
  it('uses the pink design chip, not the blue file chip', () => {
    const dom = composerDom(`look at @${DESIGN}#general `)
    expect(dom.querySelector('.nyra-design-chip')).not.toBeNull()
    expect(dom.querySelector('.nyra-design-chip-icon')).not.toBeNull()
    expect(dom.querySelector('.nyra-file-chip')).toBeNull()
  })

  it('still draws an ordinary file as a file chip', () => {
    const dom = composerDom('look at @/Users/me/src/App.tsx ')
    expect(dom.querySelector('.nyra-file-chip')).not.toBeNull()
    expect(dom.querySelector('.nyra-design-chip')).toBeNull()
  })

  it('draws both kinds side by side without confusing them', () => {
    const dom = composerDom(`@${DESIGN}#general and @/Users/me/src/App.tsx done`)
    expect(dom.querySelectorAll('.nyra-design-chip')).toHaveLength(1)
    expect(dom.querySelectorAll('.nyra-file-chip')).toHaveLength(1)
  })

  it('labels the chip with a name rather than the filename and fragment', () => {
    const chip = composerDom(`@${DESIGN}#general `).querySelector('.nyra-design-chip')
    expect(chip?.textContent).not.toContain('.nyui.json')
    expect(chip?.textContent).not.toContain('#general')
    expect(chip?.textContent).toContain('Vpn settings')
  })
})
