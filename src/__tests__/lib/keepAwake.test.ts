import { describe, expect, it } from 'vitest'
import { awakeReasons, heldFor } from '@renderer/lib/keepAwake'
import { IDLE } from '@renderer/store/keepAwake'

describe('awakeReasons', () => {
  it('names each kind of work it is holding for, and skips what is not running', () => {
    expect(awakeReasons({ ...IDLE, chats: 2, monitors: 1 })).toBe('2 chats replying · 1 monitor running')
    expect(awakeReasons({ ...IDLE, tasks: 1, flows: 3 })).toBe('1 background task · 3 flows running')
  })
})

describe('heldFor', () => {
  const start = 1_000_000
  it('says nothing for the first minute, or with no hold', () => {
    expect(heldFor(null, start)).toBe('')
    expect(heldFor(start, start + 59_000)).toBe('')
  })

  it('counts minutes, then hours', () => {
    expect(heldFor(start, start + 14 * 60_000)).toBe('for 14 min')
    expect(heldFor(start, start + 120 * 60_000)).toBe('for 2 h')
    expect(heldFor(start, start + 125 * 60_000)).toBe('for 2 h 5 min')
  })
})
