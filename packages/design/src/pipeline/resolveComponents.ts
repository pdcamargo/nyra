import { resolvedId, type Address } from '../ids'
import { PROPS } from '../registry/props'
import type { PropName } from '../registry/types'
import { isSlotRef, isUseNode, type Child, type DesignDocument, type DocNode, type UseNode } from '../schema'
import { isMatch, isPropRef, type Match } from '../value'
import { isRun } from '../text'
import { definedIn, localRegistry, type Registry } from './registry'
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
  /** The file `source` is written in, when there is more than one file. */
  file?: string
  /** Instance path from the artboard root: ['save'] or ['card', 'action']. */
  path: string[]
  /** Resolved prop values for `{ prop }` lookups. Empty inside an artboard. */
  props: Record<string, unknown>
  /** What the caller passed for each slot, captured with the caller's own
   *  scope and component stack — slotted nodes resolve *there*, not here. */
  slots: Record<string, SlotFill>
}

type SlotFill = { items: Child[]; scope: Scope; stack: string[] }

type Ctx = { registry: Registry; artboardId: string; issues: Issue[] }

const addressIn = (scope: Scope, id: string): Address =>
  scope.file === undefined ? { scope: scope.source, id } : { scope: scope.source, id, file: scope.file }

export function resolveComponents(
  doc: DesignDocument,
  artboardId: string,
  options: { registry?: Registry; file?: string } = {}
): ResolvedNode {
  const artboard = doc.artboards.find((a) => a.id === artboardId)
  if (!artboard) throw new PipelineError(`no artboard "${artboardId}"`, [])

  const ctx: Ctx = { registry: options.registry ?? localRegistry(doc), artboardId: artboard.id, issues: [] }
  const top: Scope = { source: artboard.id, path: [], props: {}, slots: {} }
  if (options.file !== undefined) top.file = options.file
  const out = resolveNode(artboard.root, top, [], ctx)
  if (ctx.issues.length > 0) throw new PipelineError(ctx.issues[0].message, ctx.issues)
  return out
}

function resolveNode(node: DocNode, scope: Scope, stack: string[], ctx: Ctx): ResolvedNode {
  if (stack.length > MAX_DEPTH) {
    throw new PipelineError(`component nesting deeper than ${MAX_DEPTH}: ${stack.join(' -> ')}`, [])
  }

  if (isUseNode(node)) return expand(node, scope, stack, ctx)

  const origin = addressIn(scope, node.id)
  const out: Record<string, unknown> = {
    type: node.type,
    id: resolvedId(ctx.artboardId, scope.path, node.id),
    origin
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === 'id' || k === 'type' || k === 'children') continue
    if (v === undefined) continue
    const resolvedValue = substituteProp(v, scope, origin, k, ctx.issues)
    // `null` is "not set": the key is dropped rather than emitted, so the
    // difference between "absent" and "explicitly absent" never reaches CSS.
    if (resolvedValue === null || resolvedValue === undefined) {
      if (k in PROPS && PROPS[k as PropName].required) {
        ctx.issues.push(
          err('required-prop-unset', `"${k}" is required on a ${node.type} but resolved to nothing`, origin)
        )
      }
      continue
    }
    out[k] = resolvedValue
  }

  if (node.type === 'box') out.children = resolveChildren(node.children ?? [], scope, stack, ctx)
  return out as ResolvedNode
}

/** Children in order, with each slot reference replaced by what fills it. */
function resolveChildren(items: Child[], scope: Scope, stack: string[], ctx: Ctx): ResolvedNode[] {
  return items.flatMap((c) => {
    if (!isSlotRef(c)) return [resolveNode(c, scope, stack, ctx)]
    const fill = scope.slots[c.slot]
    // An unfilled slot is empty, not an error: a Card with nothing in its
    // footer simply has no footer.
    if (!fill) return []
    // The caller's scope *and* the caller's stack. With this component's stack
    // instead, a Card placed in a Card's body would read as Card using itself.
    return resolveChildren(fill.items, fill.scope, fill.stack, ctx)
  })
}

function expand(node: UseNode, scope: Scope, stack: string[], ctx: Ctx): ResolvedNode {
  const origin = addressIn(scope, node.id)
  const entry = ctx.registry.get(node.use)
  if (!entry) {
    ctx.issues.push(err('unknown-component', `no component named "${node.use}"`, origin))
    throw new PipelineError(`no component named "${node.use}"`, ctx.issues)
  }
  if (entry.conflicts?.length) {
    const message = `"${node.use}" is ambiguous: it is defined in ${definedIn(entry).join(' and ')}`
    ctx.issues.push(err('ambiguous-component', message, origin))
    throw new PipelineError(message, ctx.issues)
  }
  if (stack.includes(node.use)) {
    throw new PipelineError(
      `component "${node.use}" uses itself: ${[...stack, node.use].join(' -> ')}`,
      [err('component-cycle', `component "${node.use}" uses itself`, origin)]
    )
  }
  const def = entry.def

  // The instance's prop values are authored in the *caller's* scope, so they
  // are substituted there before the callee's scope exists.
  const given = node.props ?? {}
  const props: Record<string, unknown> = {}
  const slots: Record<string, SlotFill> = {}
  for (const [k, d] of Object.entries(def.props ?? {})) {
    if (d.type === 'slot') {
      const items = node.slots?.[k]
      if (items) slots[k] = { items, scope, stack }
      continue
    }
    props[k] = k in given ? substituteProp(given[k], scope, origin, k, ctx.issues) : d.default
  }

  const inner: Scope = { source: node.use, path: [...scope.path, node.id], props, slots }
  if (entry.file !== undefined) inner.file = entry.file

  const root = resolveNode(def.root, inner, [...stack, node.use], ctx)

  // The bounded outer-layout subset, merged onto the resolved root. Not an
  // appearance override: a `use` cannot carry background, padding or font, so
  // an instance can be placed by its parent without being restyled by it.
  const merged: Record<string, unknown> = { ...root }
  for (const [k, v] of Object.entries(node)) {
    if (!OUTER_PROPS.has(k) || v === undefined) continue
    const resolvedValue = substituteProp(v, scope, origin, k, ctx.issues)
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
    // Cases are keyed by JSON object keys, which are strings; a boolean or
    // number prop is matched by its spelling, so `true` finds `"true"`.
    const k = typeof key === 'boolean' || typeof key === 'number' ? String(key) : key
    const chosen = typeof k === 'string' && Object.hasOwn(m.cases, k) ? m.cases[k] : m.default
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

  // An object literal whose fields are forms — an inline border, a gradient.
  // Walked the same way a run is; a field that is already a literal comes back
  // as it went in.
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
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
