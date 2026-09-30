import { describe, expect, it } from 'vitest'
import { designTarget, diffChanged, isLive, pathInResult, DESIGN_TOOL } from '@renderer/store/designActivity'

describe('which tool calls touch a design', () => {
  it('sees writes to a .nyui.json, and nothing else', () => {
    expect(designTarget('Write', { file_path: '/p/a.nyui.json' })).toEqual({ path: '/p/a.nyui.json' })
    expect(designTarget('Edit', { file_path: 'C:\\p\\A.NYUI.JSON' })).toEqual({ path: 'C:\\p\\A.NYUI.JSON' })
    expect(designTarget('Write', { file_path: '/p/a.json' })).toBeNull()
    expect(designTarget('Read', { path: '/p/a.nyui.json' })).toBeNull()
  })

  it('sees a script that names the file', () => {
    expect(designTarget('Bash', { command: 'node fix.js C:/x/pdf-export.nyui.json' })).toEqual({
      path: 'C:/x/pdf-export.nyui.json'
    })
    expect(designTarget('Bash', { command: 'npm test' })).toBeNull()
  })

  it('sees renders and creates, but not a list', () => {
    expect(designTarget(DESIGN_TOOL, { action: 'render', design: 'Billing', artboard: 'main' })).toEqual({
      design: 'Billing',
      artboard: 'main'
    })
    expect(designTarget(DESIGN_TOOL, { action: 'create', name: 'Billing' })).toEqual({ design: 'Billing', create: true })
    expect(designTarget(DESIGN_TOOL, { action: 'list' })).toBeNull()
  })

  it('reads the path a create answers with', () => {
    const text = 'Registered "X" as d_1.\n\nWrite the document to:\nC:\\Users\\me\\.nyra\\designs\\files\\x-d_1.nyui.json\n'
    expect(pathInResult(text)).toBe('C:\\Users\\me\\.nyra\\designs\\files\\x-d_1.nyui.json')
    expect(pathInResult('Rendered "X"')).toBeNull()
  })
})

describe('what changed since you looked', () => {
  const base = { a: '1', b: '1', c: '1' }

  it('flags what moved off the baseline, newest first', () => {
    const first = diffChanged([], base, base, { ...base, b: '2' }, 10)
    expect(first).toEqual([{ id: 'b', at: 10 }])
    const second = diffChanged(first, base, { ...base, b: '2' }, { ...base, b: '2', c: '2' }, 20)
    expect(second.map((c) => c.id)).toEqual(['c', 'b'])
  })

  it('unflags an artboard edited back to what you saw', () => {
    const flagged = [{ id: 'b', at: 10 }]
    expect(diffChanged(flagged, base, { ...base, b: '2' }, base, 20)).toEqual([])
  })

  it('treats a new artboard as changed, and forgets a deleted one', () => {
    expect(diffChanged([], base, base, { ...base, d: '1' }, 5)).toEqual([{ id: 'd', at: 5 }])
    expect(diffChanged([{ id: 'c', at: 1 }], base, { ...base, c: '2' }, { a: '1', b: '1' }, 5)).toEqual([])
  })
})

describe('which design is being edited', () => {
  const touch = (over: Partial<Parameters<typeof isLive>[0]> = {}) => ({
    path: '/a.nyui.json',
    at: 1,
    inFlight: [] as string[],
    hot: true,
    artboard: null,
    ...over
  })

  it('is the newest one touched this turn, not every one', () => {
    expect(isLive(touch(), true, true)).toBe(true)
    expect(isLive(touch(), true, false)).toBe(false)
  })

  it('is any with a call in flight, and none once the turn is over', () => {
    expect(isLive(touch({ inFlight: ['t1'] }), false, false)).toBe(true)
    expect(isLive(touch({ hot: false }), false, true)).toBe(false)
  })
})

describe('design paths out of free text', () => {
  it('takes only absolute paths, never a bare name or the tail of one', () => {
    expect(designTarget('Bash', { command: 'ls ~/.nyra/designs/files | grep reel-d_1.nyui.json' })).toBeNull()
    expect(designTarget('Bash', { command: 'cat files/reel-d_1.nyui.json' })).toBeNull()
    expect(designTarget('Bash', { command: 'node x.js "C:/a/reel.nyui.json"' })).toEqual({ path: 'C:/a/reel.nyui.json' })
  })
})
