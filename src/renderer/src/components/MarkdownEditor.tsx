import React, { useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

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
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted-foreground)' },
  { tag: t.link, color: 'var(--info)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--info)' },
  { tag: t.quote, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: t.monospace, color: 'var(--info)' },
  { tag: t.list, color: 'var(--muted-foreground)' },
  // The markers themselves stay visible for now but recede, so what you typed is
  // still what you see. Hiding them is the live-preview pass.
  { tag: t.processingInstruction, color: 'var(--muted-foreground)', opacity: '0.6' },
  { tag: t.contentSeparator, color: 'var(--muted-foreground)' }
])

const theme = EditorView.theme({
  '&': { color: 'var(--foreground)', backgroundColor: 'transparent', fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    padding: '0',
    fontFamily: 'var(--font-sans)',
    caretColor: 'var(--foreground)',
    lineHeight: '1.6'
  },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.6', overflowY: 'auto' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--info) 30%, transparent)'
  },
  '.cm-selectionMatch': { backgroundColor: 'transparent' }
})

export default function MarkdownEditor({
  ref,
  value,
  onChange,
  onKeyDown,
  placeholder,
  maxHeight = 300
}: {
  ref?: React.Ref<MarkdownEditorHandle>
  value: string
  onChange: (next: string) => void
  onKeyDown?: (event: KeyboardEvent) => void
  placeholder?: string
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

  useEffect(() => {
    if (!hostRef.current) return

    const extensions: Extension[] = [
      history(),
      // Our own handler runs first through domEventHandlers, so these only see
      // keys it did not claim.
      keymap.of([...historyKeymap, ...defaultKeymap]),
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(highlightStyle),
      EditorView.lineWrapping,
      theme,
      EditorView.theme({ '.cm-scroller': { maxHeight: `${maxHeight}px` } }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
      EditorView.domEventHandlers({
        keydown: (event) => {
          onKeyDownRef.current?.(event)
          // Returning true tells CodeMirror the key is spoken for, which is
          // exactly what preventDefault already means for the caller.
          return event.defaultPrevented
        }
      }),
      ...(placeholder ? [cmPlaceholder(placeholder)] : [])
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
    // Built once. `value` is reconciled below; the rest are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxHeight, placeholder])

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
