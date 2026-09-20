import { describe, it, expect } from 'vitest'
import { KNOWN_MODELS, MODEL_BLURB, modelOptions, shortModelLabel } from '../../renderer/src/lib/models'

describe('models', () => {
  it('offers Fable alongside the others', () => {
    expect(KNOWN_MODELS).toContain('fable')
    expect(modelOptions('').map((o) => o.value)).toContain('fable')
  })

  it('keeps a pinned full name visible instead of falling back to Default', () => {
    // The composer takes any string the CLI accepts. Without this the settings
    // row would read "Default" while the session ran on something else.
    const opts = modelOptions('claude-fable-5-1')
    expect(opts.find((o) => o.value === 'claude-fable-5-1')?.label).toBe('claude-fable-5-1')
  })

  it('does not list a known alias twice', () => {
    expect(modelOptions('haiku').filter((o) => o.value === 'haiku')).toHaveLength(1)
  })

  it('is Default plus the known aliases when nothing is stored', () => {
    expect(modelOptions('')).toHaveLength(KNOWN_MODELS.length + 1)
  })

  it('labels carry no version number, because an alias means the latest', () => {
    for (const { label } of modelOptions('')) expect(label).not.toMatch(/\d/)
  })

  it('has a blurb for every alias it offers', () => {
    for (const m of KNOWN_MODELS) expect(MODEL_BLURB[m]).toBeTruthy()
  })
})

describe('shortModelLabel', () => {
  it('names what a subagent actually ran on', () => {
    // The id seen on a real subagent transcript's `message.model`.
    expect(shortModelLabel('claude-opus-5')).toBe('Opus 5')
    expect(shortModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(shortModelLabel('claude-fable-5-1')).toBe('Fable 5.1')
  })

  it('reads a dotted version out of a dashed one', () => {
    expect(shortModelLabel('claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(shortModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('copes with the suffixes and prefixes the platforms add', () => {
    expect(shortModelLabel('claude-opus-5[1m]')).toBe('Opus 5')
    expect(shortModelLabel('us.anthropic.claude-sonnet-5')).toBe('Sonnet 5')
  })

  it('says nothing rather than guessing at an unfamiliar id', () => {
    // A badge reading `custom-thing-v2` tells you less than no badge at all.
    expect(shortModelLabel('custom-thing-v2')).toBeNull()
    expect(shortModelLabel('')).toBeNull()
    expect(shortModelLabel(undefined)).toBeNull()
    expect(shortModelLabel(null)).toBeNull()
  })

  it('handles an alias with no version on it', () => {
    expect(shortModelLabel('opus')).toBe('Opus')
  })
})
