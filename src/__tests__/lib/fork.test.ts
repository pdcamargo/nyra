import { beforeEach, describe, expect, it } from 'vitest'
import { forkChat, forkCut, forkLocalLabel, forkMarks, nestForks } from '@renderer/lib/fork'
import { useSessionsStore, worktreeInUse, type Message, type Session } from '@renderer/store/sessions'
import { useUiStore } from '@renderer/store/ui'
import { prunableSessions } from '@renderer/lib/worktrees'

const msg = (id: string, role: Message['role'], text = id): Message => ({ id, role, text }) as Message

const transcript: Message[] = [
  msg('u1', 'user'),
  msg('a1', 'assistant'),
  msg('t1', 'tool_call'),
  msg('a1b', 'assistant'),
  msg('u2', 'user'),
  msg('a2', 'assistant')
]

describe('where a fork is cut', () => {
  it('keeps a whole reply turn, cutting at the next message you sent', () => {
    expect(forkCut(transcript, { kind: 'reply', messageId: 'a1b' })).toBe('u2')
    // Forking an earlier reply in the same turn still keeps the turn whole.
    expect(forkCut(transcript, { kind: 'reply', messageId: 'a1' })).toBe('u2')
  })

  it('keeps everything when the reply is the latest', () => {
    expect(forkCut(transcript, { kind: 'reply', messageId: 'a2' })).toBeUndefined()
    expect(forkCut(transcript, { kind: 'latest' })).toBeUndefined()
  })

  it('cuts just before one of your messages', () => {
    expect(forkCut(transcript, { kind: 'before', messageId: 'u2' })).toBe('u2')
  })
})

describe('forkChat', () => {
  let source: string

  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null })
    useUiStore.setState({ pendingInputPrefill: null, mainView: 'skills' as never })
    source = useSessionsStore.getState().createSession('/repo')
    useSessionsStore.getState().setGitInfo(source, { isGitRepo: true, branch: 'main' })
    for (const m of transcript) useSessionsStore.getState().addMessage(source, m)
  })

  const get = (id: string): Session => useSessionsStore.getState().sessions.find((s) => s.id === id)!

  it('opens the fork, on the chat view', () => {
    const id = forkChat(source, { kind: 'latest' }, 'local')!
    expect(useSessionsStore.getState().activeSessionId).toBe(id)
    expect(useUiStore.getState().mainView).toBe('chat')
    expect(get(id).pendingWorktree ?? null).toBeNull()
  })

  it('hands your message back to the composer when forking before it', () => {
    const id = forkChat(source, { kind: 'before', messageId: 'u2' }, 'local')!
    expect(get(id).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_call', 'assistant'])
    expect(useUiStore.getState().pendingInputPrefill).toBe('u2')
  })

  it('gives a worktree fork a pending worktree branched from the source checkout', () => {
    const id = forkChat(source, { kind: 'latest' }, 'worktree')!
    expect(get(id).pendingWorktree).toMatchObject({ seed: true, baseRef: '', from: '/repo' })
    expect(get(id).forkOf?.mode).toBe('worktree')
  })

  it('forks into local outside git, whatever was asked', () => {
    useSessionsStore.getState().setGitInfo(source, { isGitRepo: false, branch: '' })
    const id = forkChat(source, { kind: 'latest' }, 'worktree')!
    expect(get(id).pendingWorktree ?? null).toBeNull()
    expect(get(id).forkOf?.mode).toBe('local')
  })

  it('does nothing for an empty chat', () => {
    const empty = useSessionsStore.getState().createSession('/repo')
    expect(forkChat(empty, { kind: 'latest' }, 'local')).toBeNull()
  })

  it('marks both chats, reading titles live', () => {
    const id = forkChat(source, { kind: 'reply', messageId: 'a1b' }, 'worktree')!
    useSessionsStore.getState().applyAiTitle(id, 'Pause queue on 401')

    const sessions = useSessionsStore.getState().sessions
    expect(forkMarks(sessions, source)).toEqual([
      { after: 'a1b', direction: 'into', title: 'Pause queue on 401', to: id }
    ])
    const [from] = forkMarks(sessions, id)
    expect(from).toMatchObject({ direction: 'from', to: source, note: 'new worktree' })
    expect(from.after).toBe(get(id).messages[3].id)
  })

  it('keeps the "Forked from" line when the source is deleted, with nowhere to go', () => {
    const id = forkChat(source, { kind: 'latest' }, 'local')!
    const title = get(source).title
    useSessionsStore.getState().deleteSession(source)
    expect(forkMarks(useSessionsStore.getState().sessions, id)).toEqual([
      expect.objectContaining({ direction: 'from', title, to: null })
    ])
  })
})

describe('forkLocalLabel', () => {
  it('says "this worktree" when the chat already runs in one', () => {
    expect(forkLocalLabel({ worktree: null })).toBe('Fork into local')
    expect(forkLocalLabel({ worktree: { name: 'w', branch: 'w', path: '/w' } })).toBe('Fork into this worktree')
  })
})

describe('nestForks', () => {
  const row = (id: string, from?: string): Pick<Session, 'id' | 'forkOf'> => ({
    id,
    ...(from ? { forkOf: { sessionId: from, messageId: '', title: '' } } : {})
  })

  it('puts forks under their source, in the order the list was sorted', () => {
    const nested = nestForks([row('b', 'a'), row('x'), row('a'), row('c', 'a'), row('d', 'b')])
    expect(nested.map(({ session, depth }) => `${session.id}${depth}`)).toEqual(['x0', 'a0', 'b1', 'd2', 'c1'])
  })

  it('leaves a fork at the top when its source is not in the list', () => {
    expect(nestForks([row('b', 'gone')]).map((n) => n.depth)).toEqual([0])
  })

  it('never drops a chat, even in a cycle', () => {
    expect(nestForks([row('a', 'b'), row('b', 'a')]).map((n) => n.session.id).sort()).toEqual(['a', 'b'])
  })
})

describe('a worktree shared with a fork', () => {
  it('is not pruned while the fork works in it', () => {
    const wt = { name: 'w', branch: 'w', path: '/wt/w' }
    const sessions = [
      { id: 'src', worktree: wt, createdAt: 1 },
      { id: 'fork', worktree: { ...wt }, createdAt: 2 }
    ] as Session[]
    expect(worktreeInUse(sessions, '/wt/w', 'src')).toBe(true)
    expect(prunableSessions(sessions, {})).toEqual([])
    expect(prunableSessions([sessions[0]], {}).map((s) => s.id)).toEqual(['src'])
  })
})
