import { describe, expect, it } from 'vitest'
import { compile, validate } from '../src/pipeline'
import { FORMAT_VERSION, upgrade } from '../src/migrations'
import { toVariants } from '../src/migrations/002-variants'
import type { Artboard } from '../src/schema'
import type { ResolvedNode } from '../src/pipeline/types'

const row = (id: string, label: string) => ({
  type: 'box',
  id,
  layout: 'stack',
  direction: 'row',
  gap: '$space.2',
  children: [
    { type: 'text', id: `${id}-label`, value: label, font: '$font.body' },
    { type: 'text', id: `${id}-hint`, value: `${label} hint`, font: '$font.small', color: '$color.textMuted' }
  ]
})

const screen = (id: string, title = 'Settings') => ({
  id,
  name: id,
  size: { width: 800, height: 600 },
  background: '$color.bg',
  root: {
    type: 'box',
    id: 'root',
    layout: 'stack',
    direction: 'column',
    gap: '$space.4',
    children: [
      { type: 'text', id: 'title', value: title, font: '$font.h2' },
      { type: 'box', id: 'list', layout: 'stack', direction: 'column', children: [row('a', 'Alpha'), row('b', 'Beta'), row('c', 'Gamma')] }
    ]
  }
})

const doc = (...artboards: unknown[]) => ({ schema: FORMAT_VERSION, name: 'Variants', artboards })

function walk(n: ResolvedNode, out: ResolvedNode[] = []): ResolvedNode[] {
  out.push(n)
  if (n.type === 'box') for (const c of n.children) walk(c, out)
  return out
}
const byOrigin = (root: ResolvedNode, id: string) => walk(root).find((n) => n.origin.id === id)

/** A resolved tree without what only says where it came from. */
const drawn = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(drawn)
  if (v === null || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (k !== 'from') out[k] = drawn(x)
  return out
}

describe('a variant artboard', () => {
  it('draws its base plus its changes, applied replace → remove → insert → set', () => {
    const v = {
      id: 'free',
      name: 'Free plan',
      extends: 'main',
      replace: { c: { type: 'text', id: 'c', value: 'Gone pro', font: '$font.body' } },
      remove: ['b'],
      insert: [
        { after: 'a', node: row('n', 'New') },
        { before: 'title', node: { type: 'text', id: 'eyebrow', value: 'Plan', font: '$font.small' } },
        { into: 'list', node: row('z', 'Last') }
      ],
      // Reaches a node the insert above just put there.
      set: { title: { value: 'Free' }, 'n-label': { value: 'Renamed' } }
    }
    const out = validate(doc(screen('main'), v))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const root = out.doc.artboards[1].root as { children: { id: string; value?: string; children?: { id: string }[] }[] }
    expect(root.children.map((c) => c.id)).toEqual(['eyebrow', 'title', 'list'])
    expect(root.children[1].value).toBe('Free')
    expect(root.children[2].children!.map((c) => c.id)).toEqual(['a', 'n', 'c', 'z'])
    expect(JSON.stringify(root)).toContain('"Renamed"')
    // The base is untouched.
    expect(JSON.stringify(out.doc.artboards[0])).not.toContain('Free')
  })

  it('follows the base for size, background and mode, but never for position', () => {
    const base = { ...screen('main'), mode: 'dark', position: { x: 0, y: 0 } }
    const out = validate(doc(base, { id: 'v', name: 'V', extends: 'main' }, { id: 'w', name: 'W', extends: 'main', size: { width: 400, height: 'auto' }, mode: 'light' }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [, v, w] = out.doc.artboards
    expect(v.size).toEqual(base.size)
    expect(v.background).toBe('$color.bg')
    expect(v.mode).toBe('dark')
    expect(v.position).toBeUndefined()
    expect(w.size).toEqual({ width: 400, height: 'auto' })
    expect(w.mode).toBe('light')
  })

  it('may extend a variant, and a base may come later in the file', () => {
    const out = validate(
      doc(
        { id: 'c', name: 'C', extends: 'b', set: { 'a-label': { value: 'From C' } } },
        { id: 'b', name: 'B', extends: 'main', set: { title: { value: 'From B' } } },
        screen('main')
      )
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const c = JSON.stringify(out.doc.artboards[0].root)
    expect(c).toContain('From B')
    expect(c).toContain('From C')
  })

  it("merges an instance's props by key, and null removes one", () => {
    const d = {
      ...doc(
        { id: 'main', name: 'M', size: { width: 400, height: 300 }, root: { type: 'box', id: 'root', children: [{ id: 'b', use: 'Badge', props: { label: 'Pro', tone: 'accent' } }] } },
        { id: 'v', name: 'V', extends: 'main', set: { b: { props: { label: 'Free', tone: null } } } }
      ),
      components: {
        Badge: {
          props: { label: { type: 'string' }, tone: { type: 'enum', of: ['accent', 'muted'], default: 'muted' } },
          root: { type: 'text', id: 't', value: { prop: 'label' }, color: { match: { prop: 'tone' }, cases: { accent: '$color.accent', muted: '$color.textMuted' } } }
        }
      }
    }
    const out = validate(d)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((out.doc.artboards[1].root as { children: unknown[] }).children[0]).toEqual({ id: 'b', use: 'Badge', props: { label: 'Free' } })
  })

  it('names what it cannot find, and where in the file it asked', () => {
    const cases: [unknown, string, (string | number)[]][] = [
      [{ id: 'v', name: 'V', extends: 'nope' }, 'variant-unknown-base', ['artboards', 1, 'extends']],
      [{ id: 'v', name: 'V', extends: 'main', set: { ghost: { value: 'x' } } }, 'variant-unknown-node', ['artboards', 1, 'set', 'ghost']],
      [{ id: 'v', name: 'V', extends: 'main', remove: ['root'] }, 'variant-remove-root', ['artboards', 1, 'remove', 0]],
      [{ id: 'v', name: 'V', extends: 'main', insert: [{ into: 'title', node: row('q', 'Q') }] }, 'variant-bad-insert', ['artboards', 1, 'insert', 0]],
      [{ id: 'v', name: 'V', extends: 'main', set: { title: { children: [] } } }, 'variant-bad-set', ['artboards', 1, 'set', 'title']],
      // A typo is caught on the node it lands on, not passed through.
      [{ id: 'v', name: 'V', extends: 'main', set: { list: { paddign: 4 } } }, 'variant-bad-set', ['artboards', 1, 'set', 'list']]
    ]
    for (const [v, code, path] of cases) {
      const out = validate(doc(screen('main'), v))
      expect(out.ok, code).toBe(false)
      expect(out.issues[0]).toMatchObject({ code, path })
    }
  })

  it('refuses a loop, and an inserted id that is already in the artboard', () => {
    const loop = validate(doc(screen('main'), { id: 'x', name: 'X', extends: 'y' }, { id: 'y', name: 'Y', extends: 'x' }))
    expect(loop.ok).toBe(false)
    expect(loop.issues[0].code).toBe('variant-cycle')

    const dup = validate(doc(screen('main'), { id: 'v', name: 'V', extends: 'main', insert: [{ after: 'title', node: { type: 'text', id: 'title', value: 'x' } }] }))
    expect(dup.ok).toBe(false)
    expect(dup.issues.some((i) => i.code === 'duplicate-id')).toBe(true)
  })

  it('reports a malformed variant against its own shape, not a full artboard', () => {
    const out = validate(doc(screen('main'), { id: 'v', name: 'V', extends: 'main', root: { type: 'box', id: 'r' } }))
    expect(out.ok).toBe(false)
    expect(out.issues[0].path).toEqual(['artboards', 1])
  })
})

describe('what a variant draws', () => {
  it('is what the same artboard written out in full draws', () => {
    const v = { id: 'v', name: 'v', extends: 'main', set: { title: { value: 'Billing' } } }
    const a = compile(doc(screen('main'), v)).doc.artboards[1]
    const b = compile(doc(screen('main'), screen('v', 'Billing'))).doc.artboards[1]
    expect(drawn(a)).toEqual(drawn(b))
  })

  it('says which artboard writes each node it inherited, and nothing for its own', () => {
    const v = {
      id: 'v',
      name: 'V',
      extends: 'mid',
      set: { 'a-label': { value: 'Mine' } },
      insert: [{ after: 'a', node: row('n', 'New') }]
    }
    const mid = { id: 'mid', name: 'Mid', extends: 'main', set: { title: { value: 'Mid' } } }
    const out = compile(doc(screen('main'), mid, v))
    const root = out.doc.artboards[2].root
    expect(byOrigin(root, 'b-label')?.from).toBe('main')
    expect(byOrigin(root, 'title')?.from).toBe('mid')
    expect(byOrigin(root, 'a-label')?.from).toBeUndefined()
    expect(byOrigin(root, 'n-label')?.from).toBeUndefined()
    // `origin` still names the artboard the node is drawn in.
    expect(byOrigin(root, 'b-label')?.origin.scope).toBe('v')
    // A full artboard says nothing.
    expect(walk(out.doc.artboards[0].root).some((n) => n.from !== undefined)).toBe(false)
  })

  it("marks an inherited instance, never the component's insides", () => {
    const d = {
      ...doc(
        { id: 'main', name: 'M', size: { width: 400, height: 300 }, root: { type: 'box', id: 'root', children: [{ id: 'b', use: 'Badge', props: { label: 'Pro' } }] } },
        { id: 'v', name: 'V', extends: 'main' }
      ),
      components: {
        Badge: { props: { label: { type: 'string' } }, root: { type: 'box', id: 'shell', children: [{ type: 'text', id: 't', value: { prop: 'label' } }] } }
      }
    }
    const root = compile(d).doc.artboards[1].root
    const nodes = walk(root)
    expect(nodes.find((n) => n.id === 'v#b/shell')?.from).toBe('main')
    expect(nodes.find((n) => n.id === 'v#b/t')?.from).toBeUndefined()
  })
})

describe('upgrading a v2 file', () => {
  const v2 = (...artboards: unknown[]) => ({ schema: 2, name: 'Old', artboards })

  it('rewrites near-copies as variants, and draws the same', () => {
    const copy = screen('copy', 'Billing')
    const old = v2(screen('main'), copy, { ...screen('other'), root: { type: 'text', id: 'only', value: 'Different', font: '$font.body' } })
    const out = upgrade(old)!
    expect(out.to).toBe(FORMAT_VERSION)
    const [, v, other] = out.doc.artboards as Record<string, unknown>[]
    expect(v).toEqual({ id: 'copy', name: 'copy', extends: 'main', set: { title: { value: 'Billing' } } })
    expect(other.root).toBeDefined()
    expect(out.notes.join('\n')).toMatch(/1 of 3 artboards .* now variants/)

    const before = compile(old).doc.artboards.map(drawn)
    const after = compile(out.doc).doc.artboards.map(drawn)
    expect(after).toEqual(before)
  })

  it('finds copies whose ids were renumbered, and draws the same', () => {
    const renumber = (v: unknown, p: string): unknown => {
      if (Array.isArray(v)) return v.map((x) => renumber(x, p))
      if (v === null || typeof v !== 'object') return v
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = k === 'id' && typeof x === 'string' ? `${p}${x}` : renumber(x, p)
      return out
    }
    const second = screen('second', 'Billing')
    const old = v2(screen('main'), { ...second, root: renumber(second.root, 'z-') })
    const out = upgrade(old)!
    const v = (out.doc.artboards as Record<string, unknown>[])[1]
    expect(v.extends).toBe('main')
    expect(JSON.stringify(v).length).toBeLessThan(JSON.stringify(second).length / 2)
    expect(compile(out.doc).doc.artboards.map((a) => drawn(a.root)).map((r) => JSON.stringify(r).replace(/"(id|origin)":[^,]*,/g, ''))).toEqual(
      compile(old).doc.artboards.map((a) => drawn(a.root)).map((r) => JSON.stringify(r).replace(/"(id|origin)":[^,]*,/g, ''))
    )
  })

  it('leaves a file with no near-copies as it was, apart from the number', () => {
    const old = v2(screen('main'), { ...screen('other'), root: { type: 'text', id: 'only', value: 'Different' } })
    const out = upgrade(old)!
    expect(out.doc).toEqual({ ...old, schema: FORMAT_VERSION })
    expect(out.notes).toHaveLength(1)
  })

  it('keeps an artboard whole when the base has a mode or background it cannot unset', () => {
    const base = { ...screen('main'), mode: 'dark' }
    const { background: _, ...bare } = screen('copy')
    const r = toVariants([base, { ...bare } as Artboard, screen('m2') as Artboard] as Artboard[])
    // `copy` has no mode and no background where `main` has both, so it stays
    // whole; m2 cannot follow `main`'s mode either, but can follow `copy`.
    expect(r.artboards.map((a) => ('extends' in a ? a.extends : null))).toEqual([null, null, 'copy'])
  })

  it('leaves a file it cannot read for validation to explain', () => {
    const broken = { schema: 2, name: 'x', artboards: [{ id: 'a' }] }
    expect(upgrade(broken)!.doc).toEqual({ ...broken, schema: FORMAT_VERSION })
  })
})
