import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { useSessionsStore, type Message, type Session } from '../../renderer/src/store/sessions'
import { useRunningStore } from '../../renderer/src/store/running'
import { useSettingsStore } from '../../renderer/src/store/settings'

const T0 = 1_700_000_000_000
const MIN = 60_000
/** The threshold every test runs with, unless it sets its own. */
const THRESHOLD = 2 * MIN

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
    useRunningStore.setState({ running: {} })
    useSettingsStore.setState({ awayRecap: true, awayRecapMinutes: THRESHOLD / MIN })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins the window before unread is cleared', () => {
    useSessionsStore.setState({
      sessions: [
        base('a', {
          unread: 2,
          turns: 5,
          turnsSeen: 3,
          messages: [msg('m1', T0), msg('m2', T0 + MIN), msg('m3', T0 + 4 * MIN)]
        })
      ],
      activeSessionId: 'other'
    })

    useSessionsStore.getState().setActiveSession('a')

    const s = get('a')
    expect(s.unread).toBe(0)
    // Two unread of three messages: the window opens at the second.
    expect(s.away).toEqual({ since: T0 + MIN, turnsAtLeave: 3, ms: 3 * MIN })
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

  it('leaving the chat puts its recap away', () => {
    useSessionsStore.setState({
      sessions: [base('a', { away: { since: T0, turnsAtLeave: 0, ms: 5 * MIN } }), base('b')],
      activeSessionId: 'a'
    })
    useSessionsStore.getState().setActiveSession('b')
    expect(get('a').away).toBeNull()
  })

  /** Leave `a` for `b`, let the turn keep working in `a` for `worked`, come
   *  back after `gone`. */
  const workedFor = (worked: number, gone: number, running = false): Session => {
    vi.useFakeTimers({ now: T0 })
    useSessionsStore.setState({
      sessions: [base('a', { turns: 1, messages: [msg('m1', T0 - 10)] }), base('b')],
      activeSessionId: 'a'
    })
    useSessionsStore.getState().setActiveSession('b')
    useSessionsStore.getState().addMessage('a', msg('m2', T0 + 1000))
    useSessionsStore.getState().addMessage('a', msg('m3', T0 + worked))
    if (running) useRunningStore.setState({ running: { a: true } })
    vi.setSystemTime(T0 + gone)
    useSessionsStore.getState().setActiveSession('a')
    return get('a')
  }

  describe('a minimum amount of work missed', () => {
    it('opens no window for a quick look at another chat', () => {
      const s = workedFor(10_000, 20_000)
      expect(s.unread).toBe(0)
      expect(s.away ?? null).toBeNull()
    })

    it('opens one once the chat worked without you long enough', () => {
      const s = workedFor(THRESHOLD, THRESHOLD + 5 * MIN)
      expect(s.unread).toBe(0)
      expect(s.away).toEqual({ since: T0 + 1000, turnsAtLeave: 1, ms: THRESHOLD })
    })

    it('stops the clock when the turn finished, however long you stay gone', () => {
      const s = workedFor(30_000, 3 * 60 * MIN)
      expect(s.away ?? null).toBeNull()
    })

    it('keeps the clock running while the turn is still going', () => {
      const s = workedFor(30_000, THRESHOLD, true)
      expect(s.away).toEqual({ since: T0 + 1000, turnsAtLeave: 1, ms: THRESHOLD })
    })

    it('uses the threshold from Settings', () => {
      useSettingsStore.setState({ awayRecapMinutes: 30 })
      expect(workedFor(10 * MIN, 60 * MIN).away ?? null).toBeNull()
    })

    it('opens nothing when the recap is switched off', () => {
      useSettingsStore.setState({ awayRecap: false })
      const s = workedFor(10 * MIN, 60 * MIN)
      expect(s.unread).toBe(0)
      expect(s.away ?? null).toBeNull()
    })
  })

  describe('the window out of focus', () => {
    it('counts minimising towards the work missed in the chat on screen', () => {
      vi.useFakeTimers({ now: T0 })
      useSessionsStore.setState({
        sessions: [base('a', { turns: 3, messages: [msg('m1', T0 - 10)] })],
        activeSessionId: 'a'
      })
      useSessionsStore.getState().setWindowAway(true)
      // On screen, but nobody is looking: it is news.
      useSessionsStore.getState().addMessage('a', msg('m2', T0 + 1000))
      expect(get('a').unread).toBe(1)
      useSessionsStore.getState().addMessage('a', msg('m3', T0 + THRESHOLD))

      vi.setSystemTime(T0 + THRESHOLD + MIN)
      useSessionsStore.getState().setWindowAway(false)
      const s = get('a')
      expect(s.unread).toBe(0)
      expect(s.away).toEqual({ since: T0 + 1000, turnsAtLeave: 3, ms: THRESHOLD })
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

    it('keeps a recap on screen through an alt-tab', () => {
      const away = { since: T0, turnsAtLeave: 0, ms: 5 * MIN }
      useSessionsStore.setState({ sessions: [base('a', { away })], activeSessionId: 'a' })
      useSessionsStore.getState().setWindowAway(true)
      useSessionsStore.getState().setWindowAway(false)
      expect(get('a').away).toEqual(away)
    })

    it('adds a minute in another chat to a minute minimised', () => {
      vi.useFakeTimers({ now: T0 })
      useSessionsStore.setState({
        sessions: [base('a', { turns: 1 }), base('b')],
        activeSessionId: 'a'
      })
      useRunningStore.setState({ running: { a: true } })
      useSessionsStore.getState().setActiveSession('b')
      useSessionsStore.getState().addMessage('a', msg('m1', T0 + 1000))
      vi.setSystemTime(T0 + MIN)
      useSessionsStore.getState().setWindowAway(true)
      vi.setSystemTime(T0 + 2 * MIN)
      useSessionsStore.getState().setWindowAway(false)
      useSessionsStore.getState().setActiveSession('a')
      // Still running, so the clock ran up to the moment you came back.
      expect(get('a').away).toEqual({ since: T0 + 1000, turnsAtLeave: 1, ms: 2 * MIN })
    })
  })
})
