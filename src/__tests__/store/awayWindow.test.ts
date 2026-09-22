import { describe, expect, it, beforeEach } from 'vitest'
import { useSessionsStore, type Message, type Session } from '../../renderer/src/store/sessions'

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
    useSessionsStore.setState({ sessions: [], activeSessionId: null })
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
})
