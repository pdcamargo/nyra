/**
 * Claude Code's plugin catalog, as the backend reports it.
 *
 * Types and the pure parts of the Plugins page: what "recommended" means, what
 * a category filter does to a list, how a component inventory reads in one
 * line. Kept out of the view because the view is layout, and these are the
 * parts worth testing without a DOM.
 *
 * The wire types live in `lib/api-types` next to the bridge that returns them,
 * so a change there cannot drift from what the view reads. Re-exported here
 * because this is where the page looks for them. Everything a row shows is
 * already resolved by Claude Code's own catalog — nothing is guessed from a
 * plugin's name.
 */
import type { AvailablePlugin, InstalledPlugin, PluginComponents } from './api-types'

export type {
  AvailablePlugin,
  InstalledPlugin,
  PluginActionRequest,
  PluginActionResult,
  PluginCatalog,
  PluginComponents
} from './api-types'

export type PluginKind = 'integration' | 'plugin'

/** Where a plugin is installed to. Claude Code's own default is the user. */
export type PluginScope = 'user' | 'project' | 'local'

export const PLUGIN_SCOPES: { value: PluginScope; label: string }[] = [
  { value: 'user', label: 'User' },
  { value: 'project', label: 'Project' },
  { value: 'local', label: 'Local' }
]

export type PluginTokenCost = {
  model: string
  alwaysOn?: number | null
  onInvoke?: number | null
}

/** The inventory with names, which only the detail answer carries. */
export type PluginComponentNames = {
  skills: string[]
  commands: string[]
  agents: string[]
  hooks: string[]
  mcpServers: string[]
  lspServers: string[]
}

const COMPONENT_KEYS = [
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers'
] as const

/**
 * The detail answer's component block arrives as `unknown`, because the same
 * bridge method answers either a CLI result or a resolved inventory. This is
 * the check that makes it a name list — a blind cast would put a shape the
 * backend never promised in front of a user the first time it changed.
 */
export function asComponentNames(value: unknown): PluginComponentNames | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const out = {} as PluginComponentNames
  for (const key of COMPONENT_KEYS) {
    const list = source[key]
    if (!Array.isArray(list)) return null
    out[key] = list.filter((entry): entry is string => typeof entry === 'string')
  }
  return out
}

export type PluginSort = 'recommended' | 'name' | 'official'

export const PLUGIN_SORTS: { value: PluginSort; label: string }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'name', label: 'Name' },
  { value: 'official', label: 'Official first' }
]

const EMPTY_COMPONENTS: PluginComponents = {
  skills: 0,
  commands: 0,
  agents: 0,
  hooks: 0,
  mcpServers: 0,
  lspServers: 0
}

/** The name worth showing: the catalog's display name when it has one. */
export function pluginName(plugin: AvailablePlugin | InstalledPlugin): string {
  const display = (plugin as AvailablePlugin).displayName
  return display && display.trim() ? display : plugin.name
}

function installs(plugin: AvailablePlugin): number {
  return plugin.installCount ?? 0
}

/**
 * Sort a catalog list.
 *
 * "Recommended" is install count, because that is the only signal the catalog
 * ships — inventing a score would be dressing up a number nobody computed.
 * "Official first" is the honest version of a trust sort: the published catalog
 * ahead of everything you added yourself.
 */
export function sortPlugins(list: AvailablePlugin[], sort: PluginSort): AvailablePlugin[] {
  const byName = (a: AvailablePlugin, b: AvailablePlugin): number =>
    pluginName(a).localeCompare(pluginName(b), undefined, { sensitivity: 'base' })

  return [...list].sort((a, b) => {
    if (sort === 'name') return byName(a, b)
    if (sort === 'official') {
      const trust = Number(b.verified ?? false) - Number(a.verified ?? false)
      if (trust !== 0) return trust
    }
    return installs(b) - installs(a) || byName(a, b)
  })
}

/** Search over the strings a card actually shows. */
export function filterPlugins(
  list: AvailablePlugin[],
  query: string,
  categories: string[] = []
): AvailablePlugin[] {
  const needle = query.trim().toLowerCase()
  return list.filter((plugin) => {
    if (categories.length > 0 && !categories.includes(plugin.category ?? '')) return false
    if (!needle) return true
    return (
      plugin.name.toLowerCase().includes(needle) ||
      pluginName(plugin).toLowerCase().includes(needle) ||
      (plugin.author ?? '').toLowerCase().includes(needle) ||
      (plugin.description ?? '').toLowerCase().includes(needle)
    )
  })
}

/** The integrations row, the plugins row, or both — already ordered. */
export function topOf(
  list: AvailablePlugin[],
  kind: PluginKind | 'any',
  sort: PluginSort
): AvailablePlugin[] {
  const matching = kind === 'any' ? list : list.filter((plugin) => plugin.kind === kind)
  return sortPlugins(matching, sort)
}

export function countOfKind(list: AvailablePlugin[], kind: PluginKind): number {
  return list.filter((plugin) => plugin.kind === kind).length
}

/** Short enough for one line under a plugin name. */
export function componentSummary(components?: PluginComponents | null): string {
  const counts = components ?? EMPTY_COMPONENTS
  const parts: [number, string][] = [
    [counts.skills, 'skill'],
    [counts.commands, 'command'],
    [counts.agents, 'agent'],
    [counts.hooks, 'hook'],
    [counts.mcpServers, 'MCP server'],
    [counts.lspServers, 'LSP server']
  ]
  const said = parts
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`)
  return said.length > 0 ? said.join(' · ') : 'No components'
}

/** 69928 → "69,928" — an install count is a number somebody reads. */
export function formatInstalls(count?: number | null): string | null {
  if (!count || count <= 0) return null
  return count.toLocaleString('en-US')
}

/**
 * The cost line for a plugin, from whichever model the catalog priced it
 * against. Always-on is the part that lands in every session, so it is the part
 * worth putting on a card.
 */
export function alwaysOnTokens(tokens?: PluginTokenCost[]): number | null {
  const priced = (tokens ?? []).find((token) => (token.alwaysOn ?? 0) > 0)
  return priced?.alwaysOn ?? null
}
