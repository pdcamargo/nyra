import { describe, expect, it } from 'vitest'
import type { AvailablePlugin } from '../../renderer/src/lib/api-types'
import {
  alwaysOnTokens,
  asComponentNames,
  componentSummary,
  countOfKind,
  filterPlugins,
  formatInstalls,
  pluginName,
  sortPlugins,
  topOf
} from '../../renderer/src/lib/plugins'

function plugin(overrides: Partial<AvailablePlugin> & { id: string }): AvailablePlugin {
  return {
    name: overrides.id.split('@')[0],
    displayName: null,
    description: null,
    marketplace: 'claude-plugins-official',
    category: null,
    author: null,
    homepage: null,
    keywords: [],
    tags: [],
    installCount: null,
    version: null,
    kind: 'plugin',
    verified: false,
    source: './plugins/x',
    components: null,
    tokens: [],
    installed: false,
    enabled: false,
    installedVersion: null,
    installedScope: null,
    ...overrides
  }
}

describe('the plugin catalog, as the page reads it', () => {
  it('shows the catalog display name when there is one', () => {
    expect(pluginName(plugin({ id: 'vercel@m' }))).toBe('vercel')
    expect(pluginName(plugin({ id: 'vercel@m', displayName: 'Vercel' }))).toBe('Vercel')
    // An empty display name is not a name.
    expect(pluginName(plugin({ id: 'vercel@m', displayName: '  ' }))).toBe('vercel')
  })

  it('recommends by install count, because that is the only signal there is', () => {
    const list = [
      plugin({ id: 'a@m', installCount: 2 }),
      plugin({ id: 'b@m', installCount: 90 }),
      plugin({ id: 'c@m', installCount: null })
    ]
    expect(sortPlugins(list, 'recommended').map((entry) => entry.name)).toEqual(['b', 'a', 'c'])
  })

  it('puts the published catalog first when asked for official first', () => {
    const list = [
      plugin({ id: 'home@local', verified: false, installCount: 5000 }),
      plugin({ id: 'official@claude-plugins-official', verified: true, installCount: 3 })
    ]
    expect(sortPlugins(list, 'official').map((entry) => entry.name)).toEqual([
      'official',
      'home'
    ])
    // …and install count still orders within a tier.
    const two = [
      plugin({ id: 'x@claude-plugins-official', verified: true, installCount: 3 }),
      plugin({ id: 'y@claude-plugins-official', verified: true, installCount: 9 })
    ]
    expect(sortPlugins(two, 'official').map((entry) => entry.name)).toEqual(['y', 'x'])
  })

  it('sorts by name without pretending case matters', () => {
    const list = [
      plugin({ id: 'zebra@m' }),
      plugin({ id: 'Apple@m' }),
      plugin({ id: 'mango@m' })
    ]
    expect(sortPlugins(list, 'name').map((entry) => entry.name)).toEqual([
      'Apple',
      'mango',
      'zebra'
    ])
  })

  it('does not reorder the caller’s array', () => {
    const list = [plugin({ id: 'b@m' }), plugin({ id: 'a@m' })]
    sortPlugins(list, 'name')
    expect(list.map((entry) => entry.name)).toEqual(['b', 'a'])
  })

  it('searches name, display name, author and description', () => {
    const list = [
      plugin({ id: 'vercel@m', author: 'Vercel' }),
      plugin({ id: 'atlassian@m', description: 'Jira and Confluence' }),
      plugin({ id: 'plain@m' })
    ]
    expect(filterPlugins(list, 'verc').map((entry) => entry.name)).toEqual(['vercel'])
    expect(filterPlugins(list, 'jira').map((entry) => entry.name)).toEqual(['atlassian'])
    expect(filterPlugins(list, '   ')).toHaveLength(3)
  })

  it('treats several chosen categories as one union', () => {
    const list = [
      plugin({ id: 'a@m', category: 'development' }),
      plugin({ id: 'b@m', category: 'design' }),
      plugin({ id: 'c@m', category: 'security' })
    ]
    expect(filterPlugins(list, '', ['development', 'design']).map((entry) => entry.name)).toEqual([
      'a',
      'b'
    ])
    // A plugin with no category is not in any category.
    expect(filterPlugins([plugin({ id: 'none@m', category: null })], '', ['development'])).toEqual(
      []
    )
  })

  it('splits integrations from plugins, since that is the two-row layout', () => {
    const list = [
      plugin({ id: 'asana@m', kind: 'integration' }),
      plugin({ id: 'review@m', kind: 'plugin' }),
      plugin({ id: 'linear@m', kind: 'integration' })
    ]
    expect(countOfKind(list, 'integration')).toBe(2)
    expect(topOf(list, 'integration', 'name').map((entry) => entry.name)).toEqual([
      'asana',
      'linear'
    ])
    expect(topOf(list, 'plugin', 'name').map((entry) => entry.name)).toEqual(['review'])
    expect(topOf(list, 'any', 'name')).toHaveLength(3)
  })

  it('counts a component inventory in words, singular and plural', () => {
    expect(
      componentSummary({
        skills: 37,
        commands: 0,
        agents: 0,
        hooks: 3,
        mcpServers: 1,
        lspServers: 0
      })
    ).toBe('37 skills · 3 hooks · 1 MCP server')
    expect(componentSummary(null)).toBe('No components')
    expect(
      componentSummary({
        skills: 1,
        commands: 1,
        agents: 1,
        hooks: 1,
        mcpServers: 1,
        lspServers: 1
      })
    ).toBe('1 skill · 1 command · 1 agent · 1 hook · 1 MCP server · 1 LSP server')
  })

  it('reads an install count as a number, and says nothing for zero', () => {
    expect(formatInstalls(69928)).toBe('69,928')
    expect(formatInstalls(0)).toBeNull()
    expect(formatInstalls(null)).toBeNull()
    expect(formatInstalls(undefined)).toBeNull()
  })

  it('picks the always-on price rather than an unpriced model', () => {
    expect(
      alwaysOnTokens([
        { model: 'a', alwaysOn: 0, onInvoke: 900 },
        { model: 'b', alwaysOn: 2904, onInvoke: 500 }
      ])
    ).toBe(2904)
    expect(alwaysOnTokens([])).toBeNull()
    expect(alwaysOnTokens(undefined)).toBeNull()
  })

  it('accepts a component inventory only when every list is really a list', () => {
    const good = {
      skills: ['a'],
      commands: [],
      agents: [],
      hooks: ['SessionStart'],
      mcpServers: ['vercel'],
      lspServers: []
    }
    expect(asComponentNames(good)).toEqual(good)
    // Missing a key is not "no skills", it is a shape we do not understand —
    // and rendering it as empty would quietly claim the plugin adds nothing.
    expect(asComponentNames({ skills: [] })).toBeNull()
    expect(asComponentNames(null)).toBeNull()
    expect(asComponentNames('skills')).toBeNull()
  })
})
