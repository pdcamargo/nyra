import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import {
  AWAY_MIN_MS,
  useSessionsStore,
  type Message,
  type Session
} from '../../renderer/src/store/sessions'

const T0 = 1_700_000_000_000

function base(id: string, partial: Partial<Session> = {}): Session {
  return {
    id,
    claudeSessionId: null,
    title: id,
    cwd: '/tmp',
    createdAt: T0,
    messages: [],
    tasks: [],
    agents: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ...partial
  }
}

const msg = (id: string, ts: number): Message =>
  ({ id, role: 'assistant', text: 'ok', timestamp: ts }) as Message

const get = (id: string): Session =>
  useSessionsStore.getState().sessions.find((s) => s.id === id)!

describe('the away window', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null, windowAway: false })
  })

  it('pins the window before unread is cleared', () => {
    useSessionsStore.setState({
      sessions: [
        base('a', {
          unread: 2,
          turns: 5,
          turnsSeen: 3,
          messages: [msg('m1', T0), msg('m2', T0 + 100), msg('m3', T0 + 200)]
        })
      ],
      activeSessionId: 'other'
    })

    useSessionsStore.getState().setActiveSession('a')

    const s = get('a')
    expect(s.unread).toBe(0)
    // Two unread of three messages: the window opens at the second.
    expect(s.away).toEqual({ since: T0 + 100, turnsAtLeave: 3 })
  })

  it('does not open a window for a chat you were already reading', () => {
    useSessionsStore.setState({
      sessions: [base('a', { messages: [msg('m1', T0)] })],
      activeSessionId: 'other'
    })
    useSessionsStore.getState().setActiveSession('a')
    expect(get('a').away).toBeUndefined()
  })

  it('records the turns you had seen when you look away', () => {
    useSessionsStore.setState({
      sessions: [base('a', { turns: 4 }), base('b')],
      activeSessionId: 'a'
    })
    useSessionsStore.getState().setActiveSession('b')
    expect(get('a').turnsSeen).toBe(4)
  })

  it('counts a turn', () => {
    useSessionsStore.setState({ sessions: [base('a', { turns: 2 })], activeSessionId: 'a' })
    useSessionsStore.getState().noteTurn('a')
    expect(get('a').turns).toBe(3)
  })

  it('dismissing banks the turns, so reopening does not re-report them', () => {
    useSessionsStore.setState({
      sessions: [base('a', { turns: 9, away: { since: T0, turnsAtLeave: 2 } })],
      activeSessionId: 'a'
    })
    useSessionsStore.getState().dismissAway('a')
    const s = get('a')
    expect(s.away).toBeNull()
    expect(s.turnsSeen).toBe(9)
  })

  it('treats a chat that was never open as away since its first unread', () => {
    useSessionsStore.setState({
      sessions: [base('a', { unread: 1, turns: 2, messages: [msg('m1', T0), msg('m2', T0 + 50)] })],
      activeSessionId: null
    })
    useSessionsStore.getState().setActiveSession('a')
    expect(get('a').away).toEqual({ since: T0 + 50, turnsAtLeave: 0 })
  })

  describe('a minimum time away', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** Leave `a` for `b`, let a message land in `a`, come back after `ms`. */
    const awayFor = (ms: number): Session => {
      vi.useFakeTimers({ now: T0 })
      useSessionsStore.setState({
        sessions: [base('a', { turns: 1, messages: [msg('m1', T0 - 10)] }), base('b')],
        activeSessionId: 'a'
      })
      useSessionsStore.getState().setActiveSession('b')
      useSessionsStore.getState().addMessage('a', msg('m2', T0 + 1000))
      vi.setSystemTime(T0 + ms)
      useSessionsStore.getState().setActiveSession('a')
      return get('a')
    }

    it('opens no window for a quick look at another chat', () => {
      const s = awayFor(20_000)
      expect(s.unread).toBe(0)
      expect(s.away).toBeUndefined()
    })

    it('opens one once you were gone long enough', () => {
      const s = awayFor(AWAY_MIN_MS)
      expect(s.unread).toBe(0)
      expect(s.away).toEqual({ since: T0 + 1000, turnsAtLeave: 1 })
    })
  })

  describe('the window out of focus', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('counts minimising towards the time away from the chat on screen', () => {
      vi.useFakeTimers({ now: T0 })
      useSessionsStore.setState({
        sessions: [base('a', { turns: 3, messages: [msg('m1', T0 - 10)] })],
        activeSessionId: 'a'
      })
      useSessionsStore.getState().setWindowAway(true)
      // On screen, but nobody is looking: it is news.
      useSessionsStore.getState().addMessage('a', msg('m2', T0 + 1000))
      expect(get('a').unread).toBe(1)

      vi.setSystemTime(T0 + AWAY_MIN_MS)
      useSessionsStore.getState().setWindowAway(false)
      const s = get('a')
      expect(s.unread).toBe(0)
      expect(s.away).toEqual({ since: T0 + 1000, turnsAtLeave: 3 })
      expect(s.leftAt).toBeUndefined()
    })

    it('treats a quick alt-tab as nothing', () => {
      vi.useFakeTimers({ now: T0 })
      useSessionsStore.setState({ sessions: [base('a')], activeSessionId: 'a' })
      useSessionsStore.getState().setWindowAway(true)
      useSessionsStore.getState().addMessage('a', msg('m1', T0 + 500))
      vi.setSystemTime(T0 + 10_000)
      useSessionsStore.getState().setWindowAway(false)
      expect(get('a').unread).toBe(0)
      expect(get('a').away).toBeUndefined()
    })

    it('adds a minute in another chat to a minute minimised', () => {
      vi.useFakeTimers({ now: T0 })
      useSessionsStore.setState({
        sessions: [base('a', { turns: 1 }), base('b')],
        activeSessionId: 'a'
      })
      useSessionsStore.getState().setActiveSession('b')
      useSessionsStore.getState().addMessage('a', msg('m1', T0 + 1000))
      vi.setSystemTime(T0 + 60_000)
      useSessionsStore.getState().setWindowAway(true)
      vi.setSystemTime(T0 + 120_000)
      useSessionsStore.getState().setWindowAway(false)
      useSessionsStore.getState().setActiveSession('a')
      expect(get('a').away).toEqual({ since: T0 + 1000, turnsAtLeave: 1 })
    })
  })
})
