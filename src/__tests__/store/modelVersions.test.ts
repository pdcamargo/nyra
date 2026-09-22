import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteModelId,
  noteModelVersion,
  useModelVersionsStore
} from '../../renderer/src/store/modelVersions'

const resolved = (): Record<string, string> => useModelVersionsStore.getState().resolved

describe('modelVersions', () => {
  const families = (): Record<string, string> => useModelVersionsStore.getState().families

  beforeEach(() => useModelVersionsStore.setState({ resolved: {}, families: {} }))

  it('records what an alias resolved to', () => {
    noteModelVersion('opus', 'claude-opus-5-5')
    expect(resolved().opus).toBe('claude-opus-5-5')
  })

  it('files the CLI default under its own key', () => {
    // Both are Opus and they are not the same model. Filing by family would
    // let a default-spawned session relabel the alias to the older one.
    noteModelVersion('', 'claude-opus-5')
    noteModelVersion('opus', 'claude-opus-5-5')
    expect(resolved()).toEqual({ '': 'claude-opus-5', opus: 'claude-opus-5-5' })
  })

  it('does not keep a key for every pinned id anyone types', () => {
    // A full name is already its own answer; remembering them would grow a
    // persisted map without bound.
    noteModelVersion('claude-opus-5-5[1m]', 'claude-opus-5-5')
    expect(resolved()).toEqual({})
  })

  it('ignores an init event that carried no model', () => {
    noteModelVersion('opus', undefined)
    noteModelVersion('opus', '')
    expect(resolved()).toEqual({})
  })

  it('files every resolution against its family as well', () => {
    // What numbers a row nobody has ever selected: a chat left on Default
    // reporting claude-opus-5-5 is the CLI saying what Opus is today.
    noteModelVersion('', 'claude-opus-5-5[1m]')
    expect(families()).toEqual({ opus: 'claude-opus-5-5[1m]' })
  })

  it("takes a subagent's model as evidence without calling it a request", () => {
    noteModelId('claude-haiku-4-5-20251001')
    expect(families()).toEqual({ haiku: 'claude-haiku-4-5-20251001' })
    expect(resolved()).toEqual({})
  })

  it('ignores an id it cannot place in a family', () => {
    noteModelId('some-internal-build')
    expect(families()).toEqual({})
  })
})
