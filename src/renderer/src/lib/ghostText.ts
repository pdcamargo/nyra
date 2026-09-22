import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

/**
 * Provisional text drawn in the composer without being in it.
 *
 * Dictation needs to show what it has heard so far, and the obvious way —
 * writing it into the editor's value and replacing it later — is the wrong
 * one. The editor is controlled: live-replacing its contents clobbers anything
 * typed mid-sentence, fills the undo history with half-sentences, and moves
 * the caret out from under whoever is editing.
 *
 * A widget decoration has none of those problems, because it never touches the
 * document. Nothing to undo, nothing to clobber, and the caret stays put. The
 * real transcript arrives through the ordinary prefill path once the model has
 * had the whole recording to think about, and it replaces this outright —
 * which is why it is fine for the two to disagree while you are still talking.
 */
export type Ghost = {
  text: string
  /** Recording has stopped and the model is producing the real transcript.
   *  The preview shimmers rather than vanishing, so the composer is never
   *  blank between the last word spoken and the text arriving. */
  settling: boolean
}

export const setGhostText = StateEffect.define<Ghost>()

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly settling: boolean
  ) {
    super()
  }

  /** Without this the span is torn down and rebuilt on every keystroke, which
   *  restarts the shimmer from the beginning each time. */
  eq(other: GhostWidget): boolean {
    return other.text === this.text && other.settling === this.settling
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.settling ? 'cm-ghost-text nyra-shimmer' : 'cm-ghost-text'
    span.setAttribute('aria-hidden', 'true')
    span.textContent = this.text
    return span
  }
}

const EMPTY: Ghost = { text: '', settling: false }

const ghostTextField = StateField.define<Ghost>({
  create: () => EMPTY,
  update(ghost, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhostText)) return effect.value
    }
    return ghost
  }
})

/** Recomputed when the ghost changes *or* the document does, so it stays glued
 *  to the end of whatever has been typed. */
const ghostDecorations = EditorView.decorations.compute([ghostTextField, 'doc'], (state) => {
  const ghost = state.field(ghostTextField)
  const text = ghost.text.trim()
  if (!text) return Decoration.none

  const end = state.doc.length
  // Same separator rule the finished transcript uses when it is appended, so
  // the preview sits where the real text will land.
  const previous = end > 0 ? state.doc.sliceString(end - 1, end) : ''
  const lead = end > 0 && !/\s/.test(previous) ? ' ' : ''

  return Decoration.set([
    Decoration.widget({ widget: new GhostWidget(lead + text, ghost.settling), side: 1 }).range(end)
  ])
})

export const ghostText: Extension = [ghostTextField, ghostDecorations]
