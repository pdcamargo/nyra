import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createSessionsStorage } from '../../renderer/src/store/idbStorage'

type S = { id: string; title: string }
type State = { sessions: S[]; activeSessionId: string | null }

const value = (sessions: S[], activeSessionId: string | null = null) => ({
  state: { sessions, activeSessionId },
  version: 0
})
const index = () => JSON.parse(localStorage.getItem('k') ?? 'null')
const row = (id: string) => JSON.parse(localStorage.getItem(`k/${id}`) ?? 'null')

// jsdom has no IndexedDB, so the adapter falls back to localStorage — these
// tests exercise that path plus the layout, throttle and guard logic, which is
// backend-agnostic.
describe('createSessionsStorage (localStorage fallback)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes an index and one record per chat, and reads them back', async () => {
    const storage = createSessionsStorage<State>(800)
    expect(await storage.getItem('k')).toBeNull()
    storage.setItem('k', value([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], 'b'))
    expect(localStorage.getItem('k')).toBeNull()
    await vi.advanceTimersByTimeAsync(800)
    expect(index()).toEqual({ state: { activeSessionId: 'b', sessionIds: ['a', 'b'] }, version: 0 })
    expect(row('a')).toEqual({ id: 'a', title: 'A' })

    const fresh = createSessionsStorage<State>(800)
    expect(await fresh.getItem('k')).toEqual(value([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], 'b'))
  })

  it('only rewrites the chats whose object changed, and deletes removed ones', async () => {
    const storage = createSessionsStorage<State>(800)
    await storage.getItem('k')
    const a = { id: 'a', title: 'A' }
    storage.setItem('k', value([a, { id: 'b', title: 'B' }]))
    await vi.advanceTimersByTimeAsync(800)

    const set = vi.spyOn(localStorage, 'setItem')
    storage.setItem('k', value([a, { id: 'c', title: 'C' }]))
    await vi.advanceTimersByTimeAsync(800)
    expect(set.mock.calls.map((c) => c[0])).toEqual(['k/c', 'k'])
    expect(localStorage.getItem('k/b')).toBeNull()
    expect(index().state.sessionIds).toEqual(['a', 'c'])
  })

  it('splits the single-blob layout on first read without losing a chat', async () => {
    localStorage.setItem('k', JSON.stringify(value([{ id: 'a', title: 'A' }], 'a')))
    const storage = createSessionsStorage<State>(800)
    expect(await storage.getItem('k')).toEqual(value([{ id: 'a', title: 'A' }], 'a'))
    expect(index()).toEqual({ state: { activeSessionId: 'a', sessionIds: ['a'] }, version: 0 })
    expect(row('a')).toEqual({ id: 'a', title: 'A' })
  })

  it('does not rewrite chats that hydration only rebuilt', async () => {
    localStorage.setItem('k', JSON.stringify(value([{ id: 'a', title: 'A' }])))
    const storage = createSessionsStorage<State>(800)
    const read = await storage.getItem('k')
    const set = vi.spyOn(localStorage, 'setItem')
    // merge() spreads every session into a new object with the same contents.
    storage.setItem('k', value(read!.state.sessions.map((s) => ({ ...s }))))
    await vi.advanceTimersByTimeAsync(800)
    expect(set.mock.calls.map((c) => c[0])).toEqual(['k'])
  })

  it('drops writes made before the read has finished', async () => {
    localStorage.setItem('k', JSON.stringify(value([{ id: 'a', title: 'A' }])))
    const storage = createSessionsStorage<State>(800)
    storage.setItem('k', value([]))
    await vi.advanceTimersByTimeAsync(800)
    await storage.getItem('k')
    await vi.advanceTimersByTimeAsync(800)
    expect(row('a')).toEqual({ id: 'a', title: 'A' })
    expect(index().state.sessionIds).toEqual(['a'])
  })

  it('stops writing for good when the stored history cannot be read', async () => {
    localStorage.setItem('k', '{"state":{"sessions":[{"id":"a"')
    const storage = createSessionsStorage<State>(800)
    expect(await storage.getItem('k')).toBeNull()
    storage.setItem('k', value([]))
    await vi.advanceTimersByTimeAsync(800)
    await storage.removeItem('k')
    expect(localStorage.getItem('k')).toBe('{"state":{"sessions":[{"id":"a"')
  })

  it('keeps an unreadable chat on disk and in the index', async () => {
    localStorage.setItem('k', JSON.stringify({ state: { activeSessionId: null, sessionIds: ['a', 'b'] }, version: 0 }))
    localStorage.setItem('k/a', JSON.stringify({ id: 'a', title: 'A' }))
    localStorage.setItem('k/b', '{"id":"b",')
    const storage = createSessionsStorage<State>(800)
    const read = await storage.getItem('k')
    expect(read!.state.sessions).toEqual([{ id: 'a', title: 'A' }])
    storage.setItem('k', value([{ id: 'c', title: 'C' }]))
    await vi.advanceTimersByTimeAsync(800)
    expect(localStorage.getItem('k/b')).toBe('{"id":"b",')
    expect(localStorage.getItem('k/a')).toBeNull()
    expect(index().state.sessionIds).toEqual(['c', 'b'])
  })

  it('coalesces a burst of writes and flushes once with the last value', async () => {
    const storage = createSessionsStorage<State>(500)
    await storage.getItem('k')
    for (let n = 0; n < 10; n++) storage.setItem('k', value([{ id: 'a', title: String(n) }]))
    await vi.advanceTimersByTimeAsync(499)
    expect(localStorage.getItem('k')).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(row('a')).toEqual({ id: 'a', title: '9' })
  })

  it('removeItem cancels a pending write and deletes the index and every chat', async () => {
    const storage = createSessionsStorage<State>(800)
    await storage.getItem('k')
    storage.setItem('k', value([{ id: 'a', title: 'A' }]))
    await vi.advanceTimersByTimeAsync(800)
    storage.setItem('k', value([{ id: 'a', title: 'A2' }]))
    await storage.removeItem('k')
    await vi.advanceTimersByTimeAsync(800)
    expect(localStorage.getItem('k')).toBeNull()
    expect(localStorage.getItem('k/a')).toBeNull()
  })
})
