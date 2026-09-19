import React, { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { type FlowVariable } from '../lib/flowVariables'
import {
  jsHighlight,
  expressionHighlighter,
  templateHighlighter,
  expressionLinter,
  shellLanguage
} from '../lib/flowHighlight'

/**
 * The prompt and expression fields in the flow inspector.
 *
 * Both are plain text that secretly references things declared elsewhere —
 * `{{vars.security_report}}` names a capture typed into another node's panel,
 * and a condition reads `output` and `iteration` with nothing on screen saying
 * so. A bare textarea gives no help with either: a typo looks identical to a
 * working reference until the run quietly produces an empty string.
 *
 * CodeMirror rather than a textarea because the app already bundles it for the
 * composer, and it brings the two things that actually help — colour for what
 * resolves, and a completion list of what exists.
 */

/**
 * `template` — a prompt: plain text with `{{ }}` references.
 * `expression` — a condition: JavaScript, no `{{ }}`.
 * `shell` — a script command: a shell line that *also* takes `{{ }}`.
 */
export type VariableFieldMode = 'template' | 'expression' | 'shell'

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--sidebar)',
    color: 'var(--foreground)',
    borderRadius: 'calc(var(--radius) - 2px)',
    border: '1px solid var(--border)',
    fontSize: '0.85em'
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--border-strong)' },
  '.cm-content': {
    padding: '6px 10px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '1.6'
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent)'
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)', opacity: '0.7' },
  '.cm-scroller': { overflow: 'auto' },
  // The completion popup, in the app's own tokens rather than CodeMirror's.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 'calc(var(--radius) - 2px)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    overflow: 'hidden'
  },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 8px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    color: 'var(--foreground)'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)'
  },
  '.cm-completionDetail': {
    marginLeft: '0.75em',
    fontStyle: 'normal',
    fontFamily: 'var(--font-sans, system-ui)',
    color: 'var(--muted-foreground)'
  }
})

/**
 * Completions.
 *
 * In a template the useful trigger is `{{`, and the replacement covers whatever
 * of the braces is already typed so accepting never leaves `{{{{vars.x}}`. In an
 * expression it is a bare word.
 */
function completions(mode: VariableFieldMode, getVars: () => FlowVariable[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const vars = getVars()
    if (vars.length === 0) return null

    if (mode !== 'expression') {
      // Anything from an opening `{{` up to the caret, with no closing brace in
      // between. `explicit` lets ctrl-space offer the list before `{{` is typed.
      const open = ctx.matchBefore(/\{\{[^{}]*/)
      if (!open) {
        if (!ctx.explicit) return null
        return {
          from: ctx.pos,
          options: vars.map((v) => ({
            label: `{{${v.insert}}}`,
            detail: v.detail,
            apply: `{{${v.insert}}}`
          }))
        }
      }
      return {
        from: open.from,
        options: vars.map((v) => ({
          label: `{{${v.insert}}}`,
          detail: v.detail,
          // Close the braces only if the document has not already got them,
          // which happens when completing inside an existing `{{}}`.
          apply: (view, _c, from, to) => {
            const after = view.state.sliceDoc(to, to + 2)
            const closing = after === '}}' ? '' : '}}'
            const text = `{{${v.insert}${closing}`
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length + (closing ? 0 : 2) }
            })
          }
        }))
      }
    }

    const word = ctx.matchBefore(/[\w.]+/)
    if (!word && !ctx.explicit) return null
    return {
      from: word ? word.from : ctx.pos,
      options: vars.map((v) => ({ label: v.insert, detail: v.detail, apply: v.insert }))
    }
  }
}

export function VariableField({
  value,
  onChange,
  variables,
  mode,
  disabled = false,
  placeholder,
  minHeight = 96,
  maxHeight,
  resizable = false,
  autoGrow = false,
  ariaLabel
}: {
  value: string
  onChange: (next: string) => void
  variables: FlowVariable[]
  mode: VariableFieldMode
  disabled?: boolean
  placeholder?: string
  minHeight?: number
  /** Ceiling for `autoGrow`. Past it the field scrolls instead. */
  maxHeight?: number
  /** Drag the bottom edge. Worth it for a prompt, noise on a one-line field. */
  resizable?: boolean
  /**
   * Follow the content between `minHeight` and `maxHeight`.
   *
   * A condition is usually one line and occasionally four, and a fixed box is
   * wrong for both — too tall while you are writing `true`, too short the
   * moment it becomes a real expression.
   */
  autoGrow?: boolean
  ariaLabel?: string
}): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())

  // Read through a ref so the extensions are built once: rebuilding them on
  // every keystroke would drop the completion popup mid-selection.
  const varsRef = useRef(variables)
  varsRef.current = variables
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!host.current) return
    const getVars = (): FlowVariable[] => varsRef.current

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          theme,
          // The grammar first, then the reference marks on top of it, so a
          // `{{ }}` or an `output` keeps its own colour rather than taking the
          // grammar's for that token.
          ...(mode === 'expression'
            ? [
                javascript(),
                syntaxHighlighting(jsHighlight),
                bracketMatching(),
                expressionLinter,
                expressionHighlighter()
              ]
            : mode === 'shell'
              ? [
                  shellLanguage,
                  syntaxHighlighting(jsHighlight),
                  bracketMatching(),
                  templateHighlighter(getVars)
                ]
              : [templateHighlighter(getVars)]),
          autocompletion({
            override: [completions(mode, getVars)],
            icons: false,
            // The list is short and entirely relevant; making it earn its place
            // with a prefix match would hide it exactly when it is most useful.
            activateOnTyping: true
          }),
          placeholder ? cmPlaceholder(placeholder) : [],
          editable.current.of(EditorView.editable.of(!disabled)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
            // `geometryChanged` and not just `docChanged`: wrapping a long line
            // adds a row without changing the document, and resizing the
            // inspector rewraps everything in it.
            if (autoGrow && host.current && (u.docChanged || u.geometryChanged)) {
              const ceiling = maxHeight ?? minHeight * 3
              const wanted = Math.min(Math.max(u.view.contentHeight + 2, minHeight), ceiling)
              host.current.style.height = `${Math.ceil(wanted)}px`
            }
          })
        ]
      })
    })
    view.current = v
    if (ariaLabel) v.contentDOM.setAttribute('aria-label', ariaLabel)
    return () => {
      v.destroy()
      view.current = null
    }
    // Built once. `value` is synced by the effect below; rebuilding here would
    // destroy the editor on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Outside edits — switching nodes, or Arrange rewriting the flow — have to
  // land in the editor, but echoing our own change back would move the caret.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!disabled))
    })
  }, [disabled])

  return (
    <div
      ref={host}
      data-slot="variable-field"
      className={`nyra-variable-field ${disabled ? 'opacity-50' : ''}`}
      style={{
        minHeight,
        maxHeight: autoGrow ? (maxHeight ?? minHeight * 3) : resizable ? undefined : minHeight * 3,
        ...(autoGrow ? { height: minHeight, overflow: 'hidden' } : {}),
        ...(resizable && !autoGrow
          ? { resize: 'vertical', overflow: 'hidden', height: minHeight }
          : {})
      }}
    />
  )
}
