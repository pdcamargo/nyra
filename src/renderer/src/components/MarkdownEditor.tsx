import React, { useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import { livePreview } from '../lib/livePreview'
import { composerDecorations } from '../lib/composerDecorations'
import { ghostText, setGhostText } from '../lib/ghostText'

/**
 * The surface ChatInput talks to.
 *
 * Deliberately textarea-shaped — `selectionStart`, `setSelectionRange`, `focus` —
 * because the composer's slash and @ autocompletes are built on character
 * offsets, and CodeMirror keeps the same model. Matching the shape is what let
 * the editor swap in without rewriting them.
 */
export type MarkdownEditorHandle = {
  focus: () => void
  readonly selectionStart: number
  readonly selectionEnd: number
  setSelectionRange: (start: number, end: number) => void
  /** Caret x within the editor, for anchoring the mention popup. */
  caretLeft: () => number
  contentDom: HTMLElement | null
}

/**
 * Markdown colouring mapped onto the app's own tokens rather than a stock
 * CodeMirror theme, so the composer reads as part of the app and follows the
 * light/dark swap for free.
 */
const highlightStyle = HighlightStyle.define([
  { tag: t.heading, color: 'var(--foreground)', fontWeight: '600' },
  { tag: t.strong, color: 'var(--foreground)', fontWeight: '600' },
  { tag: t.emphasis, color: 'var(--foreground)', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--info)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--info)' },
  { tag: t.quote, fontStyle: 'italic' },
  // Grey, not blue: blue means "file" now, and inline code is not one.
  {
    tag: t.monospace,
    color: 'var(--foreground)',
    backgroundColor: 'var(--accent)',
    borderRadius: '3px',
    padding: '0.05em 0.3em'
  },
  // Not muted. In @lezer/markdown the rule is `"OrderedList/... BulletList/...":
  // tags.list`, and that `/...` means the node *and every descendant* — so a
  // muted colour here dimmed the whole bullet, text included, not just the `-`.
  // Nothing you type into the composer is metadata.
  { tag: t.list, color: 'var(--foreground)' },
  // The markers stay visible so what you typed is still what you see. Hiding
  // them is the live-preview pass, which leaves ListMark alone on purpose.
  { tag: t.processingInstruction, color: 'var(--foreground)' },
  { tag: t.contentSeparator, color: 'var(--foreground)' }
])

const theme = EditorView.theme({
  // The same three variables the message list reads: what you type should look
  // like what it becomes. It was a hardcoded 14px against the list's 15px.
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'transparent',
    fontSize: 'var(--content-font-size, 15px)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    padding: '0',
    fontFamily: 'var(--font-content)',
    fontWeight: 'var(--content-font-weight, 400)',
    caretColor: 'var(--foreground)',
    lineHeight: '1.6'
  },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { fontFamily: 'var(--font-content)', lineHeight: '1.6', overflowY: 'auto' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--info) 30%, transparent)'
  },
  '.cm-selectionMatch': { backgroundColor: 'transparent' },

  // Live preview: what the markdown means, drawn in place of its syntax.
  '.cm-md-h1': { fontSize: '1.5em', fontWeight: '600', lineHeight: '1.3' },
  '.cm-md-h2': { fontSize: '1.3em', fontWeight: '600', lineHeight: '1.35' },
  '.cm-md-h3': { fontSize: '1.15em', fontWeight: '600' },
  '.cm-md-h4': { fontWeight: '600' },
  '.cm-md-h5': { fontWeight: '600' },
  '.cm-md-h6': { fontWeight: '600' },
  // The rule and the indent say "quote"; the colour does not have to, and when
  // it did the text was harder to read than the message it would become.
  '.cm-md-quote': {
    borderLeft: '2px solid var(--border-strong)',
    paddingLeft: '0.75em'
  },
  '.cm-md-codeinfo': {
    fontSize: '0.8em',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--muted-foreground)'
  },
  '.cm-md-code': {
    backgroundColor: 'var(--background)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em'
  },

  // The composer chips — a slash command, ultrathink, an @-mention, an
  // attachment — are not styled here. A CodeMirror theme scopes every rule
  // under the editor, and the transcript draws the same chips now, so they
  // live in index.css where both surfaces can read them.
})

export default function MarkdownEditor({
  ref,
  value,
  onChange,
  onKeyDown,
  onPaste,
  placeholder,
  ghost,
  ghostSettling = false,
  maxHeight = 300
}: {
  ref?: React.Ref<MarkdownEditorHandle>
  value: string
  onChange: (next: string) => void
  onKeyDown?: (event: KeyboardEvent) => void
  onPaste?: (event: ClipboardEvent) => void
  placeholder?: string
  /** Provisional text drawn after the caret, for dictation. Never enters the
   *  document, so it cannot be edited, undone, or sent by accident. */
  ghost?: string
  /** Shimmer it: the words are final but the model is still deciding. */
  ghostSettling?: boolean
  maxHeight?: number
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Held in refs so the editor is built once: rebuilding it on every render
  // would lose the cursor and the undo history.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onKeyDownRef = useRef(onKeyDown)
  onKeyDownRef.current = onKeyDown
  const onPasteRef = useRef(onPaste)
  onPasteRef.current = onPaste
  // Reconfigured rather than rebuilt. `placeholder` changes whenever a turn
  // starts or ends, and it used to be a dependency of the effect below — so the
  // EditorView was destroyed and recreated at every turn boundary, losing the
  // undo history, the focus and the caret, and leaving anything that had bound a
  // listener to contentDOM pointing at a detached node.
  const placeholderComp = useRef(new Compartment()).current
  const maxHeightComp = useRef(new Compartment()).current

  useEffect(() => {
    if (!hostRef.current) return

    const extensions: Extension[] = [
      history(),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(highlightStyle),
      livePreview,
      composerDecorations,
      ghostText,
      EditorView.lineWrapping,
      // CodeMirror turns the platform's text checking off on its content
      // element — sensible for code, wrong for this: both places this editor
      // renders hold prose you are about to send someone. Spelling only;
      // autocorrect and autocapitalise stay off, because they rewrite what you
      // typed, and what you type here is full of identifiers and paths that
      // look to them like mistakes.
      EditorView.contentAttributes.of({ spellcheck: 'true' }),
      theme,
      maxHeightComp.of(EditorView.theme({ '.cm-scroller': { maxHeight: `${maxHeight}px` } })),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
      // Highest precedence, or the default keymap gets Enter first and inserts a
      // newline before the composer ever sees it — Enter then both broke the line
      // and sent the message.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event) => {
            onKeyDownRef.current?.(event)
            // Returning true tells CodeMirror the key is spoken for, which is
            // exactly what preventDefault already means for the caller.
            return event.defaultPrevented
          },
          // Paste belongs to the editor rather than to a listener ChatInput
          // attaches to contentDOM: the handler survives whatever happens to the
          // DOM node, which the listener did not.
          paste: (event) => {
            onPasteRef.current?.(event)
            return event.defaultPrevented
          }
        })
      ),
      placeholderComp.of(placeholder ? cmPlaceholder(placeholder) : [])
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Built once, for real. `value` is reconciled below, `placeholder` and
    // `maxHeight` through their compartments, the rest through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // The ghost wins while it is showing: both render on an empty document,
    // and "Message Claude…" printed underneath a live transcript reads as a
    // bug rather than as two features.
    const shown = ghost ? '' : placeholder
    viewRef.current?.dispatch({
      effects: placeholderComp.reconfigure(shown ? cmPlaceholder(shown) : [])
    })
  }, [placeholder, ghost, placeholderComp])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: setGhostText.of({ text: ghost ?? '', settling: ghostSettling })
    })
  }, [ghost, ghostSettling])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: maxHeightComp.reconfigure(
        EditorView.theme({ '.cm-scroller': { maxHeight: `${maxHeight}px` } })
      )
    })
  }, [maxHeight, maxHeightComp])

  // Reconcile the controlled value, skipping the echo of our own edits.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(value.length, view.state.selection.main.anchor) }
    })
  }, [value])

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      focus: () => viewRef.current?.focus(),
      get selectionStart() {
        return viewRef.current?.state.selection.main.from ?? 0
      },
      get selectionEnd() {
        return viewRef.current?.state.selection.main.to ?? 0
      },
      setSelectionRange: (start, end) => {
        const view = viewRef.current
        if (!view) return
        const max = view.state.doc.length
        view.dispatch({
          selection: { anchor: Math.min(start, max), head: Math.min(end, max) }
        })
      },
      caretLeft: () => {
        const view = viewRef.current
        if (!view) return 0
        const coords = view.coordsAtPos(view.state.selection.main.head)
        if (!coords) return 0
        return coords.left - view.contentDOM.getBoundingClientRect().left
      },
      get contentDom() {
        return viewRef.current?.contentDOM ?? null
      }
    }),
    []
  )

  return <div ref={hostRef} className="w-full" />
}
