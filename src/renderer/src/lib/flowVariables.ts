import type { WorkflowDefinition } from '@shared/workflow-types'

/**
 * Something you can reference from a prompt or an expression.
 *
 * A flow's variables are scattered — inputs live on the flow, captured vars are
 * declared by `setVars` on whichever prompt node produced them, and `prev` is
 * implicit. Writing `{{vars.security_report}}` correctly meant remembering a
 * name typed into a different node's panel. This gathers them so the field can
 * offer them instead.
 */
export type FlowVariable = {
  /** Inserted at the caret, e.g. `vars.score` or `prev.output`. */
  insert: string
  /** The kind, for grouping and for the detail column. */
  source: 'previous' | 'input' | 'captured' | 'builtin'
  /** Where it comes from, in words. */
  detail: string
}

/** Names a capture can legally use, mirroring the input's own sanitising. */
const VALID_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Every `vars.*` the flow declares, in node order.
 *
 * Deliberately every node rather than only the ones upstream of the caret. A
 * flow is edited out of order — you wire the capture after writing the prompt
 * that reads it as often as before — and offering a name that is not reachable
 * yet is a smaller problem than hiding one that is.
 */
function capturedVars(wf: WorkflowDefinition): FlowVariable[] {
  const out: FlowVariable[] = []
  const seen = new Set<string>()
  for (const node of wf.nodes ?? []) {
    if (node.data?.type !== 'prompt') continue
    for (const sv of node.data.setVars ?? []) {
      if (!sv.name || seen.has(sv.name) || !VALID_NAME.test(sv.name)) continue
      seen.add(sv.name)
      out.push({
        insert: `vars.${sv.name}`,
        source: 'captured',
        detail: `captured by ${node.label || node.id}`
      })
    }
  }
  return out
}

function inputVars(wf: WorkflowDefinition): FlowVariable[] {
  const seen = new Set<string>()
  return (wf.inputs ?? [])
    .filter((i) => {
      if (!i.key || seen.has(i.key)) return false
      seen.add(i.key)
      return true
    })
    .map((i) => ({
      insert: `input.${i.key}`,
      source: 'input' as const,
      detail: i.label || 'flow input'
    }))
}

/**
 * What can go inside `{{ }}` in a prompt, a script or an input mapping.
 */
export function templateVariables(wf: WorkflowDefinition | null): FlowVariable[] {
  if (!wf) return []
  return [
    { insert: 'prev.output', source: 'previous', detail: 'output of the node before this one' },
    ...inputVars(wf),
    ...capturedVars(wf)
  ]
}

/**
 * What is in scope in a `condition` or `loop` expression.
 *
 * Not the same list as a template's. An expression is JavaScript over bare
 * identifiers — `output`, not `{{prev.output}}` — and it gets `iteration`,
 * which only means anything inside a loop.
 */
export function expressionVariables(wf: WorkflowDefinition | null): FlowVariable[] {
  const captured = (wf ? capturedVars(wf) : []).map((v) => ({ ...v, source: 'captured' as const }))
  return [
    { insert: 'output', source: 'builtin', detail: 'output of the node before this one' },
    { insert: 'vars', source: 'builtin', detail: 'every captured variable, as an object' },
    { insert: 'iteration', source: 'builtin', detail: 'loop pass, starting at 1' },
    ...captured
  ]
}

/**
 * The `{{ … }}` spans in a string, with whether each names something real.
 *
 * Used to colour a prompt: a known reference reads as a value, an unknown one
 * as a typo. `{{vars.scor}}` is otherwise indistinguishable from a working
 * reference until the run produces an empty string.
 */
export function templateSpans(
  text: string,
  known: FlowVariable[]
): { from: number; to: number; name: string; known: boolean }[] {
  const names = new Set(known.map((v) => v.insert))
  const spans: { from: number; to: number; name: string; known: boolean }[] = []
  const re = /\{\{\s*([^{}]*?)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    spans.push({
      from: m.index,
      to: m.index + m[0].length,
      name,
      // `vars` alone is legal and resolves to the whole object, so a bare
      // prefix counts as known rather than being flagged mid-typing.
      known: names.has(name) || name === 'vars' || name === 'input' || name === 'prev'
    })
  }
  return spans
}

/**
 * The in-scope identifiers in an expression, as ranges.
 *
 * Only `vars` takes a dotted path. `output` is a string and `iteration` a
 * number, so what follows a dot on either is a method — `output.includes` is a
 * call, and colouring it as a variable reference claimed something about scope
 * that is not true.
 */
export function scopeSpans(text: string): { from: number; to: number; name: string }[] {
  // `\bvars\b` and not `\bvars`: without the trailing boundary the optional
  // path matches zero times and `varsity` reports a `vars` reference.
  const re = /\bvars\b(?:\.[A-Za-z_$][\w$]*)*|\b(?:output|iteration)\b/g
  const out: { from: number; to: number; name: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ from: m.index, to: m.index + m[0].length, name: m[0] })
  }
  return out
}

/** A `vars.*` the flow declares, and where it comes from. */
export type DeclaredVar = {
  name: string
  nodeId: string
  nodeLabel: string
  /** `raw`, `json`, `regex` or `lines` — how the value is pulled from output. */
  kind: string
}

/**
 * Every variable this flow captures, whether or not it has ever run.
 *
 * The variables panel used to render only `execution.vars`, which exist solely
 * during a run — so outside one it said "No variables set yet" and offered
 * nothing to do, which is not a panel, it is a blank. What someone actually
 * wants there is the flow's own vocabulary: what it captures, which node does
 * it, and what the value was last time.
 */
export function declaredVars(wf: WorkflowDefinition | null): DeclaredVar[] {
  if (!wf) return []
  const out: DeclaredVar[] = []
  const seen = new Set<string>()
  for (const node of wf.nodes ?? []) {
    if (node.data?.type !== 'prompt') continue
    for (const sv of node.data.setVars ?? []) {
      if (!sv.name || seen.has(sv.name) || !VALID_NAME.test(sv.name)) continue
      seen.add(sv.name)
      const raw = sv.extractor ?? ''
      const kind = raw.startsWith('json:')
        ? 'json'
        : raw.startsWith('regex:')
          ? 'regex'
          : raw.startsWith('lines:')
            ? 'lines'
            : 'raw'
      out.push({ name: sv.name, nodeId: node.id, nodeLabel: node.label || node.id, kind })
    }
  }
  return out
}
