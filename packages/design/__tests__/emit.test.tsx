import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { compile, renderArtboard, renderStyled, styleTree, styleWithProvenance } from '../src/pipeline'
import type { ResolvedNode } from '../src/pipeline/types'
import { NODES, RENDERABLE_KINDS } from '../src/registry/nodes'
import { PROPS } from '../src/registry/props'
import { propNamesFor } from '../src/registry/shapes'
import type { PropName } from '../src/registry/types'
import { defaultTheme } from '../src/theme/default'
import { isTokenPath, lookupToken, resolveDeep } from '../src/theme/resolve'

const worked = JSON.parse(
  readFileSync(resolve(__dirname, '../examples/settings.nyui.json'), 'utf8')
) as unknown

/**
 * The spec's discipline: no property is handled by a branch in the renderer.
 *
 * Enforced by behaviour rather than by grepping the emitter for `node.type ===`.
 * A grep breaks when someone renames `node` to `n`, and `const t = node.type`
 * evades it without trying. This asserts the thing the rule exists to protect:
 * every CSS declaration the emitter produces is attributable to a property
 * record or to a node's one declared `derive`.
 */
describe('CSS provenance', () => {
  it.each(RENDERABLE_KINDS)('every style key a %s emits comes from the registry', (kind) => {
    const node = { type: kind, id: 'n', origin: { scope: 's', id: 'n' } } as Record<string, unknown>
    for (const name of propNamesFor(kind)) {
      const ex = PROPS[name].examples[0]
      node[name] = resolveDeep(ex, defaultTheme)
    }
    if (kind === 'box') node.children = []

    const { style, by } = styleWithProvenance(node as unknown as ResolvedNode, [], defaultTheme)

    expect(Object.keys(style).length).toBeGreaterThan(0)
    for (const key of Object.keys(style)) {
      const source = by[key]
      expect(source, `${kind} emitted "${key}" with no property record behind it`).toBeDefined()
      const known = source === 'derive' || (source in PROPS && propNamesFor(kind).includes(source as PropName))
      expect(known, `${kind}: "${key}" came from "${String(source)}", which does not apply to it`).toBe(true)
    }
  })

  it('attributes the positioning context to the node definition, not to a hidden branch', () => {
    const child = {
      type: 'text',
      id: 'c',
      origin: { scope: 's', id: 'c' },
      value: 'x',
      position: 'absolute'
    } as unknown as ResolvedNode
    const parent = {
      type: 'box',
      id: 'p',
      origin: { scope: 's', id: 'p' },
      children: [child]
    } as unknown as ResolvedNode

    const tree = styleTree(parent, defaultTheme)
    expect(tree.style.position).toBe('relative')

    const { by } = styleWithProvenance(parent, [{ position: 'absolute' }], defaultTheme)
    expect(by.position).toBe('derive')
    expect(NODES.box.derive).toBeDefined()
  })

  it('lets an explicit position win over the derived one', () => {
    const child = {
      type: 'text',
      id: 'c',
      origin: { scope: 's', id: 'c' },
      value: 'x',
      position: 'absolute'
    } as unknown as ResolvedNode
    const parent = {
      type: 'box',
      id: 'p',
      origin: { scope: 's', id: 'p' },
      position: 'absolute',
      children: [child]
    } as unknown as ResolvedNode
    expect(styleTree(parent, defaultTheme).style.position).toBe('absolute')
  })

  it('does not add a positioning context to a box that does not need one', () => {
    const parent = {
      type: 'box',
      id: 'p',
      origin: { scope: 's', id: 'p' },
      children: []
    } as unknown as ResolvedNode
    expect(styleTree(parent, defaultTheme).style.position).toBeUndefined()
  })
})

describe('emitted markup', () => {
  it('renders the worked example', () => {
    const { doc, theme } = compile(worked)
    const html = renderToStaticMarkup(renderArtboard(doc.artboards[0], theme))
    expect(html).toContain('Save changes')
    expect(html).toContain('Cancel')
    // The accent token reached CSS as a colour, not as a token path.
    expect(html).toContain('#6E56CF')
    expect(html).not.toContain('$color')
    expect(html).not.toContain('$space')
  })

  it('draws an icon as inline SVG from lucide node data', () => {
    const { doc, theme } = compile({
      schema: 1,
      name: 'Icon',
      artboards: [
        {
          id: 'a',
          name: 'A',
          size: { width: 100, height: 100 },
          root: { id: 'i', type: 'icon', name: 'circle-check', size: 24, color: '$color.accent' }
        }
      ]
    })
    const html = renderToStaticMarkup(renderArtboard(doc.artboards[0], theme))
    expect(html).toContain('<svg')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('#6E56CF')
  })

  it('refuses an icon name that does not exist, rather than rendering a hole', () => {
    expect(() =>
      compile({
        schema: 1,
        name: 'Icon',
        artboards: [
          {
            id: 'a',
            name: 'A',
            size: { width: 100, height: 100 },
            root: { id: 'i', type: 'icon', name: 'not-a-real-icon' }
          }
        ]
      })
    ).toThrow(/error/)
  })

  it('still draws a marked hole if an unknown icon reaches the emitter anyway', () => {
    // Defence in depth: the validator is the gate, but a node built by hand in
    // a test or a future inspector should not take the renderer down.
    const node = {
      type: 'icon',
      id: 'i',
      origin: { scope: 's', id: 'i' },
      name: 'not-a-real-icon'
    } as unknown as ResolvedNode
    const html = renderToStaticMarkup(renderStyled(styleTree(node, defaultTheme)))
    expect(html).toContain('unknown icon')
  })

  it('refuses to emit an unresolved token, rather than writing it into CSS', () => {
    const node = {
      type: 'box',
      id: 'b',
      origin: { scope: 's', id: 'b' },
      children: [],
      gap: '$space.2'
    } as unknown as ResolvedNode
    expect(() => styleTree(node, defaultTheme)).toThrow(/unresolved token/)
  })

  it('every resolved node carries a stable id and an authored origin', () => {
    const { doc } = compile(worked)
    const seen: string[] = []
    const walk = (n: ResolvedNode): void => {
      expect(n.id).toMatch(/^[^#]+#[^#]+$/)
      expect(n.origin.scope.length).toBeGreaterThan(0)
      seen.push(n.id)
      if (n.type === 'box') n.children.forEach(walk)
    }
    doc.artboards.forEach((a) => walk(a.root))
    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('snapshots', () => {
  it('resolved document', () => {
    const { doc } = compile(worked)
    expect(doc).toMatchSnapshot()
  })

  it('emitted html', () => {
    const { doc, theme } = compile(worked)
    expect(renderToStaticMarkup(renderArtboard(doc.artboards[0], theme))).toMatchSnapshot()
  })
})

describe('the theme is self-contained', () => {
  it('every alias resolves without reaching outside the package', () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (isTokenPath(node)) expect(() => lookupToken(defaultTheme, node), path).not.toThrow()
        return
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
      }
    }
    walk(defaultTheme.color, '$color')
    walk(defaultTheme.border, '$border')
  })
})
