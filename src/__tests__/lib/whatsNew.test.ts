import { describe, expect, it } from 'vitest'
import { compareVersions, whatsNew } from '../../renderer/src/lib/whatsNew'
import type { ReleaseNote } from '../../renderer/src/data/releaseNotes'

const NOTES: ReleaseNote[] = [
  { version: 'next', date: '', notes: ['unreleased'] },
  { version: '0.10.0', date: '2026-10-03', notes: ['ten'] },
  { version: '0.9.1', date: '2026-10-02', notes: [] },
  { version: '0.9.0', date: '2026-10-01', notes: ['nine'] },
  { version: '0.8.0', date: '2026-09-30', notes: ['eight'] }
]

const versions = (r: ReturnType<typeof whatsNew>): string[] =>
  r?.releases.map((x) => x.version) ?? []

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0)
    expect(compareVersions('0.6.1', '0.6.1')).toBe(0)
    expect(compareVersions('0.6', '0.6.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
  })
})

describe('whatsNew', () => {
  it('shows nothing on a fresh install', () => {
    expect(whatsNew(NOTES, '0.10.0', null, false)).toBeNull()
  })

  it('shows only the current release to an install that predates the record', () => {
    const r = whatsNew(NOTES, '0.10.0', null, true)
    expect(r?.from).toBeNull()
    expect(versions(r)).toEqual(['0.10.0'])
  })

  it('lists every skipped release, newest first, and never the sentinel', () => {
    const r = whatsNew(NOTES, '0.10.0', '0.8.0', true)
    expect(r?.from).toBe('0.8.0')
    // 0.9.1 has no notes, so it is not a heading with nothing under it.
    expect(versions(r)).toEqual(['0.10.0', '0.9.0'])
  })

  it('shows nothing on a relaunch or a downgrade', () => {
    expect(whatsNew(NOTES, '0.9.0', '0.9.0', true)).toBeNull()
    expect(whatsNew(NOTES, '0.8.0', '0.9.0', true)).toBeNull()
  })

  it('shows nothing when the new version carries no notes', () => {
    expect(whatsNew(NOTES, '0.9.1', '0.9.0', true)).toBeNull()
  })
})
