import { afterEach, describe, expect, it } from 'vitest'
import {
  isKnownCommand,
  noteSlashCommands,
  resetSlashCommands,
  slashCommands
} from '../../renderer/src/lib/slashCommands'
import { BUILT_IN_COMMANDS } from '../../renderer/src/data/commands'

afterEach(() => resetSlashCommands())

describe('slashCommands', () => {
  it('falls back to the curated list before any session has started', () => {
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
})
