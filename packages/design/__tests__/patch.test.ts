import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, applyWithUndo, invert, PatchError, type Patch } from '../src/patch'
import { validate } from '../src/pipeline'
import type { DesignDocument } from '../src/schema'

const load = (): DesignDocument => {
  const raw = JSON.parse(readFileSync(resolve(__dirname, '../examples/settings.nyui.json'), 'utf8'))
  const r = validate(raw)
  if (!r.ok) throw new Error('fixture does not validate')
  return r.doc
}

const A = (scope: string, id: string): { scope: string; id: string } => ({ scope, id })

const PATCHES: [string, Patch][] = [
  ['setProp on an artboard node', { op: 'setProp', at: A('settings-general', 'page'), prop: 'gap', value: '$space.2' }],
  ['setProp clearing a property', { op: 'setProp', at: A('settings-general', 'page'), prop: 'padding', value: undefined }],
  ['setProp inside a component', { op: 'setProp', at: A('Button', 'root'), prop: 'radius', value: '$radius.full' }],
  ['setInstanceProp', { op: 'setInstanceProp', at: A('settings-general', 'cancel'), prop: 'label', value: 'Discard' }],
  [
    'insertNode',
    {
      op: 'insertNode',
      parent: A('settings-general', 'page'),
      index: 1,
      node: { id: 'blurb', type: 'text', value: 'Some copy', font: '$font.body' }
    }
  ],
  ['removeNode', { op: 'removeNode', at: A('settings-general', 'title') }],
  ['removeNode of a use node', { op: 'removeNode', at: A('settings-general', 'cancel') }],
  ['moveNode within a parent', { op: 'moveNode', at: A('settings-general', 'save'), parent: A('settings-general', 'actions'), index: 1 }],
  ['moveNode to another parent', { op: 'moveNode', at: A('settings-general', 'title'), parent: A('settings-general', 'actions'), index: 0 }],
  ['setArtboard', { op: 'setArtboard', id: 'settings-general', key: 'background', value: '$color.surface' }],
  ['setDocMeta', { op: 'setDocMeta', key: 'name', value: 'Renamed' }]
]

describe('patches', () => {
  it.each(PATCHES)('%s changes the document', (_label, patch) => {
    const doc = load()
    const next = apply(doc, patch)
    expect(next).not.toEqual(doc)
  })

  /**
   * The one test that matters most here. JSON Patch could not pass it: `remove`
   * discards what it removed, so its inverse does not exist without a snapshot.
   */
  it.each(PATCHES)('%s is invertible', (_label, patch) => {
    const doc = load()
    const { doc: next, undo } = applyWithUndo(doc, patch)
    expect(apply(next, undo)).toEqual(doc)
  })

  it.each(PATCHES)('%s leaves a document that still validates', (_label, patch) => {
    const doc = load()
    const r = validate(apply(doc, patch))
    expect(r.ok, JSON.stringify(r.ok ? [] : r.issues.slice(0, 2))).toBe(true)
  })

  it('does not mutate the document it was given', () => {
    const doc = load()
    const before = JSON.stringify(doc)
    apply(doc, { op: 'setProp', at: A('settings-general', 'page'), prop: 'gap', value: 0 })
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('addresses survive an insertion that would shift a JSON Patch index', () => {
    const doc = load()
    // Insert a sibling *before* the node a later patch names.
    const shifted = apply(doc, {
      op: 'insertNode',
      parent: A('settings-general', 'actions'),
      index: 0,
      node: { id: 'spacer', type: 'box', layout: 'none', grow: 1 }
    })
    // The same address still means the same node. An index path would now be
    // pointing one to the left.
    const next = apply(shifted, { op: 'setInstanceProp', at: A('settings-general', 'save'), prop: 'label', value: 'Apply' })
    const actions = (next.artboards[0].root as { children: { id: string; props?: Record<string, unknown> }[] })
      .children[1] as unknown as { children: { id: string; props?: Record<string, unknown> }[] }
    const save = actions.children.find((c) => c.id === 'save')
    expect(save?.props?.label).toBe('Apply')
  })

  it('refuses a node that is not there, and a root removal', () => {
    const doc = load()
    expect(() => apply(doc, { op: 'removeNode', at: A('settings-general', 'nope') })).toThrow(PatchError)
    expect(() => apply(doc, { op: 'removeNode', at: A('settings-general', 'page') })).toThrow(PatchError)
    expect(() => apply(doc, { op: 'setProp', at: A('nope', 'page'), prop: 'gap', value: 0 })).toThrow(PatchError)
  })

  it('refuses children on a node that cannot have them', () => {
    const doc = load()
    expect(() =>
      apply(doc, {
        op: 'insertNode',
        parent: A('settings-general', 'title'),
        index: 0,
        node: { id: 'x', type: 'text', value: 'y' }
      })
    ).toThrow(/not a box/)
  })

  it('inverting does not depend on applying first', () => {
    const doc = load()
    const patch: Patch = { op: 'setProp', at: A('settings-general', 'page'), prop: 'gap', value: '$space.1' }
    expect(invert(doc, patch)).toEqual({
      op: 'setProp',
      at: A('settings-general', 'page'),
      prop: 'gap',
      value: '$space.6'
    })
  })
})
