import { syntaxTree } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState } from '@codemirror/state'

export type ExpressionProblem = { from: number; to: number; message: string }

/**
 * The engine's wrapper, verbatim from `evaluate_condition` in
 * `workflow/helpers.rs`:
 *
 * ```rust
 * "(function(output, vars, iteration) {{ return Boolean({expression}); }})(…)"
 * ```
 *
 * One line, and the expression lands in an argument position. Checking the
 * expression on its own gets this wrong in both directions — a leading comment
 * parses fine alone and also fine here, while `true // ok` parses fine alone and
 * comments out the `); }})` that follows it. So the check parses what the engine
 * actually builds.
 */
const PREFIX = '(function(output, vars, iteration) { return Boolean('
const SUFFIX = '); })("", {}, 1)'

/** Error ranges in a document, as the JavaScript grammar sees it. */
function parseErrors(doc: string): { from: number; to: number }[] {
  const state = EditorState.create({ doc, extensions: [javascript()] })
  const out: { from: number; to: number }[] = []
  syntaxTree(state)
    .cursor()
    .iterate((node) => {
      if (node.type.isError) out.push({ from: node.from, to: Math.max(node.to, node.from + 1) })
    })
  return out
}

/** A `//` comment that runs to the end of the text, taking the rest with it. */
function trailingLineComment(doc: string): { from: number; to: number } | null {
  const state = EditorState.create({ doc, extensions: [javascript()] })
  let found: { from: number; to: number } | null = null
  syntaxTree(state)
    .cursor()
    .iterate((node) => {
      if (node.name !== 'LineComment') return
      // Anything after it on a later line survives; only the last one matters.
      if (doc.slice(node.to).trim() === '') found = { from: node.from, to: node.to }
    })
  return found
}

/**
 * What is wrong with a `condition` or `loop` expression, if anything.
 *
 * This exists because of one line in the engine:
 *
 * ```rust
 * Err(_) => false,
 * ```
 *
 * An expression that fails to parse is not an error — it is `false`. The branch
 * silently never runs, the loop silently never repeats, and nothing anywhere
 * says why. This field is the only place that mistake can surface.
 *
 * Checked by parsing rather than by `new Function`, which would be the obvious
 * way and does not work: the app ships a CSP without `'unsafe-eval'`, so
 * constructing a function throws in the packaged build while passing in tests.
 */
export function expressionProblems(state: EditorState): ExpressionProblem[] {
  const text = state.doc.toString()
  const trimmed = text.trim()

  // `Boolean()` is legal and false — a fair "not filled in yet" rather than a
  // mistake to shout about under a blank field.
  if (trimmed === '') return []

  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length))

  // Statement keywords parse cleanly on their own and break the moment they are
  // put in an argument position. Worth naming, because the wrapper makes
  // `return` in particular look reasonable.
  const kw = /^(const|let|var|if|return|for|while|do|function|class|switch|throw)\b/.exec(trimmed)
  if (kw) {
    const at = text.indexOf(kw[1])
    return [
      {
        from: clamp(at),
        to: clamp(at + kw[1].length),
        message: `\`${kw[1]}\` cannot go here. This has to be one expression that evaluates to true or false — try combining with && and ||.`
      }
    ]
  }

  // Looks harmless, always false: `Boolean(true;)` does not parse.
  if (trimmed.endsWith(';')) {
    const at = text.lastIndexOf(';')
    return [
      {
        from: clamp(at),
        to: clamp(at + 1),
        message: 'Drop the semicolon. This is an expression, not a statement.'
      }
    ]
  }

  // The engine builds one line, so a comment at the end swallows the code that
  // follows it. The expression looks perfectly fine on its own, which is
  // exactly why this is worth its own message.
  const tail = trailingLineComment(text)
  if (tail) {
    return [
      {
        from: clamp(tail.from),
        to: clamp(tail.to),
        message:
          'A // comment at the end comments out the rest of the line when this runs, so the condition is always false. Use /* … */ instead.'
      }
    ]
  }

  // Everything else: parse exactly what the engine will.
  const errors = parseErrors(PREFIX + text + SUFFIX)
  if (errors.length === 0) return []

  const first = errors[0]
  return [
    {
      from: clamp(first.from - PREFIX.length),
      to: Math.max(clamp(first.to - PREFIX.length), clamp(first.from - PREFIX.length) + 1),
      message: 'This is not a valid expression, so the condition is always false.'
    }
  ]
}
