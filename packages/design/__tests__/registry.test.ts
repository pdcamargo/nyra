import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROPS } from '../src/registry/props'
import { NODES, RENDERABLE_KINDS } from '../src/registry/nodes'
import { NODE_KINDS, CATEGORIES, type NodeKind } from '../src/registry/define'
import { PROPS_BY_KIND, propNamesFor } from '../src/registry/shapes'
import type { PropName } from '../src/registry/types'
import { propRefSchema, value, valueOrList } from '../src/value'
import { defaultTheme } from '../src/theme/default'
import { isTokenPath, lookupToken, resolveDeep } from '../src/theme/resolve'
import { SCALES } from '../src/theme/types'

const names = Object.keys(PROPS) as PropName[]
const entries = names.map((n) => [n, PROPS[n]] as const)

describe('the registry describes itself', () => {
  it.each(entries)('%s is well formed', (name, def) => {
    expect(def.appliesTo.length).toBeGreaterThan(0)
    for (const k of def.appliesTo) expect(NODE_KINDS).toContain(k)
    expect(CATEGORIES).toContain(def.category)
    expect(def.doc.length).toBeGreaterThan(10)
    expect(def.examples.length).toBeGreaterThan(0)
    expect(def.invalid.length).toBeGreaterThan(0)
    for (const s of def.tokens) expect(SCALES).toContain(s)
    expect(name).toMatch(/^[a-z][A-Za-z]*$/)
  })

  it('every node kind has properties, and every property reaches a node kind', () => {
    for (const kind of NODE_KINDS) expect(propNamesFor(kind).length).toBeGreaterThan(0)
    const routed = new Set(NODE_KINDS.flatMap((k) => propNamesFor(k)))
    expect([...names].sort()).toEqual([...routed].sort())
  })

  it('the runtime schema for a kind matches its appliesTo filter', () => {
    // The guard on the flat cast in shapes.ts: what the schema contains and
    // what the registry says must be the same set, for every kind.
    for (const kind of NODE_KINDS) {
      const fromSchema = Object.keys(PROPS_BY_KIND[kind].shape).sort()
      const fromRegistry = names.filter((n) => (PROPS[n].appliesTo as readonly NodeKind[]).includes(kind)).sort()
      expect(fromSchema).toEqual(fromRegistry)
    }
  })

  it('a use instance carries layout-in-parent properties and nothing that restyles it', () => {
    const onUse = propNamesFor('use')
    expect(onUse.sort()).toEqual(
      [
        'alignSelf',
        'grow',
        'height',
        'inset',
        'maxHeight',
        'maxWidth',
        'minHeight',
        'minWidth',
        'position',
        'shrink',
        'span',
        'width',
        'zIndex'
      ].sort()
    )
    for (const p of ['background', 'padding', 'font', 'color', 'radius']) {
      expect(onUse).not.toContain(p)
    }
  })

  it('every node kind has a definition, and only box takes children', () => {
    for (const kind of NODE_KINDS) expect(NODES[kind].kind).toBe(kind)
    expect(NODES.box.children).toBe('many')
    for (const kind of RENDERABLE_KINDS.filter((k) => k !== 'box')) {
      expect(NODES[kind].children).toBe('none')
    }
  })
})

describe('every property validates its own examples', () => {
  it.each(entries)('%s parses its examples and rejects its counter-examples', (name, def) => {
    for (const ex of def.examples) {
      const r = def.schema.safeParse(ex)
      expect(r.success, `${name} rejected its own example ${JSON.stringify(ex)}`).toBe(true)
    }
    for (const bad of def.invalid) {
      const r = def.schema.safeParse(bad)
      expect(r.success, `${name} accepted ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it.each(entries)('%s accepts all three value forms', (name, def) => {
    const wrapped = def.list ? valueOrList(def.schema) : value(def.schema)
    const ex = def.examples[0]
    expect(wrapped.safeParse(ex).success, `${name} literal`).toBe(true)
    expect(wrapped.safeParse({ prop: 'variant' }).success, `${name} ref`).toBe(true)
    expect(
      wrapped.safeParse({ match: { prop: 'variant' }, cases: { a: ex } }).success,
      `${name} match`
    ).toBe(true)
    expect(
      wrapped.safeParse({ match: { prop: 'v' }, cases: { a: { match: { prop: 'w' }, cases: { b: ex } } } }).success,
      `${name} nested match`
    ).toBe(true)
  })

  /**
   * The strongest guard on the three value forms. `z.xor` fails on zero OR more
   * than one match, so this *proves* no property literal can be mistaken for a
   * reference — rather than asserting that everyone remembered `z.strictObject`.
   */
  it.each(entries)('%s literals are never ambiguous with a reference', (name, def) => {
    const matchForm = z.strictObject({
      match: propRefSchema,
      cases: z.record(z.string(), z.unknown()),
      default: z.unknown().optional()
    })
    const oracle = z.xor([propRefSchema, matchForm, def.schema])
    for (const ex of def.examples) {
      const r = oracle.safeParse(ex)
      expect(r.success, `${name}: ${JSON.stringify(ex)} matches more than one value form`).toBe(true)
    }
    expect(oracle.safeParse({ prop: 'variant' }).success, `${name}: a reference is ambiguous`).toBe(true)
  })
})

describe('every property emits CSS', () => {
  it.each(entries)('%s emits camelCase CSS from its examples', (name, def) => {
    for (const ex of def.examples) {
      // resolveDeep, not a shallow pass: `inset: { bottom: '$space.2' }` nests
      // its tokens, and a shallow resolve let the old emitter quietly produce
      // "$space.2px" until the emitters started guarding their inputs.
      const out = def.css(resolveDeep(ex, defaultTheme) as never, defaultTheme)
      expect(typeof out).toBe('object')
      for (const key of Object.keys(out)) {
        expect(key, `${name} emitted "${key}"`).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
      }
    }
  })

  it.each(entries.filter(([, d]) => d.tokens.length > 0))(
    '%s example tokens resolve in the default theme',
    (name, def) => {
      for (const ex of def.examples) {
        if (!isTokenPath(ex)) continue
        expect(() => lookupToken(defaultTheme, ex), `${name}: ${ex}`).not.toThrow()
      }
    }
  )
})

describe('icon names are checked for existence, not just shape', () => {
  it('rejects a name that parses but does not exist', () => {
    const r = PROPS.name.schema.safeParse('github')
    expect(r.success).toBe(false)
    // Lucide dropped brand marks. Only a lookup against the real set catches it,
    // and a design with a hole in it is a mock that lies.
    expect(r.success || r.error.issues[0].message).toContain('no lucide icon')
  })

  it('suggests a near miss', () => {
    const r = PROPS.name.schema.safeParse('chevron-rigth')
    expect(r.success).toBe(false)
    expect(r.success || r.error.issues[0].message).toMatch(/did you mean/)
  })

  it('accepts every name the emitter can draw', () => {
    for (const n of ['search', 'circle-check', 'git-branch', 'trending-up', 'battery-full']) {
      expect(PROPS.name.schema.safeParse(n).success, n).toBe(true)
    }
  })
})
