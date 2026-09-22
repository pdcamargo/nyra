import { describe, it, expect } from 'vitest'
import {
  KNOWN_MODELS,
  MODEL_BLURB,
  chatModelLabel,
  modelFamily,
  modelLabel,
  modelOptions,
  shortModelLabel
} from '../../renderer/src/lib/models'

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

  it('invents no version number of its own', () => {
    // The original rule, and still the important half of it: a number written
    // down in our source is wrong on release day. Nothing here has been told
    // what anything resolved to, so nothing may claim a version.
    for (const { label } of modelOptions('')) expect(label).not.toMatch(/\d/)
  })

  it('carries the version once the CLI has reported one', () => {
    const opts = modelOptions('', {
      resolved: { opus: 'claude-opus-5-5' },
      families: { haiku: 'claude-haiku-4-5-20251001' }
    })
    expect(opts.find((o) => o.value === 'opus')?.label).toBe('Opus 5.5')
    expect(opts.find((o) => o.value === 'haiku')?.label).toBe('Haiku 4.5')
    // Nothing has been said about this one, so it stays bare rather than guessed.
    expect(opts.find((o) => o.value === 'sonnet')?.label).toBe('Sonnet')
  })

  it('names the default without renaming it', () => {
    // The CLI's default is a real model and worth naming — it is also not a
    // fifth model, so the row stays marked as the default.
    const opts = modelOptions('', { resolved: { '': 'claude-opus-5-5[1m]' } })
    expect(opts.find((o) => o.value === '')?.label).toBe('Default (Opus 5.5)')
  })

  it('is just Default before anything has resolved', () => {
    expect(modelOptions('').find((o) => o.value === '')?.label).toBe('Default')
  })

  it('has a blurb for every alias it offers', () => {
    for (const m of KNOWN_MODELS) expect(MODEL_BLURB[m]).toBeTruthy()
  })
})

describe('modelFamily', () => {
  it('finds the family through whatever the platform wrapped it in', () => {
    expect(modelFamily('claude-opus-5-5-20260101[1m]')).toBe('opus')
    expect(modelFamily('us.anthropic.claude-sonnet-5')).toBe('sonnet')
  })

  it('says nothing for an id it cannot place', () => {
    expect(modelFamily('custom-thing-v2')).toBeNull()
    expect(modelFamily('')).toBeNull()
    expect(modelFamily(null)).toBeNull()
  })
})

describe('shortModelLabel', () => {
  it('names what a subagent actually ran on', () => {
    // The id seen on a real subagent transcript's `message.model`.
    expect(shortModelLabel('claude-opus-5')).toBe('Opus 5')
    expect(shortModelLabel('claude-opus-5-5')).toBe('Opus 5.5')
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

describe('modelLabel', () => {
  it('names an alias by whatever that request last resolved to', () => {
    expect(modelLabel('opus', { resolved: { opus: 'claude-opus-5-5' } })).toBe('Opus 5.5')
  })

  it('numbers a model nobody has selected, from what is known of its family', () => {
    // A chat left on Default reporting claude-opus-5-5 is the CLI saying what
    // Opus is today. Without this the picker sits bare until you have
    // personally run all four, which is what it did.
    expect(modelLabel('opus', { resolved: { '': 'claude-opus-5-5[1m]' } })).toBe('Opus 5.5')
    // A subagent's model is the same kind of evidence, from a different place.
    expect(modelLabel('haiku', { families: { haiku: 'claude-haiku-4-5-20251001' } })).toBe(
      'Haiku 4.5'
    )
  })

  it("prefers the request's own answer over the family's", () => {
    // Both are real observations; the one made under this exact name wins.
    const versions = {
      resolved: { '': 'claude-opus-5', opus: 'claude-opus-5-5' },
      families: { opus: 'claude-opus-5' }
    }
    expect(modelLabel('opus', versions)).toBe('Opus 5.5')
    expect(modelLabel('', versions)).toBe('Opus 5')
  })

  it("takes the CLI's own catalog when nothing has been run at all", () => {
    // The catalog is read off the binary, so a fresh install numbers every row
    // before a single turn. Still not a number written down by us: a CLI
    // update rewrites it, which is the whole reason it is allowed to be here.
    const catalog = { opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5' }
    expect(modelLabel('opus', { catalog })).toBe('Opus 5.5')
    expect(modelLabel('haiku', { catalog })).toBe('Haiku 4.5')
    expect(modelLabel('sonnet', { catalog })).toBe('Sonnet')
  })

  it('lets what this account actually got outrank the catalog', () => {
    // The catalog is what the build would pick; a resolution is what this
    // account was really given, which is the stronger claim of the two.
    const catalog = { opus: 'claude-opus-5-5' }
    expect(modelLabel('opus', { resolved: { opus: 'claude-opus-5' }, catalog })).toBe('Opus 5')
    expect(modelLabel('opus', { families: { opus: 'claude-opus-5' }, catalog })).toBe('Opus 5')
  })

  it('falls back to the bare name before anything has been reported', () => {
    expect(modelLabel('opus', {})).toBe('Opus')
  })

  it('shows a pinned id exactly as it was typed', () => {
    // `claude-opus-5-5[1m]` and `claude-opus-5-5` are different requests, and
    // shortening the first to "Opus 5.5" hides which one is in force.
    expect(modelLabel('claude-opus-5-5[1m]', {})).toBe('claude-opus-5-5[1m]')
  })

  it('says Default until the CLI has said otherwise', () => {
    expect(modelLabel('', {})).toBe('Default')
  })
})

describe('chatModelLabel', () => {
  const versions = { resolved: { opus: 'claude-opus-5-5' } }

  it("names what this chat's own process resolved to", () => {
    // Two chats can hold the same alias and different models: a process
    // resolves --model once, at spawn, and keeps it for as long as it lives.
    const older = { requested: 'opus', id: 'claude-opus-5' }
    expect(chatModelLabel('opus', older, versions)).toBe('Opus 5')
    expect(chatModelLabel('opus', null, versions)).toBe('Opus 5.5')
  })

  it('drops the running model the moment a different one is picked', () => {
    // The process behind the chat is still on Opus, but the next turn will not
    // be, and the pill describes what you have chosen.
    const running = { requested: 'opus', id: 'claude-opus-5-5' }
    expect(chatModelLabel('haiku', running, versions)).toBe('Haiku')
  })

  it('names the CLI default from the process that ran under it', () => {
    const running = { requested: '', id: 'claude-opus-5-5[1m]' }
    expect(chatModelLabel('', running)).toBe('Opus 5.5')
    expect(chatModelLabel('', null)).toBe('Default')
  })

  it('falls back when the id is one it cannot name', () => {
    const running = { requested: 'opus', id: 'some-internal-build' }
    expect(chatModelLabel('opus', running, versions)).toBe('Opus 5.5')
  })
})
