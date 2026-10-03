import { describe, expect, it } from 'vitest'
import { FORMAT_VERSION, defaultTokens as tokensOf } from '@nyra/design'
import {
  assemble,
  compileContextFor,
  contrastRatio,
  semanticContrast,
  systemDigest,
  projectSkill,
  textContrastProblems,
  usedIn,
  type Cached
} from '../../renderer/src/lib/designSystem'
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

const file = (rel: string, kind: SystemFileKind, json: unknown, text?: string): Cached => ({
  info: { path: `/repo/design/${rel}`, rel, kind, size: 10, mtimeMs: 1 },
  text: text ?? JSON.stringify(json),
  json
})

const button = {
  schema: FORMAT_VERSION,
  name: 'Button',
  meta: { group: 'Inputs', status: 'ready', usage: { do: ['One primary per surface.'], dont: ['Two primaries.'] } },
  components: {
    Button: {
      description: 'The one clickable action.',
      props: {
        label: { type: 'string' },
        variant: { type: 'enum', of: ['primary', 'ghost'], default: 'primary' }
      },
      root: { id: 'b', type: 'text', value: { prop: 'label' } }
    }
  },
  artboards: [
    { id: 'button-specimens', name: 'Specimens', size: { width: 400, height: 'auto' }, root: { id: 's', use: 'Button', props: { label: 'Go' } } }
  ]
}
const settings = {
  schema: FORMAT_VERSION,
  name: 'Settings',
  artboards: [
    { id: 'settings', name: 'Settings', size: { width: 640, height: 480 }, root: { id: 'save', use: 'Button', props: { label: 'Save' } } }
  ]
}
const old = { ...settings, name: 'Old', schema: 1 }

const system = () =>
  assemble(entry, [
    file('nyra.design.json', 'manifest', { schema: FORMAT_VERSION, id: 's_1', name: 'Closeup', description: 'A video editor.' }),
    file('tokens.json', 'tokens', tokensOf()),
    file('components/button.nyui.json', 'component', button),
    file('screens/settings.nyui.json', 'screen', settings),
    file('screens/old.nyui.json', 'screen', old),
    file('screens/broken.nyui.json', 'screen', null),
    { ...file('guidelines/brief.md', 'guideline', null, '# Brief\n\nCalm chrome; the footage is the colour.'), json: null }
  ])

describe('a design system, read', () => {
  it('outlines each file without compiling it', () => {
    const sys = system()
    expect(sys.manifest).toEqual({ name: 'Closeup', description: 'A video editor.' })
    expect(sys.tokens.modes).toEqual(['light'])
    const btn = sys.files.find((f) => f.rel === 'components/button.nyui.json')!
    expect(btn.kind).toBe('component')
    expect(btn.meta?.group).toBe('Inputs')
    expect(btn.components[0]).toMatchObject({ name: 'Button', description: 'The one clickable action.' })
    expect(btn.components[0].props.map((p) => p.name)).toEqual(['label', 'variant'])
    expect(btn.artboards[0]).toMatchObject({ id: 'button-specimens', width: 400, height: 'auto' })
    expect(sys.files.find((f) => f.rel === 'screens/old.nyui.json')?.olderFormat).toBe(1)
    expect(sys.files.find((f) => f.rel === 'screens/broken.nyui.json')?.error).toBeTruthy()
    // Components first, then patterns, then screens.
    expect(sys.files.map((f) => f.kind)).toEqual(['component', 'screen', 'screen', 'screen'])
    expect(sys.guidelines[0].title).toBe('Brief')
  })

  it('compiles a screen with a component from another file, in the system theme', () => {
    const sys = system()
    const out = compileText(JSON.stringify(settings), compileContextFor(sys, 'screens/settings.nyui.json'))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.doc.artboards[0].root.origin).toEqual({ scope: 'settings', id: 'save', file: 'screens/settings.nyui.json' })
    expect(out.theme.name).toBe('Closeup')
  })

  it('a screen alone, without the system, cannot find Button', () => {
    expect(compileText(JSON.stringify(settings)).ok).toBe(false)
  })
})

describe('what a component page reads', () => {
  // Button takes its icon as a prop; Toolbar hands its own `lead` prop down to
  // Button's; the editor screen draws Buttons, Toolbars and icons of its own.
  const btn = {
    schema: FORMAT_VERSION,
    name: 'Button',
    components: {
      Button: {
        props: {
          label: { type: 'string', description: 'The words on it. Start with a verb.' },
          icon: { type: 'string', default: 'plus' },
          tone: { type: 'enum', of: ['quiet', 'loud'], default: 'quiet' }
        },
        root: {
          id: 'b',
          type: 'box',
          children: [
            { id: 'i', type: 'icon', name: { prop: 'icon' } },
            { id: 't', type: 'text', value: { prop: 'label' } }
          ]
        }
      }
    },
    artboards: [
      { id: 'specimens', name: 'Specimens', size: { width: 400, height: 'auto' }, root: { id: 's', use: 'Button', props: { label: 'Export', icon: 'download' } } }
    ]
  }
  const toolbar = {
    schema: FORMAT_VERSION,
    name: 'Toolbar',
    components: {
      Toolbar: {
        props: { lead: { type: 'string' } },
        root: {
          id: 'r',
          type: 'box',
          children: [
            { id: 'a', use: 'Button', props: { label: 'Cut', icon: { prop: 'lead' } } },
            { id: 'b', use: 'Button', props: { label: 'Undo', icon: 'undo-2' } }
          ]
        }
      }
    },
    artboards: [
      { id: 'tb', name: 'Toolbar', size: { width: 400, height: 'auto' }, root: { id: 't', use: 'Toolbar', props: { lead: 'scissors' } } }
    ]
  }
  const editor = {
    schema: FORMAT_VERSION,
    name: 'Editor',
    artboards: [
      {
        id: 'editor',
        name: 'Editor',
        size: { width: 960, height: 640 },
        root: {
          id: 'root',
          type: 'box',
          children: [
            { id: 't1', use: 'Toolbar', props: { lead: 'scissors' } },
            { id: 't2', use: 'Toolbar', props: { lead: 'crop' } },
            { id: 'b1', use: 'Button', props: { label: 'Save' } },
            { id: 'm', type: 'icon', name: 'monitor' },
            { id: 'v', type: 'icon', name: { match: { prop: 'open' }, cases: { true: 'chevron-down' }, default: 'chevron-right' } },
            // A value that is not an icon name is not counted as one.
            { id: 'x', type: 'icon', name: '$color.text' }
          ]
        }
      }
    ]
  }
  const sys = () =>
    assemble(entry, [
      file('components/button.nyui.json', 'component', btn),
      file('components/toolbar.nyui.json', 'component', toolbar),
      file('screens/editor.nyui.json', 'screen', editor)
    ])

  it('counts every instance that draws a component, directly or through another', () => {
    const users = usedIn(sys(), 'Button').map((u) => [u.file.rel, u.count])
    // Toolbar: two Buttons in its definition, one Toolbar on its specimen.
    // Editor: one Button, two Toolbars.
    expect(users).toEqual([
      ['components/toolbar.nyui.json', 3],
      ['screens/editor.nyui.json', 3]
    ])
    expect(usedIn(sys(), 'Toolbar').map((u) => [u.file.rel, u.count])).toEqual([['screens/editor.nyui.json', 2]])
  })

  it('reads a prop description, which the format accepts and ignores', () => {
    const label = sys().files.find((f) => f.name === 'Button')!.components[0].props.find((p) => p.name === 'label')
    expect(label?.description).toBe('The words on it. Start with a verb.')
    expect(compileText(JSON.stringify(btn)).ok).toBe(true)
  })

  it('lists every icon drawn, following icon props through the components that pass them', () => {
    const icons = sys().icons
    expect(icons.map((i) => i.name)).toEqual([
      'chevron-down',
      'chevron-right',
      'crop',
      'download',
      'monitor',
      'plus',
      'scissors',
      'undo-2'
    ])
    expect(icons.find((i) => i.name === 'scissors')?.files).toEqual(['components/toolbar.nyui.json', 'screens/editor.nyui.json'])
    // `tone` is an enum, but it never reaches an icon: its options are not icons.
    expect(icons.some((i) => i.name === 'quiet')).toBe(false)
  })
})

describe('the digest Claude reads', () => {
  it('names tokens, components with props, guidelines, and what needs fixing', () => {
    const text = systemDigest(system())
    expect(text).toContain('# Closeup design system')
    expect(text).toContain('`$color.accent`')
    expect(text).toContain('**Button** — `components/button.nyui.json` · Inputs · ready — The one clickable action.')
    expect(text).toContain('variant: primary | ghost = primary')
    expect(text).toContain('Do: One primary per surface.')
    expect(text).toContain('Calm chrome; the footage is the colour.')
    expect(text).toContain('`screens/old.nyui.json` is format v1')
    expect(text).toContain('**does not parse:**')
    // The two default status colours that fail AA as body text.
    expect(text).toMatch(/\$color\.success.*below AA/)
    expect(text).toMatch(/\$color\.warning.*below AA/)
  })

  it('becomes a project skill with frontmatter and a do-not-edit note', () => {
    const skill = projectSkill(system())
    expect(skill.startsWith('---\nname: closeup-design-system\n')).toBe(true)
    expect(skill).toContain('Generated by Nyra')
  })
})

describe('contrast', () => {
  it('measures the way WCAG does', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0)
    expect(contrastRatio('#6E56CF', '#FFFFFF')).toBeCloseTo(5.39, 1)
    expect(contrastRatio('rgb(0 0 0)', '#fff')).toBeNull()
  })

  it('grades every semantic colour and flags only text roles below AA', () => {
    const t = system().tokens.parsed!
    const rows = semanticContrast(t)
    expect(rows.find((r) => r.token === 'text')).toMatchObject({ ref: 'gray.900', grade: 'AAA' })
    expect(rows.find((r) => r.token === 'success')?.grade).toBe('large')
    const problems = textContrastProblems(t).map((r) => r.token).sort()
    expect(problems).toEqual(['success', 'warning'])
  })
})
