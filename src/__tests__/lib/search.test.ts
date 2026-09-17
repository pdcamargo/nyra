import { describe, expect, it } from 'vitest'
import { collectPromptHistory, searchSessions } from '../../renderer/src/lib/search'
import type { Session } from '../../renderer/src/store/sessions'

const session = (over: Partial<Session>): Session =>
  ({
    id: 'a',
    title: 'Untitled',
    cwd: '/repo',
    createdAt: 1000,
    messages: [],
    ...over
  }) as Session

describe('searchSessions', () => {
  it('matches on title and says so', () => {
    const s = session({ title: 'Fix downtime reducers' })
    const [hit] = searchSessions([s], 'downtime')
    expect(hit.matchSource).toBe('title')
    expect(hit.snippet).toBe('Fix downtime reducers')
  })

  it('falls through to message text and returns a snippet around the match', () => {
    const s = session({
      title: 'Untitled',
      messages: [{ id: '1', role: 'user', text: 'a'.repeat(60) + 'needle' + 'b'.repeat(80) }]
    } as Partial<Session>)
    const [hit] = searchSessions([s], 'needle')
    expect(hit.matchSource).toBe('message')
    expect(hit.snippet).toContain('needle')
    // elided on both sides rather than returning the whole message
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
  })

  it('prefers the title and stops scanning that session', () => {
    const s = session({
      title: 'needle in the title',
      messages: [{ id: '1', role: 'user', text: 'needle in the body' }]
    } as Partial<Session>)
    expect(searchSessions([s], 'needle')).toHaveLength(1)
  })

  it('ignores tool calls, which are not prose', () => {
    const s = session({
      messages: [
        { id: '1', role: 'tool_call', tool_id: 't1', tool_name: 'Bash', input: { cmd: 'needle' } }
      ]
    } as Partial<Session>)
    expect(searchSessions([s], 'needle')).toHaveLength(0)
  })

  it('returns nothing for a blank query rather than everything', () => {
    expect(searchSessions([session({ title: 'x' })], '   ')).toEqual([])
  })
})

describe('collectPromptHistory', () => {
  it('collects user prompts newest first', () => {
    const s = session({
      messages: [
        { id: '1', role: 'user', text: 'older', timestamp: 10 },
        { id: '2', role: 'assistant', text: 'not mine', timestamp: 20 },
        { id: '3', role: 'user', text: 'newer', timestamp: 30 }
      ]
    } as Partial<Session>)
    expect(collectPromptHistory([s]).map((i) => i.text)).toEqual(['newer', 'older'])
  })

  it('deduplicates repeated prompts, keeping the most recent', () => {
    const s = session({
      messages: [
        { id: '1', role: 'user', text: 'same', timestamp: 10 },
        { id: '2', role: 'user', text: 'same', timestamp: 30 }
      ]
    } as Partial<Session>)
    const out = collectPromptHistory([s])
    expect(out).toHaveLength(1)
    expect(out[0].timestamp).toBe(30)
  })

  it('skips blank prompts', () => {
    const s = session({
      messages: [{ id: '1', role: 'user', text: '   ', timestamp: 10 }]
    } as Partial<Session>)
    expect(collectPromptHistory([s])).toEqual([])
  })

  it('falls back to the session time when a message has none', () => {
    const s = session({
      createdAt: 555,
      messages: [{ id: '1', role: 'user', text: 'hi' }]
    } as Partial<Session>)
    expect(collectPromptHistory([s])[0].timestamp).toBe(555)
  })
})
