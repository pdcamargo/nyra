import { describe, expect, it } from 'vitest'
import { findCommand, findUltrathink } from '../../renderer/src/lib/composerDecorations'

describe('findCommand', () => {
  it('matches a known command at the start', () => {
    expect(findCommand('/context please')).toEqual({ from: 0, to: 8 })
  })

  it('ignores a command that is not at the start — the CLI would too', () => {
    expect(findCommand('run /context please')).toBeNull()
  })

  it('leaves an unknown slash alone, because it is probably a path', () => {
    expect(findCommand('/usr/local/bin/claude is where it lives')).toBeNull()
    expect(findCommand('/notacommand')).toBeNull()
  })

  it('matches a hyphenated command', () => {
    expect(findCommand('/pr-review')).toEqual({ from: 0, to: 10 })
  })

  it('stops at the command, not the whole line', () => {
    const span = findCommand('/clear and then some')!
    expect(span.to).toBe('/clear'.length)
  })
})

describe('findUltrathink', () => {
  it('finds it anywhere in the message', () => {
    expect(findUltrathink('please ultrathink this')).toEqual([{ from: 7, to: 17 }])
  })

  it('is case-insensitive', () => {
    expect(findUltrathink('ULTRATHINK')).toHaveLength(1)
  })

  it('finds every occurrence', () => {
    expect(findUltrathink('ultrathink then ultrathink again')).toHaveLength(2)
  })

  it('needs a word boundary, so it does not fire inside another word', () => {
    expect(findUltrathink('superultrathinking')).toEqual([])
  })

  it('returns nothing when absent', () => {
    expect(findUltrathink('just think about it')).toEqual([])
  })
})
