import type { Address } from './ids'
import type { PropName } from './registry/types'
import { containersOf, isSlotRef, isUseNode, type Child, type DesignDocument, type DocNode } from './schema'

/**
 * Mutations are patches against the authored document, addressed by node id.
 *
 * Deliberately NOT RFC 6902 JSON Patch, for three reasons:
 *
 * 1. JSON Patch paths are array indices. `/artboards/0/root/children/2/padding`
 *    stops meaning the same node the moment a sibling is inserted — which
 *    throws away the "node ids are stable" invariant at the only layer that
 *    consumes it.
 * 2. JSON Patch is not invertible. `remove` discards what it removed, so undo
 *    needs a second mechanism; every op here carries enough to invert.
 * 3. JSON Patch cannot consult the registry. `setProp` can refuse a property
 *    that does not apply to the node's type; `replace` just splices JSON.
 *
 * Patches address *authored* nodes. A resolved node inside a component instance
 * is derived — its `origin` says which authored node to aim at instead.
 */
export type Patch =
  | { op: 'setProp'; at: Address; prop: PropName; value: unknown }
  | { op: 'setInstanceProp'; at: Address; prop: string; value: unknown }
  /** `slot` inserts into an instance's slot content rather than a box's children. */
  | { op: 'insertNode'; parent: Address; index: number; node: DocNode; slot?: string }
  | { op: 'removeNode'; at: Address }
  | { op: 'moveNode'; at: Address; parent: Address; index: number; slot?: string }
  | { op: 'setArtboard'; id: string; key: 'name' | 'background'; value: unknown }
  | { op: 'moveArtboard'; id: string; position?: { x: number; y: number } }
  | { op: 'setDocMeta'; key: 'name' | 'theme'; value: string }

export class PatchError extends Error {}

const clone = <T,>(v: T): T => structuredClone(v)

/**
 * Where an authored node sits: the array that holds it (a box's children, or
 * one slot of an instance) and its index in that array. The *real* array, slot
 * references included — an index into a filtered copy would splice the wrong
 * element the moment a slot reference sits before it.
 */
type Located = {
  node: DocNode
  parent: DocNode | null
  /** The slot the node is in, when its parent is an instance. */
  slot: string | null
  container: Child[] | null
  index: number
  scopeRoot: DocNode
}

/** Finds an authored node by address, and where it sits. */
function locate(doc: DesignDocument, at: Address): Located {
  const roots: [string, DocNode][] = [
    ...doc.artboards.map((a) => [a.id, a.root] as [string, DocNode]),
    ...Object.entries(doc.components ?? {}).map(([n, c]) => [n, c.root] as [string, DocNode])
  ]
  const entry = roots.find(([scope]) => scope === at.scope)
  if (!entry) throw new PatchError(`no scope "${at.scope}"`)
  const [, scopeRoot] = entry

  let found: Located | null = null
  const walk = (n: DocNode, parent: DocNode | null, slot: string | null, container: Child[] | null, index: number): void => {
    if (n.id === at.id) found ??= { node: n, parent, slot, container, index, scopeRoot }
    for (const box of containersOf(n)) {
      box.items.forEach((c, i) => {
        if (!isSlotRef(c)) walk(c, n, box.slot, box.items, i)
      })
    }
  }
  walk(scopeRoot, null, null, null, 0)
  if (!found) throw new PatchError(`no node "${at.id}" in "${at.scope}"`)
  return found
}

/** The array a new child goes into: a box's children, or one slot of an instance. */
const childArray = (n: DocNode, slot?: string | null): Child[] => {
  if (isUseNode(n)) {
    if (!slot) throw new PatchError(`"${n.id}" is a component instance; name the slot to insert into`)
    n.slots ??= {}
    n.slots[slot] ??= []
    return n.slots[slot]
  }
  if (n.type !== 'box') throw new PatchError(`"${n.id}" is not a box; it has no children`)
  if (slot) throw new PatchError(`"${n.id}" is a box, which has children, not slots`)
  n.children ??= []
  return n.children
}

export function apply(doc: DesignDocument, patch: Patch): DesignDocument {
  const next = clone(doc)

  switch (patch.op) {
    case 'setProp': {
      const { node } = locate(next, patch.at)
      const bag = node as unknown as Record<string, unknown>
      if (patch.value === undefined) delete bag[patch.prop]
      else bag[patch.prop] = patch.value
      return next
    }
    case 'setInstanceProp': {
      const { node } = locate(next, patch.at)
      if (!isUseNode(node)) throw new PatchError(`"${patch.at.id}" is not a component instance`)
      node.props ??= {}
      if (patch.value === undefined) delete node.props[patch.prop]
      else node.props[patch.prop] = patch.value
      return next
    }
    case 'insertNode': {
      const { node: parent } = locate(next, patch.parent)
      const kids = childArray(parent, patch.slot)
      if (patch.index < 0 || patch.index > kids.length) {
        throw new PatchError(`index ${patch.index} out of range for "${patch.parent.id}"`)
      }
      kids.splice(patch.index, 0, clone(patch.node))
      return next
    }
    case 'removeNode': {
      const { container, index } = locate(next, patch.at)
      if (!container) throw new PatchError(`"${patch.at.id}" is a root and cannot be removed`)
      container.splice(index, 1)
      return next
    }
    case 'moveNode': {
      const { node, container, index } = locate(next, patch.at)
      if (!container) throw new PatchError(`"${patch.at.id}" is a root and cannot be moved`)
      container.splice(index, 1)
      const { node: target } = locate(next, patch.parent)
      childArray(target, patch.slot).splice(patch.index, 0, node)
      return next
    }
    case 'setArtboard': {
      const a = next.artboards.find((x) => x.id === patch.id)
      if (!a) throw new PatchError(`no artboard "${patch.id}"`)
      const bag = a as unknown as Record<string, unknown>
      if (patch.value === undefined) delete bag[patch.key]
      else bag[patch.key] = patch.value
      return next
    }
    case 'moveArtboard': {
      const a = next.artboards.find((x) => x.id === patch.id)
      if (!a) throw new PatchError(`no artboard "${patch.id}"`)
      if (patch.position === undefined) delete a.position
      else a.position = { ...patch.position }
      return next
    }
    case 'setDocMeta': {
      next[patch.key] = patch.value
      return next
    }
  }
}

/**
 * The inverse of a patch, against the document it would apply to. This is why
 * the op set is custom: undo is the patch layer, not a stack of snapshots
 * beside it.
 */
export function invert(doc: DesignDocument, patch: Patch): Patch {
  switch (patch.op) {
    case 'setProp': {
      const { node } = locate(doc, patch.at)
      const prev = (node as unknown as Record<string, unknown>)[patch.prop]
      return { op: 'setProp', at: patch.at, prop: patch.prop, value: clone(prev) }
    }
    case 'setInstanceProp': {
      const { node } = locate(doc, patch.at)
      const prev = isUseNode(node) ? node.props?.[patch.prop] : undefined
      return { op: 'setInstanceProp', at: patch.at, prop: patch.prop, value: clone(prev) }
    }
    case 'insertNode':
      return { op: 'removeNode', at: { scope: patch.parent.scope, id: patch.node.id } }
    case 'removeNode': {
      const { node, parent, slot, index } = locate(doc, patch.at)
      if (!parent) throw new PatchError(`"${patch.at.id}" is a root and cannot be removed`)
      return {
        op: 'insertNode',
        parent: { scope: patch.at.scope, id: parent.id },
        index,
        node: clone(node),
        ...(slot ? { slot } : {})
      }
    }
    case 'moveNode': {
      const { parent, slot, index } = locate(doc, patch.at)
      if (!parent) throw new PatchError(`"${patch.at.id}" is a root and cannot be moved`)
      return {
        op: 'moveNode',
        at: patch.at,
        parent: { scope: patch.at.scope, id: parent.id },
        index,
        ...(slot ? { slot } : {})
      }
    }
    case 'setArtboard': {
      const a = doc.artboards.find((x) => x.id === patch.id)
      if (!a) throw new PatchError(`no artboard "${patch.id}"`)
      const prev = (a as unknown as Record<string, unknown>)[patch.key]
      return { op: 'setArtboard', id: patch.id, key: patch.key, value: clone(prev) }
    }
    case 'moveArtboard': {
      const a = doc.artboards.find((x) => x.id === patch.id)
      if (!a) throw new PatchError(`no artboard "${patch.id}"`)
      return { op: 'moveArtboard', id: patch.id, position: clone(a.position) }
    }
    case 'setDocMeta':
      return { op: 'setDocMeta', key: patch.key, value: doc[patch.key] }
  }
}

/** Apply a patch and hand back the undo alongside it. */
export function applyWithUndo(doc: DesignDocument, patch: Patch): { doc: DesignDocument; undo: Patch } {
  const undo = invert(doc, patch)
  return { doc: apply(doc, patch), undo }
}
