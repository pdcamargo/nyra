import { describe, it, expect } from 'vitest'
import { formatElapsed } from '../../renderer/src/components/ActivityStrip'

describe('formatElapsed', () => {
  it('reads as seconds under a minute', () => {
    expect(formatElapsed(14_000)).toBe('14s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('splits into minutes past that', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(84_000)).toBe('1m 24s')
    expect(formatElapsed(3_600_000)).toBe('60m 0s')
  })

  it('never shows a negative, however skewed the clock', () => {
    expect(formatElapsed(-5000)).toBe('0s')
  })
})
