import { describe, expect, it } from 'vitest'
import { pickMiniature } from '@renderer/components/Miniature'
import { seenAgo } from '@renderer/components/desktop/DesktopPip'

const base = {
  browserVisible: false,
  enabled: true,
  hasSession: true,
  dismissed: false,
  seenAt: null as number | null,
  browserAt: 0
}

/**
 * One miniature, two surfaces. Whichever the chat touched last is the one
 * worth covering the conversation with; the old browser rules still hold.
 */
describe('which miniature floats over the chat', () => {
  it('shows nothing when there is nothing to show', () => {
    expect(pickMiniature(base)).toBeNull()
  })

  it('shows the browser alone, and another app alone', () => {
    expect(pickMiniature({ ...base, browserVisible: true })).toBe('browser')
    expect(pickMiniature({ ...base, seenAt: 10 })).toBe('desktop')
  })

  it('lets whichever was touched last win', () => {
    const both = { ...base, browserVisible: true }
    expect(pickMiniature({ ...both, seenAt: 20, browserAt: 10 })).toBe('desktop')
    expect(pickMiniature({ ...both, seenAt: 10, browserAt: 20 })).toBe('browser')
  })

  it('keeps the switch and the dismissal', () => {
    expect(pickMiniature({ ...base, seenAt: 10, enabled: false })).toBeNull()
    expect(pickMiniature({ ...base, seenAt: 10, dismissed: true })).toBeNull()
    expect(pickMiniature({ ...base, seenAt: 10, hasSession: false })).toBeNull()
  })
})

describe('seen … ago', () => {
  it('is coarse, and never negative', () => {
    expect(seenAgo(1000, 1000)).toBe('seen just now')
    expect(seenAgo(0, 12_000)).toBe('seen 12s ago')
    expect(seenAgo(0, 180_000)).toBe('seen 3m ago')
    expect(seenAgo(0, 7_200_000)).toBe('seen 2h ago')
    expect(seenAgo(5000, 1000)).toBe('seen just now')
  })
})

describe('the design miniature', () => {
  it('joins the most-recent-wins rule', () => {
    const all = { ...base, browserVisible: true, browserAt: 10, seenAt: 20 }
    expect(pickMiniature({ ...all, designAt: 30 })).toBe('design')
    expect(pickMiniature({ ...all, designAt: 5 })).toBe('desktop')
    expect(pickMiniature({ ...base, designAt: 5 })).toBe('design')
  })

  it('steps aside while the panel shows a design, and shares the switch and dismissal', () => {
    expect(pickMiniature({ ...base, designAt: 5, designOnScreen: true })).toBeNull()
    expect(pickMiniature({ ...base, designAt: 5, dismissed: true })).toBeNull()
    expect(pickMiniature({ ...base, designAt: 5, enabled: false })).toBeNull()
  })
})
