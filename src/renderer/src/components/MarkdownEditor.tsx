import React, { useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import { livePreview } from '../lib/livePreview'
import { composerDecorations } from '../lib/composerDecorations'

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
  // Grey, not blue: blue means "file" now, and inline code is not one.
  {
    tag: t.monospace,
    color: 'var(--foreground)',
    backgroundColor: 'var(--accent)',
    borderRadius: '3px',
    padding: '0.05em 0.3em'
  },
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
  '.cm-selectionMatch': { backgroundColor: 'transparent' },

  // Live preview: what the markdown means, drawn in place of its syntax.
  '.cm-md-h1': { fontSize: '1.5em', fontWeight: '600', lineHeight: '1.3' },
  '.cm-md-h2': { fontSize: '1.3em', fontWeight: '600', lineHeight: '1.35' },
  '.cm-md-h3': { fontSize: '1.15em', fontWeight: '600' },
  '.cm-md-h4': { fontWeight: '600' },
  '.cm-md-h5': { fontWeight: '600', color: 'var(--muted-foreground)' },
  '.cm-md-h6': { fontWeight: '600', color: 'var(--muted-foreground)' },
  '.cm-md-quote': {
    borderLeft: '2px solid var(--border-strong)',
    paddingLeft: '0.75em',
    color: 'var(--muted-foreground)'
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

  // A slash command reads as a command, not as text that happens to start with
  // a slash. Gold rather than the semantic accents: it is a mode, not a status.
  '.cm-command': {
    color: 'var(--warning)',
    fontWeight: '600',
    fontFamily: 'var(--font-mono)'
  },
  '.cm-command-icon': {
    display: 'inline-block',
    width: '0.95em',
    height: '0.95em',
    marginRight: '0.3em',
    verticalAlign: '-0.12em',
    backgroundColor: 'var(--warning)',
    // A terminal chevron, drawn as a mask so it takes the colour above.
    maskImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='4 17 10 11 4 5'/%3E%3Cline x1='12' y1='19' x2='20' y2='19'/%3E%3C/svg%3E\")",
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center'
  },

  // ultrathink gets the CLI's rainbow. Animated so it reads as the same easter
  // egg rather than as an error.
  '.cm-ultrathink': {
    fontWeight: '600',
    backgroundImage:
      'linear-gradient(90deg, #ff6b6b, #ffa94d, #ffd43b, #69db7c, #4dabf7, #b197fc, #ff6b6b)',
    backgroundSize: '200% 100%',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    animation: 'cm-ultrathink-pan 4s linear infinite'
  },
  // An @-mention, collapsed to the filename. Clicking opens the previewer.
  '.cm-file-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25em',
    padding: '0.05em 0.45em',
    borderRadius: '4px',
    backgroundColor: 'color-mix(in oklab, var(--info) 18%, transparent)',
    color: 'var(--info)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    cursor: 'pointer',
    verticalAlign: 'baseline'
  },
  '.cm-file-chip-icon': {
    display: 'inline-block',
    width: '0.85em',
    height: '0.85em',
    backgroundColor: 'currentColor',
    // A document glyph, drawn as a mask so it takes the chip's colour.
    maskImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3C/svg%3E\")",
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center'
  },
  '.cm-file-chip:hover': {
    backgroundColor: 'color-mix(in oklab, var(--info) 28%, transparent)'
  },
  // Something you brought to the conversation, rather than a repo file you
  // pointed at. Warm, so the two never read as the same kind of thing.
  '.cm-attach-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3em',
    padding: '0.05em 0.45em',
    borderRadius: '4px',
    backgroundColor: 'color-mix(in oklab, var(--warning) 18%, transparent)',
    color: 'var(--warning)',
    fontSize: '0.88em',
    whiteSpace: 'nowrap',
    verticalAlign: 'baseline'
  },
  '.cm-attach-chip-icon': {
    display: 'inline-block',
    width: '0.85em',
    height: '0.85em',
    flex: 'none',
    backgroundColor: 'currentColor',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center'
  },
  '.cm-attach-chip-icon-image': {
    maskImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='3' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'/%3E%3C/svg%3E\")"
  },
  '.cm-attach-chip-icon-file': {
    maskImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M13.234 20.252 21 12.3'/%3E%3Cpath d='m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486'/%3E%3C/svg%3E\")"
  },
  '@keyframes cm-ultrathink-pan': {
    '0%': { backgroundPosition: '0% 50%' },
    '100%': { backgroundPosition: '200% 50%' }
  }
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
      keymap.of([...historyKeymap, ...defaultKeymap]),
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(highlightStyle),
      livePreview,
      composerDecorations,
      EditorView.lineWrapping,
      theme,
      EditorView.theme({ '.cm-scroller': { maxHeight: `${maxHeight}px` } }),
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
          }
        })
      ),
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
