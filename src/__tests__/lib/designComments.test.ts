import { describe, expect, it } from 'vitest'
import { FORMAT_VERSION, defaultTokens as tokensOf, type ResolvedArtboard } from '@nyra/design'
import {
  commentBody,
  describeTarget,
  findNode,
  relocate,
  since,
  targetTag,
  threadOf,
  type CommentAnchor
} from '../../renderer/src/lib/designComments'
import { assemble, compileContextFor, type Cached } from '../../renderer/src/lib/designSystem'
import { compileText } from '../../renderer/src/lib/designCompile'
import type { SystemEntry, SystemFileKind } from '../../renderer/src/lib/api-types'

const entry: SystemEntry = {
  id: 's_1',
  name: 'Closeup',
  root: '/repo/design',
  project: '/repo',
  updatedAt: '',
  previousRoots: [],
  projectSkill: false
}

const file = (rel: string, kind: SystemFileKind, json: unknown): Cached => ({
  info: { path: `/repo/design/${rel}`, rel, kind, size: 10, mtimeMs: 1 },
  text: JSON.stringify(json),
  json
})

const components = {
  schema: FORMAT_VERSION,
  name: 'Parts',
  components: {
    Button: {
      props: { label: { type: 'string' } },
      root: { id: 'root', type: 'box', children: [{ id: 'label', type: 'text', value: { prop: 'label' } }] }
    },
    PermissionRow: {
      props: { title: { type: 'string' }, action: { type: 'string' } },
      root: {
        id: 'row',
        type: 'box',
        children: [
          { id: 'title', type: 'text', value: { prop: 'title' } },
          { id: 'grant', use: 'Button', props: { label: { prop: 'action' } } }
        ]
      }
    },
    Card: {
      props: { body: { type: 'slot' } },
      root: { id: 'card', type: 'box', children: [{ slot: 'body' }] }
    }
  },
  artboards: []
}

const screen = {
  schema: FORMAT_VERSION,
  name: 'Permissions',
  artboards: [
    {
      id: 'ready',
      name: 'Permissions — ready',
      size: { width: 640, height: 480 },
      root: {
        id: 'root',
        type: 'box',
        children: [
          { id: 'heading', type: 'text', value: 'Permissions' },
          { id: 'mic', use: 'PermissionRow', props: { title: 'Microphone', action: 'Grant access' } },
          { id: 'wrap', use: 'Card', slots: { body: [{ id: 'note', type: 'text', value: 'Asked once.' }] } }
        ]
      }
    }
  ]
}

function artboard(): ResolvedArtboard {
  const sys = assemble(entry, [
    file('tokens.json', 'tokens', tokensOf()),
    file('components/parts.nyui.json', 'component', components),
    file('screens/permissions.nyui.json', 'screen', screen)
  ])
  const out = compileText(JSON.stringify(screen), compileContextFor(sys, 'screens/permissions.nyui.json'))
  if (!out.ok) throw new Error(out.message)
  return out.doc.artboards[0]
}

/** The resolved id of the node authored as `scope#id`. */
function idOf(a: ResolvedArtboard, scope: string, id: string): string {
  const walk = (n: ResolvedArtboard['root']): string | null => {
    if (n.origin.scope === scope && n.origin.id === id) return n.id
    if (n.type !== 'box') return null
    for (const c of n.children) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  const found = walk(a.root)
  if (!found) throw new Error(`no ${scope}#${id}`)
  return found
}

describe('what a right-click landed on', () => {
  it('names a label inside a button inside a row, and where each was placed', () => {
    const a = artboard()
    const t = describeTarget(a, idOf(a, 'Button', 'label'))
    expect(t.label).toBe('Grant access')
    expect(t.type).toBe('text')
    expect(t.text).toBe('Grant access')
    expect(t.origin).toEqual({ scope: 'Button', id: 'label', file: 'components/parts.nyui.json' })
    expect(t.inside.map((s) => `${s.component} ${s.id}`)).toEqual(['PermissionRow mic', 'Button grant'])
    expect(t.inside[1].site).toEqual({ scope: 'PermissionRow', id: 'grant', file: 'components/parts.nyui.json' })
    expect(targetTag(t)).toBe('Button · grant')
  })

  it('a container is named by its first words', () => {
    const a = artboard()
    const row = findNode(a.root, idOf(a, 'ready', 'mic'))!.at(-1)!
    expect(describeTarget(a, row.id).label).toBe('Microphone')
  })

  it('slotted content is authored where the caller is, not inside the Card it fills', () => {
    const a = artboard()
    const t = describeTarget(a, idOf(a, 'ready', 'note'))
    expect(t.origin).toEqual({ scope: 'ready', id: 'note', file: 'screens/permissions.nyui.json' })
    expect(t.inside).toEqual([])
  })

  it('nothing under the cursor is the artboard itself', () => {
    const a = artboard()
    expect(describeTarget(a, null)).toEqual({ label: 'Permissions — ready', type: null, origin: null, inside: [] })
  })
})

describe('a pin finds its element again', () => {
  const anchorFor = (a: ResolvedArtboard, resolvedId: string): CommentAnchor => ({
    resolvedId,
    ...describeTarget(a, resolvedId),
    offset: { x: 0.5, y: 0.5 },
    point: { x: 10, y: 20 },
    bounds: null
  })

  it('by its resolved id, then by an authored address that names one node', () => {
    const a = artboard()
    const heading = idOf(a, 'ready', 'heading')
    expect(relocate(a, anchorFor(a, heading))).toBe(heading)
    expect(relocate(a, { ...anchorFor(a, heading), resolvedId: 'ready#gone/heading' })).toBe(heading)
  })

  it('never guesses between several instances of the same node', () => {
    const a = artboard()
    const label = anchorFor(a, idOf(a, 'Button', 'label'))
    // Every child twice: Button#label now names two nodes, so a stale id
    // must not be pinned to either.
    if (a.root.type !== 'box') throw new Error('root is a box')
    const twice = { ...a, root: { ...a.root, children: [...a.root.children, ...a.root.children] } }
    expect(relocate(twice, { ...label, resolvedId: 'ready#moved/label' })).toBeNull()
  })
})

describe('what Claude receives', () => {
  it('spells out the element, where to edit it, and how to close it', () => {
    const a = artboard()
    const id = idOf(a, 'Button', 'label')
    const body = commentBody({
      id: 'c_4',
      n: 4,
      text: 'Say Allow, not Grant access.',
      file: '/repo/design/screens/permissions.nyui.json',
      rel: 'screens/permissions.nyui.json',
      artboardId: 'ready',
      artboardName: 'Permissions — ready',
      anchor: {
        resolvedId: id,
        ...describeTarget(a, id),
        offset: { x: 0.62, y: 0.4 },
        point: { x: 320, y: 168 },
        bounds: { x: 308, y: 157, width: 96, height: 28 }
      }
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('<design_comment id="c_4" pin="4">')
    expect(body).toContain('file:     screens/permissions.nyui.json · artboard "ready" (Permissions — ready)')
    expect(body).toContain(`node:     ${id} — a text inside PermissionRow "mic" › Button "grant"`)
    expect(body).toContain('edit at:  components/parts.nyui.json · PermissionRow#grant')
    expect(body).toContain('defined:  components/parts.nyui.json · Button#label')
    expect(body).toContain('text:     "Grant access"')
    expect(body).toContain('where:    96×28 at 308,157 · pinned at 62% × 40%')
    expect(body).toContain('comment:  Say Allow, not Grant access.')
    expect(body).toContain('action:"resolve", id:"c_4"')
  })

  it('a reply carries every round so far, newest last', () => {
    const body = commentBody({
      id: 'c_2',
      n: 2,
      text: 'Too much air',
      file: '/d.nyui.json',
      artboardId: 'a',
      artboardName: 'A',
      anchor: { resolvedId: null, origin: null, inside: [], offset: { x: 0.5, y: 0.5 }, point: { x: 1, y: 2 }, bounds: null, label: 'A', type: null },
      replies: [
        { id: 'r_1', by: 'claude', text: 'Halved the padding', at: '' },
        { id: 'r_2', by: 'you', text: 'Now it is cramped', at: '' }
      ]
    })
    expect(body).toContain('comment:  Too much air\nthread:   claude: Halved the padding\n          user: Now it is cramped')
  })

  it('a note from before threads is the first reply', () => {
    expect(threadOf({ resolution: { by: 'claude', at: 't', note: 'Changed it' } })).toEqual([
      { id: 'r_note', by: 'claude', text: 'Changed it', at: 't' }
    ])
    expect(threadOf({ resolution: { by: 'claude', at: 't' }, replies: [] })).toEqual([])
  })

  it('a point with no element says so', () => {
    const body = commentBody({
      id: 'c_1',
      n: 1,
      text: 'Too much air',
      file: '/d.nyui.json',
      artboardId: 'a',
      artboardName: 'A',
      anchor: { resolvedId: null, origin: null, inside: [], offset: { x: 0.5, y: 0.5 }, point: { x: 1, y: 2 }, bounds: null, label: 'A', type: null }
    })
    expect(body).toContain('node:     none — a point on the artboard')
    expect(body).not.toContain('edit at')
  })
})

describe('since', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  it('reads like a person would say it', () => {
    expect(since('2026-10-03T11:59:40Z', now)).toBe('just now')
    expect(since('2026-10-03T11:57:00Z', now)).toBe('3 min ago')
    expect(since('2026-10-03T10:00:00Z', now)).toBe('2 h ago')
    expect(since('nonsense', now)).toBe('')
  })
})
