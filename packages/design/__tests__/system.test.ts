import { describe, expect, it } from 'vitest'
import {
  apply,
  buildRegistry,
  compile,
  defaultTheme,
  invert,
  loadTokens,
  lookupToken,
  modesOf,
  SCHEMA_VERSION,
  themeFor,
  tokenPaths,
  upgrade,
  validate,
  type DesignDocument,
  type Issue,
  type ResolvedNode
} from '../src'

const V = SCHEMA_VERSION

/** A Group whose body is a slot, used by an artboard that fills it. */
const groupDoc = (body: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  schema: V,
  name: 'Inspector',
  components: {
    Group: {
      props: { title: { type: 'string' }, body: { type: 'slot' } },
      root: {
        id: 'root',
        type: 'box',
        children: [{ id: 'head', type: 'text', value: { prop: 'title' } }, { slot: 'body' }]
      }
    },
    ...extra
  },
  artboards: [
    {
      id: 'panel',
      name: 'Panel',
      size: { width: 320, height: 'auto' },
      root: {
        id: 'page',
        type: 'box',
        children: [{ id: 'anim', use: 'Group', props: { title: 'Animation' }, slots: { body } }]
      }
    }
  ]
})

const codes = (issues: Issue[]): string[] => issues.map((i) => i.code)
const find = (n: ResolvedNode, id: string): ResolvedNode | undefined => {
  if (n.id === id) return n
  for (const c of n.type === 'box' ? n.children : []) {
    const hit = find(c, id)
    if (hit) return hit
  }
}

describe('slots', () => {
  it('put the caller\'s nodes where the component says, named in the caller\'s scope', () => {
    const { doc } = compile(groupDoc([{ id: 'fade', type: 'text', value: 'Fade in' }]))
    const root = doc.artboards[0].root
    const group = root.type === 'box' ? root.children[0] : null
    expect(group?.type === 'box' && group.children.map((c) => c.id)).toEqual([
      'panel#anim/head',
      // Authored in the artboard, so it keeps the artboard's path and origin —
      // a comment on it points at the artboard's file, not the component's.
      'panel#fade'
    ])
    expect(find(root, 'panel#fade')?.origin).toEqual({ scope: 'panel', id: 'fade' })
  })

  it('an unfilled slot is empty, not an error', () => {
    const doc = groupDoc([]) as { artboards: { root: { children: { slots?: unknown }[] } }[] }
    delete doc.artboards[0].root.children[0].slots
    const out = compile(doc)
    const group = out.doc.artboards[0].root
    expect(group.type === 'box' && group.children[0].type === 'box' && group.children[0].children.length).toBe(1)
    expect(out.issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('a Card inside a Card\'s body is not a cycle', () => {
    const doc = groupDoc([{ id: 'inner', use: 'Group', props: { title: 'Nested' }, slots: { body: [] } }])
    expect(() => compile(doc)).not.toThrow()
  })

  it('a component can forward its own slot into another one', () => {
    const doc = groupDoc([{ id: 'x', type: 'text', value: 'deep' }], {
      Panel: {
        props: { content: { type: 'slot' } },
        root: { id: 'frame', type: 'box', children: [{ id: 'inner', use: 'Group', props: { title: 'In' }, slots: { body: [{ slot: 'content' }] } }] }
      }
    }) as { artboards: { root: { children: unknown[] } }[] }
    doc.artboards[0].root.children = [{ id: 'p', use: 'Panel', slots: { content: [{ id: 'x', type: 'text', value: 'deep' }] } }]
    const { doc: out } = compile(doc)
    expect(find(out.artboards[0].root, 'panel#x')).toBeDefined()
  })

  it.each([
    [
      'a slot in an artboard',
      (d: Record<string, any>) => d.artboards[0].root.children.push({ slot: 'body' }),
      'slot-outside-component'
    ],
    [
      'a slot that was never declared',
      (d: Record<string, any>) => d.components.Group.root.children.push({ slot: 'footer' }),
      'unknown-slot'
    ],
    [
      'a slot placed twice',
      (d: Record<string, any>) => d.components.Group.root.children.push({ slot: 'body' }),
      'slot-placed-twice'
    ],
    [
      'a slot used as a value',
      (d: Record<string, any>) => (d.components.Group.root.children[0].value = { prop: 'body' }),
      'slot-as-value'
    ],
    [
      'slot content passed as a prop',
      (d: Record<string, any>) => (d.artboards[0].root.children[0].props.body = []),
      'slot-in-props'
    ],
    [
      'content for a slot the component lacks',
      (d: Record<string, any>) => (d.artboards[0].root.children[0].slots.footer = []),
      'unknown-instance-slot'
    ]
  ])('rejects %s', (_label, mutate, code) => {
    const doc = groupDoc([{ id: 'a', type: 'text', value: 'x' }]) as Record<string, any>
    mutate(doc)
    const r = validate(doc)
    expect(codes(r.issues)).toContain(code)
  })

  it('checks slotted nodes for duplicate ids in the caller\'s tree', () => {
    const doc = groupDoc([{ id: 'page', type: 'text', value: 'clash' }])
    expect(codes(validate(doc).issues)).toContain('duplicate-id')
  })
})

describe('one namespace across a system', () => {
  const button = {
    schema: V,
    name: 'Button',
    components: { Button: { props: { label: { type: 'string' } }, root: { id: 'b', type: 'text', value: { prop: 'label' } } } },
    artboards: [{ id: 'specimens', name: 'Specimens', size: { width: 200, height: 'auto' }, root: { id: 's', use: 'Button', props: { label: 'Go' } } }]
  }
  const screen = {
    schema: V,
    name: 'Settings',
    artboards: [{ id: 'settings', name: 'Settings', size: { width: 400, height: 'auto' }, root: { id: 'save', use: 'Button', props: { label: 'Save' } } }]
  }

  it('a screen uses a component from another file, and nodes name their file', () => {
    const { registry, issues } = buildRegistry([
      { file: 'components/button.nyui.json', doc: button as unknown as DesignDocument },
      { file: 'screens/settings.nyui.json', doc: screen as unknown as DesignDocument }
    ])
    expect(issues).toEqual([])
    const { doc } = compile(screen, { registry, file: 'screens/settings.nyui.json' })
    const root = doc.artboards[0].root
    // The instance is the screen's node; what is inside it is the component's.
    expect(root.origin).toEqual({ scope: 'settings', id: 'save', file: 'screens/settings.nyui.json' })
    expect(compile(button, { registry, file: 'components/button.nyui.json' }).doc.artboards[0].root.origin.file).toBe(
      'components/button.nyui.json'
    )
  })

  it('a name defined twice is reported once, naming both files, and using it is an error', () => {
    const other = { ...button, name: 'Other' }
    const { registry, issues } = buildRegistry([
      { file: 'components/button.nyui.json', doc: button as unknown as DesignDocument },
      { file: 'components/legacy.nyui.json', doc: other as unknown as DesignDocument }
    ])
    expect(codes(issues)).toEqual(['duplicate-component'])
    expect(issues[0].message).toContain('components/button.nyui.json')
    expect(issues[0].message).toContain('components/legacy.nyui.json')
    const r = validate(screen, { registry })
    expect(codes(r.issues)).toContain('ambiguous-component')
  })

  it('an artboard named like a component is an error', () => {
    const clash = { ...button, artboards: [{ ...button.artboards[0], id: 'Button' }] }
    expect(codes(validate(clash).issues)).toContain('artboard-shadows-component')
  })

  it('issues raised in a file carry its path', () => {
    const bad = { ...screen, artboards: [{ ...screen.artboards[0], root: { id: 'x', type: 'box', gap: 13 } }] }
    const { issues } = compile(bad, { file: 'screens/settings.nyui.json' })
    expect(issues.some((i) => i.at?.file === 'screens/settings.nyui.json')).toBe(true)
  })
})

describe('tokens and modes', () => {
  const tokens = {
    schema: V,
    baseMode: 'light',
    color: {
      transparent: 'transparent',
      gray: { '50': '#FAFAFA', '900': '#111111' },
      bg: '$color.gray.50',
      text: '$color.gray.900'
    },
    space: { '2': 8 },
    radius: { md: 8 },
    shadow: { none: 'none' },
    border: {},
    font: { body: { family: 'Inter', size: 14, weight: 400, lineHeight: 1.5 } },
    modes: { dark: { color: { bg: '$color.gray.900', text: '$color.gray.50' } } }
  }

  it('loads, and a mode lays its aliases over the base', () => {
    const r = loadTokens(tokens)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(modesOf(r.tokens)).toEqual(['light', 'dark'])
    expect(lookupToken(themeFor(r.tokens, 'light'), '$color.bg')).toBe('#FAFAFA')
    expect(lookupToken(themeFor(r.tokens, 'dark'), '$color.bg')).toBe('#111111')
    // One theme object per mode, so every artboard in a mode shares it.
    expect(themeFor(r.tokens, 'dark')).toBe(themeFor(r.tokens, 'dark'))
  })

  it.each([
    ['without font.body', { font: {} }, /font\.body/],
    ['without color.transparent', { color: { bg: '#fff' } }, /transparent/],
    ['with a key a token path cannot name', { space: { 'gap-lg': 24 } }, /letters and digits/],
    ['with a mode that adds a token', { modes: { dark: { space: { '9': 36 } } } }, /\$space\.9/]
  ])('refuses tokens %s', (_label, patch, message) => {
    const r = loadTokens({ ...tokens, ...patch })
    expect(r.ok).toBe(false)
    expect(r.issues.join('\n')).toMatch(message)
  })

  it('an artboard pinned to a mode is resolved in it', () => {
    const r = loadTokens(tokens)
    if (!r.ok) throw new Error('tokens')
    const doc = {
      schema: V,
      name: 'Modes',
      artboards: [
        { id: 'day', name: 'Day', size: { width: 100, height: 100 }, root: { id: 'r', type: 'box', background: '$color.bg' } },
        { id: 'night', name: 'Night', mode: 'dark', size: { width: 100, height: 100 }, root: { id: 'r', type: 'box', background: '$color.bg' } },
        { id: 'odd', name: 'Odd', mode: 'sepia', size: { width: 100, height: 100 }, root: { id: 'r', type: 'box' } }
      ]
    }
    const out = compile(doc, {
      theme: themeFor(r.tokens, 'light'),
      modes: { light: themeFor(r.tokens, 'light'), dark: themeFor(r.tokens, 'dark') }
    })
    const [day, night] = out.doc.artboards
    expect((day.root as { background?: string }).background).toBe('#FAFAFA')
    expect((night.root as { background?: string }).background).toBe('#111111')
    expect(night.mode).toBe('dark')
    expect(codes(out.issues)).toContain('unknown-mode')
  })

  it('a theme name is ignored, with a warning, when a system supplies the theme', () => {
    const doc = { schema: V, name: 'T', theme: 'brand', artboards: [{ id: 'a', name: 'A', size: { width: 100, height: 100 }, root: { id: 'r', type: 'box' } }] }
    const out = compile(doc, { theme: defaultTheme, themes: { brand: defaultTheme } })
    expect(codes(out.issues)).toContain('theme-ignored')
  })
})

describe('theme lookups', () => {
  it('never answers with something off the prototype', () => {
    expect(() => lookupToken(defaultTheme, '$color.constructor')).toThrow(/unknown token/)
  })

  it('a colour step named like a font field is still a ramp step', () => {
    const theme = { ...defaultTheme, color: { ...defaultTheme.color, chart: { size: '#123456', weight: '#654321' } } }
    const paths = tokenPaths(theme)
    expect(paths).toContain('$color.chart.size')
    expect(paths).toContain('$color.chart.weight')
    expect(paths).not.toContain('$color.chart')
    expect(paths).toContain('$font.body')
    expect(paths).not.toContain('$font.body.size')
  })
})

describe('patches into slots', () => {
  const base = (): DesignDocument => {
    const r = validate(groupDoc([{ id: 'a', type: 'text', value: 'a' }]))
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    return r.doc
  }

  it('inserts into a slot, and the undo takes it back out', () => {
    const doc = base()
    const patch = { op: 'insertNode' as const, parent: { scope: 'panel', id: 'anim' }, index: 1, slot: 'body', node: { id: 'b', type: 'text' as const, value: 'b' } }
    const undo = invert(apply(doc, patch), { op: 'removeNode', at: { scope: 'panel', id: 'b' } })
    const after = apply(doc, patch)
    const slots = (after.artboards[0].root as { children: { slots?: Record<string, { id?: string }[]> }[] }).children[0].slots
    expect(slots?.body.map((n) => n.id)).toEqual(['a', 'b'])
    expect(undo).toMatchObject({ op: 'insertNode', slot: 'body', index: 1 })
  })

  it('removes the right node when a slot reference sits before it', () => {
    const doc = base()
    const group = doc.components!.Group
    ;(group.root as { children: unknown[] }).children.unshift({ slot: 'body' })
    ;(group.root as { children: unknown[] }).children.splice(2, 1)
    // children: [{slot}, head] — removing "head" must splice index 1, not 0.
    const after = apply(doc, { op: 'removeNode', at: { scope: 'Group', id: 'head' } })
    expect((after.components!.Group.root as { children: unknown[] }).children).toEqual([{ slot: 'body' }])
  })
})

describe('v1 files', () => {
  it('open as v2, untouched, and say so', () => {
    const v1 = { schema: 1, name: 'Old', artboards: [{ id: 'a', name: 'A', size: { width: 100, height: 100 }, root: { id: 'r', type: 'box' } }] }
    const out = compile(v1)
    expect(out.upgrade?.from).toBe(1)
    expect(out.upgrade?.to).toBe(V)
    expect(out.upgrade?.doc.schema).toBe(V)
    expect(v1.schema).toBe(1)
    expect(upgrade({ ...v1, schema: V })).toBeNull()
  })
})
