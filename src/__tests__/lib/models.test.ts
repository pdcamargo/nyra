import { describe, it, expect } from 'vitest'
import { KNOWN_MODELS, MODEL_BLURB, modelOptions } from '../../renderer/src/lib/models'

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
