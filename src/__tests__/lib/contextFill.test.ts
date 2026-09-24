import { describe, it, expect } from 'vitest'
import { contextFill } from '../../renderer/src/lib/contextFill'

describe('contextFill', () => {
  it('says nothing before a reading exists', () => {
    expect(contextFill(null)).toBeNull()
    expect(contextFill({})).toBeNull()
  })

  it('reads against the window the CLI reported', () => {
    const fill = contextFill({ contextTokens: 150_000, contextWindow: 200_000 })
    expect(fill).toMatchObject({ tokens: 150_000, window: 200_000, measured: true, pct: 75 })
  })

  // Nothing may auto-compact against a guess, so the guess has to say it is one.
  it('marks a window it had to assume', () => {
    expect(contextFill({ contextTokens: 10_000 })?.measured).toBe(false)
  })
})
