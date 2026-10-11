import {
  containersOf,
  isSlotRef,
  isUseNode,
  isVariant,
  nodeSchema,
  type Artboard,
  type AuthoredDocument,
  type Child,
  type DesignDocument,
  type DocNode,
  type VariantArtboard
} from './schema'
import { err, type Issue } from './pipeline/types'

/**
 * Variants: an artboard written as another artboard plus its differences.
 *
 * Expansion happens once, in validation, and produces ordinary artboards. That
 * is the whole design: components, tokens, emit, the canvas, comments and the
 * render all keep reading full trees and never learn that variants exist. The
 * only thing that survives expansion is `inherited` — which artboard really
 * authors a node — because "edit at" has to send Claude to the line that draws
 * it, and for an untouched node that line is in the base.
 */

/** Keys `set` may not write: identity, and the containers `insert`/`replace` own. */
const NOT_SETTABLE = new Set(['id', 'type', 'use', 'children', 'slots'])

/** Deep enough for any real chain; a longer one is a cycle the check missed. */
const MAX_CHAIN = 32

export type Expanded = {
  doc: DesignDocument
  /**
   * Per variant: node id → the artboard that authors it, for each node it
   * inherited untouched. A node the variant replaced, inserted or set is the
   * variant's own and is absent.
   */
  inherited: Map<string, Map<string, string>>
  issues: Issue[]
}

type Found = { node: DocNode; container: Child[] | null; index: number }

/** An authored node in one artboard's tree, and where it sits. */
export function findNode(root: DocNode, id: string): Found | null {
  if (root.id === id) return { node: root, container: null, index: 0 }
  for (const box of containersOf(root)) {
    for (let i = 0; i < box.items.length; i++) {
      const c = box.items[i]
      if (isSlotRef(c)) continue
      if (c.id === id) return { node: c, container: box.items, index: i }
      const deeper = findNode(c, id)
      if (deeper) return deeper
    }
  }
  return null
}

/** Every authored node id under (and including) `n`. */
export function idsUnder(n: DocNode, out: string[] = []): string[] {
  out.push(n.id)
  for (const box of containersOf(n)) for (const c of box.items) if (!isSlotRef(c)) idsUnder(c, out)
  return out
}

/** The array an `into` insert appends to: a box's children, or one slot. */
function intoArray(n: DocNode, slot: string | undefined): Child[] | string {
  if (isUseNode(n)) {
    if (!slot) return `"${n.id}" is a component instance; say which slot to insert into`
    n.slots ??= {}
    n.slots[slot] ??= []
    return n.slots[slot]
  }
  if (n.type !== 'box') return `"${n.id}" is a ${n.type}, which holds no children`
  if (slot) return `"${n.id}" is a box, which has children, not slots`
  n.children ??= []
  return n.children
}

/**
 * Merge `changes` onto `node` in place. `null` deletes; an instance's `props`
 * merge one level down. Returns a message when a key may not be set.
 */
function setOnto(node: DocNode, changes: Record<string, unknown>): string | null {
  const bag = node as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(changes)) {
    if (NOT_SETTABLE.has(k)) {
      return `"${k}" cannot be set; use "replace" to change a node's ${k === 'children' || k === 'slots' ? 'contents' : 'kind or id'}`
    }
    if (k === 'props' && isUseNode(node) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const props = { ...(node.props ?? {}) }
      for (const [pk, pv] of Object.entries(v)) {
        if (pv === null) delete props[pk]
        else props[pk] = pv
      }
      if (Object.keys(props).length) node.props = props
      else delete node.props
      continue
    }
    if (v === null) delete bag[k]
    else bag[k] = v
  }
  return null
}

/**
 * Whether `node`, after a `set`, is still a node the schema accepts. Checked
 * shallowly: its children were valid before and `set` cannot reach them, and
 * checking them again would make every variant re-validate its whole base.
 */
function shallowCheck(node: DocNode): string | null {
  const shell: Record<string, unknown> = { ...node }
  if ('children' in shell) shell.children = []
  if ('slots' in shell) shell.slots = {}
  const r = nodeSchema.safeParse(shell)
  if (r.success) return null
  const first = r.error.issues[0]
  return `${first.path.length ? `${first.path.join('.')}: ` : ''}${first.message}`
}

/** One variant applied to a copy of its expanded base. */
function applyVariant(
  base: Artboard,
  baseInherited: Map<string, string> | undefined,
  v: VariantArtboard,
  i: number,
  issues: Issue[]
): { artboard: Artboard; inherited: Map<string, string> } {
  const root = structuredClone(base.root)
  const where = (...rest: (string | number)[]): (string | number)[] => ['artboards', i, ...rest]
  const at = (id: string) => ({ scope: v.id, id })

  // Who authors each node before this variant touches anything.
  const inherited = new Map<string, string>()
  for (const id of idsUnder(root)) inherited.set(id, baseInherited?.get(id) ?? base.id)
  const own = (n: DocNode) => {
    for (const id of idsUnder(n)) inherited.delete(id)
  }

  let current = root
  for (const [id, node] of Object.entries(v.replace ?? {})) {
    const f = findNode(current, id)
    if (!f) {
      issues.push(err('variant-unknown-node', `"${v.id}" replaces "${id}", which "${v.extends}" does not have`, at(id), where('replace', id)))
      continue
    }
    const fresh = structuredClone(node)
    for (const old of idsUnder(f.node)) inherited.delete(old)
    if (f.container) f.container[f.index] = fresh
    else current = fresh
    own(fresh)
  }

  for (const [n, id] of (v.remove ?? []).entries()) {
    const f = findNode(current, id)
    if (!f) {
      issues.push(err('variant-unknown-node', `"${v.id}" removes "${id}", which "${v.extends}" does not have`, at(id), where('remove', n)))
      continue
    }
    if (!f.container) {
      issues.push(err('variant-remove-root', `"${v.id}" cannot remove "${id}": it is the root`, at(id), where('remove', n)))
      continue
    }
    for (const old of idsUnder(f.node)) inherited.delete(old)
    f.container.splice(f.index, 1)
  }

  for (const [n, ins] of (v.insert ?? []).entries()) {
    const fresh = structuredClone(ins.node)
    const anchor = 'after' in ins ? ins.after : 'before' in ins ? ins.before : ins.into
    const f = findNode(current, anchor)
    if (!f) {
      issues.push(err('variant-unknown-node', `"${v.id}" inserts at "${anchor}", which is not in the artboard`, at(anchor), where('insert', n)))
      continue
    }
    if ('into' in ins) {
      const into = intoArray(f.node, ins.slot)
      if (typeof into === 'string') {
        issues.push(err('variant-bad-insert', into, at(anchor), where('insert', n)))
        continue
      }
      into.push(fresh)
    } else {
      if (!f.container) {
        issues.push(err('variant-bad-insert', `"${anchor}" is the root; nothing can sit beside it`, at(anchor), where('insert', n)))
        continue
      }
      f.container.splice('after' in ins ? f.index + 1 : f.index, 0, fresh)
    }
    own(fresh)
  }

  for (const [id, changes] of Object.entries(v.set ?? {})) {
    const f = findNode(current, id)
    if (!f) {
      issues.push(err('variant-unknown-node', `"${v.id}" sets "${id}", which is not in the artboard`, at(id), where('set', id)))
      continue
    }
    const refused = setOnto(f.node, changes)
    const bad = refused ?? shallowCheck(f.node)
    if (bad) {
      issues.push(err('variant-bad-set', `"${v.id}" sets "${id}": ${bad}`, at(id), where('set', id)))
      continue
    }
    inherited.delete(id)
  }

  const artboard: Artboard = {
    id: v.id,
    name: v.name,
    size: v.size ?? base.size,
    root: current
  }
  const background = v.background ?? base.background
  if (background !== undefined) artboard.background = background
  if (v.position !== undefined) artboard.position = v.position
  const mode = v.mode ?? base.mode
  if (mode !== undefined) artboard.mode = mode
  return { artboard, inherited }
}

/**
 * Every artboard as a full artboard, in file order. Variants may extend
 * variants; a base may sit later in the file than what extends it.
 */
export function expandVariants(doc: AuthoredDocument): Expanded {
  const issues: Issue[] = []
  const byId = new Map<string, { a: Artboard | VariantArtboard; i: number }>()
  doc.artboards.forEach((a, i) => byId.has(a.id) || byId.set(a.id, { a, i }))

  const done = new Map<string, Artboard | null>()
  const inherited = new Map<string, Map<string, string>>()

  const resolve = (id: string, chain: string[]): Artboard | null => {
    if (done.has(id)) return done.get(id)!
    const entry = byId.get(id)!
    const { a, i } = entry
    if (!isVariant(a)) {
      done.set(id, a)
      return a
    }
    if (chain.includes(id) || chain.length > MAX_CHAIN) {
      issues.push(err('variant-cycle', `artboards extend each other in a loop: ${[...chain, id].join(' → ')}`, undefined, ['artboards', i, 'extends']))
      done.set(id, null)
      return null
    }
    if (!byId.has(a.extends)) {
      issues.push(
        err('variant-unknown-base', `"${a.id}" extends "${a.extends}", which is not an artboard in this file`, undefined, ['artboards', i, 'extends'])
      )
      done.set(id, null)
      return null
    }
    const base = resolve(a.extends, [...chain, id])
    if (!base) {
      done.set(id, null)
      return null
    }
    const out = applyVariant(base, inherited.get(base.id), a, i, issues)
    inherited.set(id, out.inherited)
    done.set(id, out.artboard)
    return out.artboard
  }

  const artboards: Artboard[] = []
  for (const a of doc.artboards) {
    const full = resolve(a.id, [])
    if (full) artboards.push(full)
  }
  return { doc: { ...doc, artboards }, inherited, issues }
}
