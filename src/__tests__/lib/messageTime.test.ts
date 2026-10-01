import { describe, it, expect } from 'vitest'
import { formatMessageTime } from '../../renderer/src/lib/messageTime'

// A fixed Wednesday afternoon to measure everything against.
const NOW = new Date('2026-09-16T15:00:00').getTime()
const hoursAgo = (n: number): number => NOW - n * 60 * 60 * 1000
// The assertions read English names, so the locale is pinned rather than taken
// from whichever machine runs the suite.
const daysAgo = (n: number): number => NOW - n * 24 * 60 * 60 * 1000

describe('formatMessageTime', () => {
  it('shows only the clock for today', () => {
    expect(formatMessageTime(hoursAgo(3), NOW, 'en-US')).not.toMatch(/[A-Za-z]{4,}/)
  })

  it('names the day within the last week', () => {
    expect(formatMessageTime(daysAgo(2), NOW, 'en-US')).toMatch(/^Monday /)
  })

  it('treats "today" as the calendar day, not the last 24 hours', () => {
    // 11pm yesterday is 16 hours ago, and calling it "today" would be a lie.
    const lateYesterday = new Date('2026-09-15T23:00:00').getTime()
    expect(formatMessageTime(lateYesterday, NOW, 'en-US')).toMatch(/^Tuesday /)
  })

  it('falls back to a date once the day name stops helping', () => {
    const older = formatMessageTime(daysAgo(20), NOW, 'en-US')
    expect(older).not.toMatch(/day/i)
    expect(older).toMatch(/Aug/)
  })

  it('adds the year only when it differs', () => {
    expect(formatMessageTime(daysAgo(20), NOW, 'en-US')).not.toMatch(/2026/)
    expect(formatMessageTime(daysAgo(400), NOW, 'en-US')).toMatch(/2025/)
  })
})
