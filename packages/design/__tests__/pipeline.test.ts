import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile, resolveComponents, resolveTokens, styleTree, validate } from '../src/pipeline'
import { PipelineError } from '../src/pipeline/types'
import { defaultTheme } from '../src/theme/default'
import type { DesignDocument } from '../src/schema'

const worked = JSON.parse(
  readFileSync(resolve(__dirname, '../examples/settings.nyui.json'), 'utf8')
) as unknown

const doc = (over: Record<string, unknown> = {}): unknown => ({
  schema: 1,
  name: 'T',
  artboards: [
    {
      id: 'a',
      name: 'A',
      size: { width: 200, height: 200 },
      root: { id: 'root', type: 'box', layout: 'stack' }
    }
  ],
  ...over
})

describe('validate', () => {
  it('accepts the spec worked example', () => {
    const r = validate(worked)
    expect(r.ok).toBe(true)
  })

  it('refuses a schema version it does not understand', () => {
    const r = validate(doc({ schema: 99 }))
    expect(r.ok).toBe(false)
    expect(r.issues[0].code).toBe('schema-version')
  })

  it('catches a misspelled property instead of dropping it', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'root', type: 'box', paddign: 4 }
          }
        ]
      })
    )
    expect(r.ok).toBe(false)
  })

  it('catches duplicate ids within one scope', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: {
              id: 'root',
              type: 'box',
              children: [
                { id: 'x', type: 'text', value: 'a' },
                { id: 'x', type: 'text', value: 'b' }
              ]
            }
          }
        ]
      })
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'duplicate-id')).toBe(true)
  })

  it('rejects a { prop } reference in an artboard, which has no props', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'root', type: 'text', value: { prop: 'label' } }
          }
        ]
      })
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'prop-ref-outside-component')).toBe(true)
  })

  const withComponent = (root: unknown, props: unknown = { label: { type: 'string' } }): unknown =>
    doc({ components: { C: { props, root } } })

  it('rejects a reference to an undeclared component prop', () => {
    const r = validate(
      withComponent({ id: 'r', type: 'text', value: { prop: 'nope' } })
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'unknown-prop-ref')).toBe(true)
  })

  it('rejects a match that cannot cover its enum and has no default', () => {
    const r = validate(
      withComponent(
        {
          id: 'r',
          type: 'text',
          value: 'x',
          color: { match: { prop: 'v' }, cases: { a: '$color.text' } }
        },
        { v: { type: 'enum', of: ['a', 'b'] } }
      )
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'match-not-exhaustive')).toBe(true)
  })

  it('rejects a match case the prop can never be', () => {
    const r = validate(
      withComponent(
        {
          id: 'r',
          type: 'text',
          value: 'x',
          color: { match: { prop: 'v' }, cases: { a: '$color.text', z: '$color.text' } }
        },
        { v: { type: 'enum', of: ['a'] } }
      )
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'match-unknown-case').valueOf()).toBe(true)
  })

  it('warns about a raw literal where a token exists, without failing', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'root', type: 'box', layout: 'stack', gap: 12 }
          }
        ]
      })
    )
    expect(r.ok).toBe(true)
    expect(r.issues.some((i) => i.code === 'raw-literal' && i.severity === 'warning')).toBe(true)
  })

  it('warns about a property that cannot take effect', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'root', type: 'box', layout: 'none', align: 'center' }
          }
        ]
      })
    )
    expect(r.ok).toBe(true)
    expect(r.issues.some((i) => i.code === 'no-effect')).toBe(true)
  })

  it('catches a missing instance prop with no default', () => {
    const r = validate(
      doc({
        components: { C: { props: { label: { type: 'string' } }, root: { id: 'r', type: 'text', value: { prop: 'label' } } } },
        artboards: [
          { id: 'a', name: 'A', size: { width: 200, height: 200 }, root: { id: 'root', use: 'C' } }
        ]
      })
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'missing-instance-prop')).toBe(true)
  })
})

describe('resolve components', () => {
  const parsed = validate(worked)
  const good = parsed.ok ? (parsed.doc as DesignDocument) : null

  it('substitutes props at depth and namespaces ids per instance', () => {
    const root = resolveComponents(good!, 'settings-general')
    const flat: { id: string; origin: string }[] = []
    const walk = (n: ReturnType<typeof resolveComponents>): void => {
      flat.push({ id: n.id, origin: `${n.origin.scope}#${n.origin.id}` })
      if (n.type === 'box') n.children.forEach(walk)
    }
    walk(root)
    const ids = flat.map((f) => f.id)
    expect(ids).toContain('settings-general#save/label')
    expect(ids).toContain('settings-general#cancel/label')
    // Two instances of one component never collide.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('points each resolved node at the authored node a patch can mutate', () => {
    const root = resolveComponents(good!, 'settings-general')
    const actions = root.type === 'box' ? root.children[1] : null
    const save = actions?.type === 'box' ? actions.children[0] : null
    // The instance keeps the caller's identity...
    expect(save?.origin).toEqual({ scope: 'settings-general', id: 'save' })
    // ...while its inner nodes point into the component.
    const label = save?.type === 'box' ? save.children[0] : null
    expect(label?.origin).toEqual({ scope: 'Button', id: 'label' })
  })

  it('picks the right match case per instance', () => {
    const root = resolveComponents(good!, 'settings-general')
    const actions = root.type === 'box' ? root.children[1] : null
    const [save, cancel] = actions?.type === 'box' ? actions.children : []
    expect(save?.type === 'box' && save.background).toBe('$color.accent')
    expect(cancel?.type === 'box' && cancel.background).toBe('$color.transparent')
  })

  it('merges a use instance outer-layout property onto the component root', () => {
    const withGrow = JSON.parse(JSON.stringify(worked)) as Record<string, never>
    const artboards = (withGrow as unknown as DesignDocument).artboards
    const actions = (artboards[0].root as unknown as { children: unknown[] }).children[1] as {
      children: Record<string, unknown>[]
    }
    actions.children[0].grow = 1
    const parsed2 = validate(withGrow)
    expect(parsed2.ok).toBe(true)
    const root = resolveComponents((parsed2 as { doc: DesignDocument }).doc, 'settings-general')
    const acts = root.type === 'box' ? root.children[1] : null
    const save = acts?.type === 'box' ? acts.children[0] : null
    expect(save?.type === 'box' && save.grow).toBe(1)
  })

  it('refuses a component that uses itself rather than overflowing the stack', () => {
    const r = validate(
      doc({
        components: { C: { root: { id: 'r', type: 'box', children: [{ id: 'inner', use: 'C' }] } } },
        artboards: [{ id: 'a', name: 'A', size: { width: 200, height: 200 }, root: { id: 'root', use: 'C' } }]
      })
    )
    expect(r.ok).toBe(true)
    expect(() => resolveComponents((r as { doc: DesignDocument }).doc, 'a')).toThrow(PipelineError)
  })

  it('concatenates an array of forms into one string', () => {
    const r = validate(
      doc({
        components: {
          C: {
            props: { name: { type: 'string' } },
            root: { id: 'r', type: 'text', value: ['Hello, ', { prop: 'name' }, '!'] }
          }
        },
        artboards: [
          { id: 'a', name: 'A', size: { width: 200, height: 200 }, root: { id: 'root', use: 'C', props: { name: 'Ada' } } }
        ]
      })
    )
    const root = resolveComponents((r as { doc: DesignDocument }).doc, 'a')
    expect(root.type === 'text' && root.value).toBe('Hello, Ada!')
  })
})

describe('resolve tokens', () => {
  const parsed = validate(worked)
  const good = parsed.ok ? (parsed.doc as DesignDocument) : null

  it('chases an alias to a concrete value', () => {
    const resolved = resolveTokens(resolveComponents(good!, 'settings-general'), defaultTheme)
    const actions = resolved.type === 'box' ? resolved.children[1] : null
    const save = actions?.type === 'box' ? actions.children[0] : null
    // $color.accent -> $color.violet.600 -> #6E56CF
    expect(save?.type === 'box' && save.background).toBe('#6E56CF')
  })

  it('leaves text alone, so a price is not mistaken for a token', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'root', type: 'text', value: '$space.2 is not a token here', font: '$font.body' }
          }
        ]
      })
    )
    const out = resolveTokens(resolveComponents((r as { doc: DesignDocument }).doc, 'a'), defaultTheme)
    expect(out.type === 'text' && out.value).toBe('$space.2 is not a token here')
    expect(out.type === 'text' && typeof out.font).toBe('object')
  })

  it('reports an unknown token rather than rendering it', () => {
    const r = validate(
      doc({
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'root', type: 'box', layout: 'stack', gap: '$space.999' }
          }
        ]
      })
    )
    expect(() =>
      resolveTokens(resolveComponents((r as { doc: DesignDocument }).doc, 'a'), defaultTheme)
    ).toThrow(/unknown token/)
  })
})

describe('compile', () => {
  it('runs all four stages over the worked example', () => {
    const { doc: out, issues } = compile(worked)
    expect(out.artboards).toHaveLength(1)
    expect(out.artboards[0].background).toBe('#FAFAFB')
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })
})

describe('inline text runs', () => {
  const runDoc = (value: unknown): unknown => ({
    schema: 1,
    name: 'T',
    artboards: [
      {
        id: 'a',
        name: 'A',
        size: { width: 400, height: 200 },
        root: { id: 't', type: 'text', value, font: '$font.body' }
      }
    ]
  })

  it('keeps a plain array collapsing to one string', () => {
    const { doc } = compile(runDoc(['Hello, ', 'world']))
    expect(doc.artboards[0].root.type === 'text' && doc.artboards[0].root.value).toBe('Hello, world')
  })

  it('keeps runs as runs the moment one carries styling', () => {
    const { doc } = compile(runDoc(['Read the ', { text: 'docs', weight: 700 }, ' first.']))
    const v = doc.artboards[0].root.type === 'text' ? doc.artboards[0].root.value : null
    expect(Array.isArray(v)).toBe(true)
    expect(v).toEqual([
      { text: 'Read the ' },
      { text: 'docs', weight: 700 },
      { text: ' first.' }
    ])
  })

  it('resolves a token inside a run without touching the run text', () => {
    const { doc } = compile(runDoc([{ text: '$space.2 stays', color: '$color.accent' }]))
    const v = doc.artboards[0].root.type === 'text' ? doc.artboards[0].root.value : null
    expect(v).toEqual([{ text: '$space.2 stays', color: '#6E56CF', font: undefined }])
  })

  it('substitutes a component prop into a run', () => {
    const { doc } = compile({
      schema: 1,
      name: 'T',
      components: {
        C: {
          props: { who: { type: 'string' } },
          root: {
            id: 'r',
            type: 'text',
            value: ['Hi ', { text: { prop: 'who' }, weight: 700 }, '!'],
            font: '$font.body'
          }
        }
      },
      artboards: [
        {
          id: 'a',
          name: 'A',
          size: { width: 400, height: 200 },
          root: { id: 'u', use: 'C', props: { who: 'Ada' } }
        }
      ]
    })
    const v = doc.artboards[0].root.type === 'text' ? doc.artboards[0].root.value : null
    expect(v).toEqual([{ text: 'Hi ' }, { text: 'Ada', weight: 700 }, { text: '!' }])
  })

  it('rejects a run with an unknown field', () => {
    const r = validate(runDoc([{ text: 'x', bold: true }]))
    expect(r.ok).toBe(false)
  })
})

describe('artboards', () => {
  const ab = (size: unknown, root: unknown): unknown => ({
    schema: 1,
    name: 'T',
    artboards: [{ id: 'a', name: 'A', size, root }]
  })

  it('accepts an auto height', () => {
    const r = validate(ab({ width: 400, height: 'auto' }, { id: 'r', type: 'box', layout: 'stack' }))
    expect(r.ok).toBe(true)
  })

  it('rejects any other height keyword', () => {
    const r = validate(ab({ width: 400, height: 'full' }, { id: 'r', type: 'box', layout: 'stack' }))
    expect(r.ok).toBe(false)
  })
})

describe('percentage spacing', () => {
  const box = (props: Record<string, unknown>): unknown => ({
    schema: 1,
    name: 'T',
    artboards: [
      {
        id: 'a',
        name: 'A',
        size: { width: 400, height: 400 },
        root: { id: 'r', type: 'box', layout: 'stack', ...props }
      }
    ]
  })

  it('accepts a percentage gap, padding and inset', () => {
    expect(validate(box({ gap: '4%' })).ok).toBe(true)
    expect(validate(box({ padding: ['$space.2', '5%'] })).ok).toBe(true)
    expect(
      validate(box({ position: 'absolute', inset: { top: '50%', left: '50%' } })).ok
    ).toBe(true)
  })

  it('rejects a percentage outside 0-100', () => {
    expect(validate(box({ gap: '140%' })).ok).toBe(false)
    expect(validate(box({ gap: '4 %' })).ok).toBe(false)
  })

  it('emits the percentage through rather than converting it to px', () => {
    const { doc, theme } = compile(box({ gap: '4%', padding: ['$space.2', '5%'] }))
    const s = styleTree(doc.artboards[0].root, theme).style
    expect(s.gap).toBe('4%')
    expect(s.padding).toBe('8px 5%')
  })

  it('warns when a padding percentage lands on a vertical edge', () => {
    // CSS resolves it against WIDTH there, which is the surprise worth naming.
    const vertical = compile(box({ padding: ['5%', '$space.2'] }))
    expect(vertical.issues.some((i) => i.code === 'percent-padding')).toBe(true)

    const horizontal = compile(box({ padding: ['$space.2', '5%'] }))
    expect(horizontal.issues.some((i) => i.code === 'percent-padding')).toBe(false)
  })
})

describe('min and max height', () => {
  it('hold a box open and cap it', () => {
    const { doc, theme } = compile({
      schema: 1,
      name: 'T',
      artboards: [
        {
          id: 'a',
          name: 'A',
          size: { width: 400, height: 400 },
          root: {
            id: 'r',
            type: 'box',
            layout: 'stack',
            minHeight: 120,
            maxHeight: '75%',
            overflow: 'scroll'
          }
        }
      ]
    })
    const s = styleTree(doc.artboards[0].root, theme).style
    expect(s.minHeight).toBe('120px')
    expect(s.maxHeight).toBe('75%')
  })
})

describe('null means unset', () => {
  const doc2 = (cases: Record<string, unknown>): unknown => ({
    schema: 1,
    name: 'T',
    components: {
      C: {
        props: { axis: { type: 'enum', of: ['h', 'v'], default: 'h' } },
        root: {
          id: 'r',
          type: 'box',
          layout: 'none',
          alignSelf: 'stretch',
          height: { match: { prop: 'axis' }, cases }
        }
      }
    },
    artboards: [
      {
        id: 'a',
        name: 'A',
        size: { width: 200, height: 200 },
        root: {
          id: 'row',
          type: 'box',
          layout: 'stack',
          direction: 'row',
          children: [{ id: 'u', use: 'C', props: { axis: 'v' } }]
        }
      }
    ]
  })

  it('drops the key entirely rather than emitting a value', () => {
    const { doc } = compile(doc2({ h: 1, v: null }))
    const row = doc.artboards[0].root
    const div = row.type === 'box' ? row.children[0] : null
    expect(div && 'height' in div).toBe(false)
    // The other branch still sets it.
    const { doc: other } = compile(doc2({ h: 1, v: 2 }))
    const row2 = other.artboards[0].root
    expect(row2.type === 'box' && row2.children[0].type === 'box' && row2.children[0].height).toBe(2)
  })

  it('never reaches CSS, so stretch is not defeated by an explicit size', () => {
    // The bug this exists for: an explicit cross-axis size makes
    // `align-self: stretch` a no-op, and `height: 100%` against an auto-height
    // parent computes to zero. A vertical divider must set no height at all.
    const { doc, theme } = compile(doc2({ h: 1, v: null }))
    const row = doc.artboards[0].root
    const div = row.type === 'box' ? row.children[0] : null
    const style = styleTree(div!, theme).style
    expect(style.height).toBeUndefined()
    expect(style.alignSelf).toBe('stretch')
  })

  it('rejects a required property that resolves to nothing', () => {
    expect(() =>
      compile({
        schema: 1,
        name: 'T',
        components: {
          C: {
            props: { on: { type: 'enum', of: ['yes', 'no'], default: 'no' } },
            root: {
              id: 'r',
              type: 'text',
              value: { match: { prop: 'on' }, cases: { yes: 'hi', no: null } },
              font: '$font.body'
            }
          }
        },
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 200, height: 200 },
            root: { id: 'u', use: 'C' }
          }
        ]
      })
    ).toThrow(/required/)
  })
})

describe('the raw-literal lint does not argue with the schema', () => {
  const box = (props: Record<string, unknown>): unknown => ({
    schema: 1,
    name: 'T',
    artboards: [
      {
        id: 'a',
        name: 'A',
        size: { width: 200, height: 200 },
        root: { id: 'r', type: 'box', layout: 'stack', ...props }
      }
    ]
  })

  /**
   * Found by a cold session's first design: it wrote `shadow: "none"`, which
   * the property's own schema offers, and got told a token would survive a
   * theme change better. There is no theme in which "none" becomes something
   * else — and a lint that is wrong is a channel the model learns to ignore.
   */
  it.each([
    ['shadow', 'none'],
    ['background', 'transparent'],
    ['width', 'full'],
    ['width', 'fit'],
    ['gap', 0],
    ['padding', 0]
  ])('does not flag %s: %s', (prop, value) => {
    const { issues } = compile(box({ [prop]: value }))
    expect(issues.filter((i) => i.code === 'raw-literal')).toHaveLength(0)
  })

  it('still flags a value a theme really should own', () => {
    const { issues } = compile(box({ gap: 12 }))
    expect(issues.some((i) => i.code === 'raw-literal')).toBe(true)
    const colour = compile(box({ background: '#ff0000' }))
    expect(colour.issues.some((i) => i.code === 'raw-literal')).toBe(true)
  })
})
