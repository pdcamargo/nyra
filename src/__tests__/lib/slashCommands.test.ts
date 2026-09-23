import { afterEach, describe, expect, it } from 'vitest'
import {
  isKnownCommand,
  noteCustomCommands,
  notePluginCommands,
  noteSkills,
  noteSlashCommands,
  resetSlashCommands,
  slashCommands
} from '../../renderer/src/lib/slashCommands'
import { BUILT_IN_COMMANDS } from '../../renderer/src/data/commands'

afterEach(() => resetSlashCommands())

describe('slashCommands', () => {
  it('falls back to the curated list before any session has started', () => {
    // Resource views are curated alongside the other app commands.
    expect(slashCommands()).toHaveLength(BUILT_IN_COMMANDS.length)
  })

  it('appends commands the CLI reports that we do not curate', () => {
    noteSlashCommands(['compact', 'agents', 'output-style'])
    const names = slashCommands().map((c) => c.name)
    expect(names).toContain('/agents')
    expect(names).toContain('/output-style')
    // Curated order survives: appended, not merged alphabetically.
    expect(names.indexOf('/compact')).toBeLessThan(names.indexOf('/agents'))
  })

  it('does not duplicate a command that is in both lists', () => {
    noteSlashCommands(['compact'])
    expect(slashCommands().filter((c) => c.name === '/compact')).toHaveLength(1)
  })

  it('keeps Nyra commands the CLI has never heard of', () => {
    noteSlashCommands(['compact'])
    expect(slashCommands().map((c) => c.name)).toContain('/release-notes')
  })

  it('gives a reported command its curated description when there is one', () => {
    resetSlashCommands()
    noteSlashCommands(['goal'])
    const goal = slashCommands().find((c) => c.name === '/goal')
    expect(goal?.description).toContain('objective')
  })

  it('ignores junk in the reported list', () => {
    noteSlashCommands(['', 'real'] as string[])
    expect(slashCommands().map((c) => c.name)).not.toContain('/')
  })

  // The four the sidebar's resource views are opened by. `/status` was already
  // curated; the other three are Nyra's, and the CLI has never heard of them.
  it('offers the resource views', () => {
    const names = slashCommands().map((c) => c.name)
    for (const name of ['/mcp', '/plugin', '/marketplace', '/status']) {
      expect(names).toContain(name)
    }
  })
})

describe('skills and custom commands', () => {
  it('offers a skill on disk, tagged as one', () => {
    noteSkills([{ name: 'claude-api', description: 'Audit a Claude API prompt' }])
    const skill = slashCommands().find((c) => c.name === '/claude-api')
    expect(skill?.kind).toBe('skill')
    expect(skill?.description).toBe('Audit a Claude API prompt')
  })

  it('offers a custom command, namespaced the way the CLI reads it', () => {
    noteCustomCommands([{ name: 'git:sync', description: 'Sync the branch' }])
    const command = slashCommands().find((c) => c.name === '/git:sync')
    expect(command?.kind).toBe('command')
  })

  it('puts your own material above the built-ins', () => {
    noteSkills([{ name: 'claude-api', description: '' }])
    const names = slashCommands().map((c) => c.name)
    expect(names.indexOf('/claude-api')).toBeLessThan(names.indexOf('/help'))
  })

  it('does not list a skill twice when it is also reported', () => {
    noteSkills([{ name: 'claude-api', description: 'mine' }])
    noteSlashCommands(['claude-api', 'compact'])
    const matches = slashCommands().filter((c) => c.name === '/claude-api')
    expect(matches).toHaveLength(1)
    expect(matches[0].description).toBe('mine')
  })

  it('forgets both when a test resets it', () => {
    noteSkills([{ name: 'claude-api', description: '' }])
    noteCustomCommands([{ name: 'git:sync', description: '' }])
    resetSlashCommands()
    expect(slashCommands().map((c) => c.name)).not.toContain('/claude-api')
    expect(slashCommands().map((c) => c.name)).not.toContain('/git:sync')
  })
})

describe('plugin contributions', () => {
  it('namespaces a contributed command the way the CLI does', () => {
    notePluginCommands('claude-api', [{ name: 'review', description: 'Review a prompt' }])
    const command = slashCommands().find((c) => c.name === '/claude-api:review')
    expect(command?.description).toBe('Review a prompt')
  })

  it('leaves a name that already carries its namespace alone', () => {
    notePluginCommands('claude-api', [{ name: 'other:thing', description: '' }])
    expect(slashCommands().map((c) => c.name)).toContain('/other:thing')
  })

  it('replaces that plugin’s list without touching another plugin’s', () => {
    notePluginCommands('claude-api', [{ name: 'review', description: '' }])
    notePluginCommands('sentry', [{ name: 'issues', description: '' }])
    notePluginCommands('claude-api', [{ name: 'audit', description: '' }])
    const names = slashCommands().map((c) => c.name)
    expect(names).toContain('/claude-api:audit')
    expect(names).not.toContain('/claude-api:review')
    expect(names).toContain('/sentry:issues')
  })

  it('drops a plugin’s commands when it contributes none', () => {
    notePluginCommands('claude-api', [{ name: 'review', description: '' }])
    notePluginCommands('claude-api', [])
    expect(slashCommands().map((c) => c.name)).not.toContain('/claude-api:review')
  })
})

describe('isKnownCommand', () => {
  it('knows the four that had drifted out of the hand-kept list', () => {
    for (const name of ['goal', 'recap', 'usage', 'insights']) {
      expect(isKnownCommand(name)).toBe(true)
    }
  })

  it('accepts anything the running CLI reports', () => {
    expect(isKnownCommand('output-style')).toBe(false)
    noteSlashCommands(['output-style'])
    expect(isKnownCommand('output-style')).toBe(true)
  })

  it('still rejects a path', () => {
    expect(isKnownCommand('usr')).toBe(false)
  })

  it('knows a skill on disk, which is what styles /claude-api', () => {
    expect(isKnownCommand('claude-api')).toBe(false)
    noteSkills([{ name: 'claude-api', description: '' }])
    expect(isKnownCommand('claude-api')).toBe(true)
  })

  it('knows a namespaced custom command', () => {
    noteCustomCommands([{ name: 'git:sync', description: '' }])
    expect(isKnownCommand('git:sync')).toBe(true)
  })

  it('knows the resource views', () => {
    for (const name of ['mcp', 'plugin', 'marketplace', 'status']) {
      expect(isKnownCommand(name)).toBe(true)
    }
  })

  it('knows a plugin’s namespaced command', () => {
    notePluginCommands('claude-api', [{ name: 'review', description: '' }])
    expect(isKnownCommand('claude-api:review')).toBe(true)
  })
})
