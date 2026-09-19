import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { HighlightStyle, StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import type { Extension } from '@codemirror/state'
import { linter, type Diagnostic } from '@codemirror/lint'
import { tags as t } from '@lezer/highlight'
import { templateSpans, scopeSpans, type FlowVariable } from './flowVariables'
import { expressionProblems } from './expressionLint'

/**
 * Colouring for the flow inspector's prompt and expression fields.
 *
 * Lives here rather than beside `VariableField` because a component module that
 * also exports non-components opts out of React Fast Refresh — editing the
 * colour of a keyword would full-reload the app instead of hot-swapping.
 */

/**
 * JavaScript colouring for the expression fields, on the app's own tokens
 * rather than a stock CodeMirror theme, so it follows the light/dark swap.
 *
 * One accent only. `--success` marks literals — the values you typed — and
 * everything structural stays grey, because the field already spends `--info`
 * on "this name resolves" and `--warning` on "this one does not". A third and
 * fourth colour here would compete with the two that carry meaning.
 */
export const jsHighlight = HighlightStyle.define([
  // Literals — the values you typed, as opposed to the names you referenced.
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--success)' },

  // The logic skeleton. `&&`, `||` and `<` are what make a condition a
  // condition, so they are emphasised rather than dimmed — the first version
  // of this painted them `--muted-foreground`, which de-emphasised the most
  // load-bearing characters in the field and left it looking unstyled.
  {
    tag: [t.operator, t.logicOperator, t.compareOperator, t.arithmeticOperator],
    color: 'var(--foreground)',
    fontWeight: '600'
  },
  { tag: t.keyword, color: 'var(--foreground)', fontWeight: '600' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: 'var(--foreground)',
    fontWeight: '600'
  },

  // Scaffolding. Dimming brackets is what makes the rest read.
  {
    tag: [t.punctuation, t.separator, t.paren, t.brace, t.squareBracket],
    color: 'var(--muted-foreground)'
  },

  { tag: [t.propertyName, t.variableName], color: 'var(--foreground)' },
  { tag: t.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--danger)' }
])

/** Reports what the engine would silently swallow. */
export const expressionLinter = linter((view): Diagnostic[] =>
  expressionProblems(view.state).map((p) => ({
    from: p.from,
    to: p.to,
    severity: 'error',
    message: p.message
  }))
)

const knownMark = Decoration.mark({ class: 'nyra-var-known' })
const unknownMark = Decoration.mark({ class: 'nyra-var-unknown' })
// A separate class from the template marks. CodeMirror splits a mark
// wherever another decoration starts, so with the grammar running `vars.score`
// becomes three spans — and a chip with horizontal padding then draws three
// chips with gaps between them. Colour alone survives being split.
const builtinMark = Decoration.mark({ class: 'nyra-var-scope' })

/** `{{ … }}` spans, colour-split by whether the name resolves. */
export function templateHighlighter(getVars: () => FlowVariable[]): Extension {
  const build = (view: EditorView): DecorationSet => {
    const text = view.state.doc.toString()
    const marks = templateSpans(text, getVars()).map((s) =>
      (s.known ? knownMark : unknownMark).range(s.from, s.to)
    )
    return Decoration.set(marks, true)
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => (v as { decorations: DecorationSet }).decorations }
  )
}

/**
 * The three in-scope identifiers, plus whatever is read off `vars`.
 *
 * Only `vars` takes a dotted path. `vars.score` is one reference and colouring
 * just the `vars` half left the part that names the value looking like plain
 * text. `output` and `iteration` are a string and a number, so what follows a
 * dot on them is a method — `output.includes` is a call, not a variable, and
 * marking it as one overstated what is in scope.
 */
export function expressionHighlighter(): Extension {
  const build = (view: EditorView): DecorationSet =>
    Decoration.set(
      scopeSpans(view.state.doc.toString()).map((s) => builtinMark.range(s.from, s.to)),
      true
    )
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => (v as { decorations: DecorationSet }).decorations }
  )
}

/**
 * Shell colouring for a `script` node's command.
 *
 * `@codemirror/legacy-modes` rather than a Lezer grammar because there is no
 * first-party shell grammar, and a stream parser is more than enough for the
 * one-liners these nodes hold — `npm test`, `git diff --stat`, a pipeline.
 *
 * Shares `jsHighlight`: both are code, and a second palette for the same tokens
 * would mean a string looked like one thing in a condition and another in a
 * command.
 */
export const shellLanguage = StreamLanguage.define(shell)
