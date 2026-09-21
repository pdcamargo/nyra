import type { Address } from './ids'
import type { PropName } from './registry/types'
import { childrenOf, isUseNode, type DesignDocument, type DocNode } from './schema'

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
  | { op: 'insertNode'; parent: Address; index: number; node: DocNode }
  | { op: 'removeNode'; at: Address }
  | { op: 'moveNode'; at: Address; parent: Address; index: number }
  | { op: 'setArtboard'; id: string; key: 'name' | 'background'; value: unknown }
  | { op: 'moveArtboard'; id: string; position?: { x: number; y: number } }
  | { op: 'setDocMeta'; key: 'name' | 'theme'; value: string }

export class PatchError extends Error {}

const clone = <T,>(v: T): T => structuredClone(v)

type Located = { node: DocNode; parent: DocNode | null; index: number; scopeRoot: DocNode }

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
  const walk = (n: DocNode, parent: DocNode | null, index: number): void => {
    if (n.id === at.id) found ??= { node: n, parent, index, scopeRoot }
    childrenOf(n).forEach((c, i) => walk(c, n, i))
  }
  walk(scopeRoot, null, 0)
  if (!found) throw new PatchError(`no node "${at.id}" in "${at.scope}"`)
  return found
}

const childArray = (n: DocNode): DocNode[] => {
  if (isUseNode(n) || n.type !== 'box') throw new PatchError(`"${n.id}" is not a box; it has no children`)
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
      const kids = childArray(parent)
      if (patch.index < 0 || patch.index > kids.length) {
        throw new PatchError(`index ${patch.index} out of range for "${patch.parent.id}"`)
      }
      kids.splice(patch.index, 0, clone(patch.node))
      return next
    }
    case 'removeNode': {
      const { parent, index } = locate(next, patch.at)
      if (!parent) throw new PatchError(`"${patch.at.id}" is a root and cannot be removed`)
      childArray(parent).splice(index, 1)
      return next
    }
    case 'moveNode': {
      const { node, parent, index } = locate(next, patch.at)
      if (!parent) throw new PatchError(`"${patch.at.id}" is a root and cannot be moved`)
      childArray(parent).splice(index, 1)
      const { node: target } = locate(next, patch.parent)
      childArray(target).splice(patch.index, 0, node)
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
      const { node, parent, index } = locate(doc, patch.at)
      if (!parent) throw new PatchError(`"${patch.at.id}" is a root and cannot be removed`)
      return {
        op: 'insertNode',
        parent: { scope: patch.at.scope, id: parent.id },
        index,
        node: clone(node)
      }
    }
    case 'moveNode': {
      const { parent, index } = locate(doc, patch.at)
      if (!parent) throw new PatchError(`"${patch.at.id}" is a root and cannot be moved`)
      return {
        op: 'moveNode',
        at: patch.at,
        parent: { scope: patch.at.scope, id: parent.id },
        index
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
