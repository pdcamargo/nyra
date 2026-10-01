import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_SORT,
  describeChatSort,
  isDefaultChatSort,
  lastActivityOf,
  sortChats,
  type ChatSortContext
} from '@renderer/lib/chatSort'
import { useSessionsStore, type Project, type Session } from '@renderer/store/sessions'

const session = (over: Partial<Session> & { id: string }): Session => ({
  claudeSessionId: null,
  title: over.id,
  cwd: '',
  createdAt: 0,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const said = (timestamp: number): Session['messages'][number] => ({
  id: String(timestamp),
  role: 'user',
  text: '',
  timestamp
})

const pr = (state?: 'open' | 'draft' | 'merged' | 'closed'): NonNullable<Session['pullRequests']>[number] => ({
  url: `https://github.com/o/r/pull/${state ?? 'x'}`,
  owner: 'o',
  repo: 'r',
  number: 1,
  state,
  createdAt: 0
})

const idle: ChatSortContext = { running: {}, planPending: new Set() }
const ids = (sessions: Session[]): string[] => sessions.map((s) => s.id)

describe('sortChats', () => {
  it('lists newest first by default, and oldest first reversed', () => {
    const chats = [session({ id: 'old', createdAt: 1 }), session({ id: 'new', createdAt: 3 }), session({ id: 'mid', createdAt: 2 })]
    expect(ids(sortChats(chats, undefined, idle))).toEqual(['new', 'mid', 'old'])
    expect(ids(sortChats(chats, { key: 'created', reverse: true }, idle))).toEqual(['old', 'mid', 'new'])
  })

  it('leaves its input alone', () => {
    const chats = [session({ id: 'a', createdAt: 1 }), session({ id: 'b', createdAt: 2 })]
    sortChats(chats, undefined, idle)
    expect(ids(chats)).toEqual(['a', 'b'])
  })

  it('orders by the last message, falling back to creation for a chat with none timestamped', () => {
    const chats = [
      session({ id: 'quiet', createdAt: 5 }),
      session({ id: 'busy', createdAt: 1, messages: [said(2), said(9)] }),
      session({ id: 'early', createdAt: 2, messages: [said(3)] })
    ]
    expect(lastActivityOf(chats[0])).toBe(5)
    expect(ids(sortChats(chats, { key: 'activity', reverse: false }, idle))).toEqual(['busy', 'quiet', 'early'])
  })

  it('puts a chat blocked on you above a running one, then unread, then the rest', () => {
    const chats = [
      session({ id: 'idle', createdAt: 9 }),
      session({ id: 'unread', unread: 2 }),
      session({ id: 'running' }),
      session({ id: 'plan' }),
      session({ id: 'question', needsAnswer: true })
    ]
    const ctx: ChatSortContext = { running: { running: true }, planPending: new Set(['plan']) }
    const sorted = ids(sortChats(chats, { key: 'status', reverse: false }, ctx))
    expect(sorted.slice(0, 2).sort()).toEqual(['plan', 'question'])
    expect(sorted.slice(2)).toEqual(['running', 'unread', 'idle'])
  })

  it('breaks a status tie on last activity', () => {
    const chats = [
      session({ id: 'stale', unread: 1, messages: [said(1)] }),
      session({ id: 'fresh', unread: 1, messages: [said(8)] })
    ]
    expect(ids(sortChats(chats, { key: 'status', reverse: false }, idle))).toEqual(['fresh', 'stale'])
  })

  it('ranks a chat by its best PR: open or draft, merged, closed, none', () => {
    const chats = [
      session({ id: 'none' }),
      session({ id: 'closed', pullRequests: [pr('closed')] }),
      session({ id: 'mixed', pullRequests: [pr('merged'), pr('draft')] }),
      session({ id: 'merged', pullRequests: [pr('merged')] })
    ]
    expect(ids(sortChats(chats, { key: 'pr', reverse: false }, idle))).toEqual(['mixed', 'merged', 'closed', 'none'])
    expect(ids(sortChats(chats, { key: 'pr', reverse: true }, idle))).toEqual(['none', 'closed', 'merged', 'mixed'])
  })

  it('treats a PR gh has not reported on yet as open, which is how it draws', () => {
    const chats = [session({ id: 'merged', pullRequests: [pr('merged')] }), session({ id: 'unknown', pullRequests: [pr()] })]
    expect(ids(sortChats(chats, { key: 'pr', reverse: false }, idle))).toEqual(['unknown', 'merged'])
  })

  it('sorts names the way a person reads them', () => {
    const chats = [session({ id: '1', title: 'step 10' }), session({ id: '2', title: 'Step 2' }), session({ id: '3', title: 'alpha' })]
    expect(sortChats(chats, { key: 'name', reverse: false }, idle).map((s) => s.title)).toEqual(['alpha', 'Step 2', 'step 10'])
  })
})

describe('describing a sort', () => {
  it('names the key and the end that comes first', () => {
    expect(describeChatSort({ key: 'activity', reverse: false })).toBe('Last activity · Most recent')
    expect(describeChatSort(undefined)).toBe('Created · Newest first')
  })

  it('counts a reversed default as off the default', () => {
    expect(isDefaultChatSort(undefined)).toBe(true)
    expect(isDefaultChatSort({ key: 'created', reverse: true })).toBe(false)
  })
})

describe('storing a project sort', () => {
  const project = (id: string, workspaceId: string): Project => ({ id, name: id, path: `/${id}`, workspaceId })

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: [],
      projects: [project('a', 'w1'), project('b', 'w1'), project('c', 'w2')],
      activeSessionId: null
    })
  })

  it('keeps nothing for the default, so picking it leaves no trace', () => {
    const store = useSessionsStore.getState()
    store.setProjectChatSort('a', { key: 'status', reverse: false })
    expect(useSessionsStore.getState().projects[0].chatSort).toEqual({ key: 'status', reverse: false })
    store.setProjectChatSort('a', DEFAULT_CHAT_SORT)
    expect(useSessionsStore.getState().projects[0].chatSort).toBeUndefined()
  })

  it('applies to every project in the workspace and no other', () => {
    useSessionsStore.getState().applyChatSortToWorkspace('w1', { key: 'pr', reverse: true })
    const [a, b, c] = useSessionsStore.getState().projects
    expect(a.chatSort).toEqual({ key: 'pr', reverse: true })
    expect(b.chatSort).toEqual({ key: 'pr', reverse: true })
    expect(c.chatSort).toBeUndefined()
  })
})
