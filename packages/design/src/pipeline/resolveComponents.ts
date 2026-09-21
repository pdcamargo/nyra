import { resolvedId, type Address } from '../ids'
import { PROPS } from '../registry/props'
import type { PropName } from '../registry/types'
import {
  childrenOf,
  isUseNode,
  type ComponentDef,
  type DesignDocument,
  type DocNode,
  type UseNode
} from '../schema'
import { isMatch, isPropRef, type Match } from '../value'
import { isRun } from '../text'
import { PipelineError, err, type Issue, type ResolvedNode } from './types'

const MAX_DEPTH = 32

/** The properties a `use` instance may carry, merged onto the component root. */
const OUTER_PROPS = new Set<string>(
  (Object.keys(PROPS) as PropName[]).filter((n) => PROPS[n].outer)
)

/**
 * A scope is one component instance: the prop values a `{ prop }` inside it
 * resolves against, plus the identity the nodes it produces are named under.
 *
 * The scope travels *with* the subtree during substitution rather than being
 * applied afterwards. That is the thing slots need: a slotted child is authored
 * in the caller's scope, so namespacing ids at the end would file it under the
 * callee and point an inspector at the wrong node.
 */
type Scope = {
  /** Authored scope name — the artboard id, or the component name. */
  source: string
  /** Instance path from the artboard root: ['save'] or ['card', 'action']. */
  path: string[]
  /** Resolved prop values for `{ prop }` lookups. Empty inside an artboard. */
  props: Record<string, unknown>
}

export function resolveComponents(doc: DesignDocument, artboardId: string): ResolvedNode {
  const artboard = doc.artboards.find((a) => a.id === artboardId)
  if (!artboard) throw new PipelineError(`no artboard "${artboardId}"`, [])

  const issues: Issue[] = []
  const out = resolveNode(
    artboard.root,
    { source: artboard.id, path: [], props: {} },
    doc.components ?? {},
    artboard.id,
    [],
    issues
  )
  if (issues.length > 0) throw new PipelineError(issues[0].message, issues)
  return out
}

function resolveNode(
  node: DocNode,
  scope: Scope,
  components: Record<string, ComponentDef>,
  artboardId: string,
  stack: string[],
  issues: Issue[]
): ResolvedNode {
  if (stack.length > MAX_DEPTH) {
    throw new PipelineError(`component nesting deeper than ${MAX_DEPTH}: ${stack.join(' -> ')}`, [])
  }

  if (isUseNode(node)) return expand(node, scope, components, artboardId, stack, issues)

  const origin: Address = { scope: scope.source, id: node.id }
  const out: Record<string, unknown> = {
    type: node.type,
    id: resolvedId(artboardId, scope.path, node.id),
    origin
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === 'id' || k === 'type' || k === 'children') continue
    if (v === undefined) continue
    const resolvedValue = substituteProp(v, scope, origin, k, issues)
    // `null` is "not set": the key is dropped rather than emitted, so the
    // difference between "absent" and "explicitly absent" never reaches CSS.
    if (resolvedValue === null || resolvedValue === undefined) {
      if (k in PROPS && PROPS[k as PropName].required) {
        issues.push(
          err('required-prop-unset', `"${k}" is required on a ${node.type} but resolved to nothing`, origin)
        )
      }
      continue
    }
    out[k] = resolvedValue
  }

  if (node.type === 'box') {
    out.children = childrenOf(node).map((c) =>
      resolveNode(c, scope, components, artboardId, stack, issues)
    )
  }
  return out as ResolvedNode
}

function expand(
  node: UseNode,
  scope: Scope,
  components: Record<string, ComponentDef>,
  artboardId: string,
  stack: string[],
  issues: Issue[]
): ResolvedNode {
  const origin: Address = { scope: scope.source, id: node.id }
  const def = components[node.use]
  if (!def) {
    issues.push(err('unknown-component', `no component named "${node.use}"`, origin))
    throw new PipelineError(`no component named "${node.use}"`, issues)
  }
  if (stack.includes(node.use)) {
    throw new PipelineError(
      `component "${node.use}" uses itself: ${[...stack, node.use].join(' -> ')}`,
      [err('component-cycle', `component "${node.use}" uses itself`, origin)]
    )
  }

  // The instance's prop values are authored in the *caller's* scope, so they
  // are substituted there before the callee's scope exists.
  const given = node.props ?? {}
  const props: Record<string, unknown> = {}
  for (const [k, d] of Object.entries(def.props ?? {})) {
    props[k] = k in given ? substituteProp(given[k], scope, origin, k, issues) : d.default
  }

  const inner: Scope = {
    source: node.use,
    path: [...scope.path, node.id],
    props
  }

  const root = resolveNode(def.root, inner, components, artboardId, [...stack, node.use], issues)

  // The bounded outer-layout subset, merged onto the resolved root. Not an
  // appearance override: a `use` cannot carry background, padding or font, so
  // an instance can be placed by its parent without being restyled by it.
  const merged: Record<string, unknown> = { ...root }
  for (const [k, v] of Object.entries(node)) {
    if (!OUTER_PROPS.has(k) || v === undefined) continue
    const resolvedValue = substituteProp(v, scope, origin, k, issues)
    if (resolvedValue === null) delete merged[k]
    else merged[k] = resolvedValue
  }
  // The instance keeps the caller's identity, so a patch and a hit test agree
  // on which authored node this is.
  merged.origin = origin
  return merged as ResolvedNode
}

/** Collapses the three value forms to a literal, in one scope. */
function substitute(
  v: unknown,
  scope: Scope,
  at: Address,
  prop: string,
  issues: Issue[],
  depth = 0
): unknown {
  if (depth > MAX_DEPTH) {
    throw new PipelineError(`"${prop}" nests matches deeper than ${MAX_DEPTH}`, [])
  }

  if (isPropRef(v)) {
    if (!(v.prop in scope.props)) {
      issues.push(err('unknown-prop-ref', `"${prop}" references unknown prop "${v.prop}"`, at))
      return undefined
    }
    return scope.props[v.prop]
  }

  if (isMatch(v)) {
    const m = v as Match<unknown>
    const key = substitute(m.match, scope, at, prop, issues, depth + 1)
    const chosen = typeof key === 'string' && key in m.cases ? m.cases[key] : m.default
    if (chosen === undefined) {
      issues.push(
        err('match-no-case', `"${prop}" matched "${String(key)}", which has no case and no default`, at)
      )
      return undefined
    }
    return substitute(chosen, scope, at, prop, issues, depth + 1)
  }

  // A run is an object whose fields are themselves value forms.
  if (isRun(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = substitute(x, scope, at, prop, issues, depth + 1)
    }
    return out
  }

  // Arrays are walked element-wise because mixed text is an array of forms, and
  // because a slot, when it lands, is an array of nodes in exactly this
  // position. Joining happens in `substituteProp` and only for properties the
  // registry marks as lists — `padding: ['$space.2', '$space.4']` is an array
  // that must stay one.
  if (Array.isArray(v)) return v.map((x) => substitute(x, scope, at, prop, issues, depth + 1))

  return v
}

/**
 * A property value in one scope. Only a `list` property collapses; every other
 * array is a tuple the property's own schema defines — `padding: [a, b]` and
 * `gap: [row, col]` must stay arrays.
 *
 * A list collapses to a plain string only when every part is plain. The moment
 * one run carries styling the whole value stays an array of spans, because
 * joining would throw the styling away.
 */
function substituteProp(
  v: unknown,
  scope: Scope,
  at: Address,
  prop: string,
  issues: Issue[]
): unknown {
  const out = substitute(v, scope, at, prop, issues)
  const def = prop in PROPS ? PROPS[prop as PropName] : undefined
  if (!def?.list || !Array.isArray(out)) return out
  return out.every((p) => typeof p === 'string' || typeof p === 'number')
    ? out.join('')
    : out.map((p) => (isRun(p) ? p : { text: String(p) }))
}
