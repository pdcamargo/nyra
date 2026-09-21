import { describe, it, expect, beforeEach } from 'vitest'
import {
  useSessionsStore,
  queueOf,
  newMessageId,
  type McpServerInfo,
  type Message
} from '../../renderer/src/store/sessions'

const session = (id: string) =>
  useSessionsStore.getState().sessions.find((s) => s.id === id)!

function resetStore(): void {
  useSessionsStore.setState({ sessions: [], activeSessionId: null, pendingAction: null })
}

function createTestSession(): string {
  return useSessionsStore.getState().createSession('/tmp/test')
}

describe('Sessions Store', () => {
  beforeEach(resetStore)

  describe('markToolDenied', () => {
    it('marks the matching tool call and leaves the rest alone', () => {
      const id = createTestSession()
      const store = useSessionsStore.getState()
      store.addMessage(id, {
        id: 'a', role: 'tool_call', tool_id: 't1',
        tool_name: 'ExitPlanMode', input: { plan: '# one' }
      })
      store.addMessage(id, {
        id: 'b', role: 'tool_call', tool_id: 't2',
        tool_name: 'ExitPlanMode', input: { plan: '# two' }
      })
      useSessionsStore.getState().markToolDenied(id, 't1')

      const [first, second] = session(id).messages
      expect((first as { denied?: boolean }).denied).toBe(true)
      expect((second as { denied?: boolean }).denied).toBeUndefined()
    })

    it('is a no-op for an unknown session or tool', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'a', role: 'tool_call', tool_id: 't1', tool_name: 'Write', input: {}
      })
      useSessionsStore.getState().markToolDenied('nope', 't1')
      useSessionsStore.getState().markToolDenied(id, 'nope')
      expect((session(id).messages[0] as { denied?: boolean }).denied).toBeUndefined()
    })
  })

  describe('createSession', () => {
    it('creates a session and sets it as active', () => {
      const id = createTestSession()
      const state = useSessionsStore.getState()
      expect(state.sessions).toHaveLength(1)
      expect(state.activeSessionId).toBe(id)
      expect(state.sessions[0].cwd).toBe('/tmp/test')
      expect(state.sessions[0].title).toBe('New session')
      expect(state.sessions[0].claudeSessionId).toBeNull()
    })

    it('prepends new sessions', () => {
      const id1 = createTestSession()
      const id2 = createTestSession()
      const state = useSessionsStore.getState()
      expect(state.sessions).toHaveLength(2)
      expect(state.sessions[0].id).toBe(id2)
      expect(state.sessions[1].id).toBe(id1)
    })
  })

  describe('addMessage', () => {
    it('adds a message to the correct session', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'msg-1',
        role: 'user',
        text: 'Hello'
      })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0]).toMatchObject({ role: 'user', text: 'Hello' })
    })

    it('updates title on first user message', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'msg-1',
        role: 'user',
        text: 'Fix the authentication bug in the login flow'
      })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.title).toBe('Fix the authentication bug in the login ')
    })

    it('does not update title on assistant messages', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'msg-1',
        role: 'assistant',
        text: 'I can help with that'
      })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.title).toBe('New session')
    })

    it('adds timestamp if not provided', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'msg-1',
        role: 'user',
        text: 'test'
      })
      const msg = useSessionsStore.getState().sessions.find((s) => s.id === id)!.messages[0]
      expect(msg.timestamp).toBeDefined()
      expect(typeof msg.timestamp).toBe('number')
    })
  })

  describe('updateToolResult', () => {
    it('updates the result of a tool call message', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'tool-1',
        role: 'tool_call',
        tool_id: 'tool-1',
        tool_name: 'Read',
        input: { file_path: '/tmp/file.ts' }
      })
      useSessionsStore.getState().updateToolResult(id, 'tool-1', 'file contents here')
      const msg = useSessionsStore.getState().sessions.find((s) => s.id === id)!.messages[0]
      expect(msg.role).toBe('tool_call')
      expect((msg as { result?: string }).result).toBe('file contents here')
    })
  })

  describe('addPullRequest', () => {
    const pr = {
      url: 'https://github.com/o/r/pull/42',
      owner: 'o',
      repo: 'r',
      number: 42,
      createdAt: 1000
    }

    it('records a PR against the chat that opened it', () => {
      const id = createTestSession()
      useSessionsStore.getState().addPullRequest(id, pr)
      expect(session(id).pullRequests).toEqual([pr])
    })

    it('folds a second sighting onto the first rather than listing it twice', () => {
      // `gh pr create` on a branch that already has a PR answers with that
      // PR's URL, so a retried turn reports the same one again.
      const id = createTestSession()
      useSessionsStore.getState().addPullRequest(id, pr)
      useSessionsStore.getState().addPullRequest(id, { ...pr, createdAt: 9999 })
      expect(session(id).pullRequests).toHaveLength(1)
      // The first sighting is when this chat made it; the retry is not.
      expect(session(id).pullRequests![0].createdAt).toBe(1000)
    })

    it('keeps PRs from different repos apart', () => {
      const id = createTestSession()
      useSessionsStore.getState().addPullRequest(id, pr)
      useSessionsStore
        .getState()
        .addPullRequest(id, { ...pr, url: 'https://github.com/o/other/pull/42', repo: 'other' })
      expect(session(id).pullRequests).toHaveLength(2)
    })

    it('leaves other chats alone', () => {
      const a = createTestSession()
      const b = createTestSession()
      useSessionsStore.getState().addPullRequest(a, pr)
      expect(session(b).pullRequests).toBeUndefined()
    })

    it('patches state and title in without disturbing the rest', () => {
      const id = createTestSession()
      useSessionsStore.getState().addPullRequest(id, pr)
      useSessionsStore
        .getState()
        .updatePullRequest(id, pr.url, { state: 'merged', title: 'Ship it', checkedAt: 5 })
      expect(session(id).pullRequests![0]).toEqual({
        ...pr,
        state: 'merged',
        title: 'Ship it',
        checkedAt: 5
      })
    })

    it('ignores an update for a URL this chat never saw', () => {
      const id = createTestSession()
      useSessionsStore.getState().addPullRequest(id, pr)
      useSessionsStore.getState().updatePullRequest(id, 'https://github.com/x/y/pull/1', {
        state: 'closed'
      })
      expect(session(id).pullRequests![0].state).toBeUndefined()
    })
  })

  describe('restartSession', () => {
    it('clears claudeSessionId but keeps messages', () => {
      const id = createTestSession()
      useSessionsStore.getState().updateClaudeSessionId(id, 'claude-123')
      useSessionsStore.getState().addMessage(id, {
        id: 'msg-1',
        role: 'user',
        text: 'hello'
      })
      useSessionsStore.getState().restartSession(id)
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.claudeSessionId).toBeNull()
      expect(session.messages).toHaveLength(1)
    })
  })

  describe('clearMessages', () => {
    it('clears messages, tasks, agents, usage, and resets title', () => {
      const id = createTestSession()
      const store = useSessionsStore.getState()
      store.addMessage(id, { id: 'msg-1', role: 'user', text: 'hello' })
      store.addTask(id, { taskId: 't1', subject: 'test', description: '', status: 'pending', createdByToolId: 'x' })
      store.addAgent(id, { toolId: 'a1', name: 'agent', subagentType: 'general', status: 'running', startedAt: Date.now() })
      store.addUsage(id, { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 })

      useSessionsStore.getState().clearMessages(id)
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.messages).toHaveLength(0)
      expect(session.tasks).toHaveLength(0)
      expect(session.agents).toHaveLength(0)
      expect(session.usage.inputTokens).toBe(0)
      expect(session.title).toBe('New session')
    })
  })

  describe('renameSession', () => {
    it('renames the session title', () => {
      const id = createTestSession()
      useSessionsStore.getState().renameSession(id, 'My Custom Title')
      expect(useSessionsStore.getState().sessions[0].title).toBe('My Custom Title')
    })

    it('trims whitespace', () => {
      const id = createTestSession()
      useSessionsStore.getState().renameSession(id, '  Trimmed  ')
      expect(useSessionsStore.getState().sessions[0].title).toBe('Trimmed')
    })

    it('does not blank the title with empty string', () => {
      const id = createTestSession()
      useSessionsStore.getState().renameSession(id, 'Before')
      useSessionsStore.getState().renameSession(id, '   ')
      expect(useSessionsStore.getState().sessions[0].title).toBe('Before')
    })
  })

  describe('applyAiTitle', () => {
    it('replaces the title derived from the first message', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, {
        id: 'msg-1',
        role: 'user',
        text: 'Fix the authentication bug in the login form please'
      })
      useSessionsStore.getState().applyAiTitle(id, 'Login form auth bug')
      expect(session(id).title).toBe('Login form auth bug')
    })

    it('keeps up with a title Claude revises', () => {
      const id = createTestSession()
      useSessionsStore.getState().applyAiTitle(id, 'First guess')
      useSessionsStore.getState().applyAiTitle(id, 'Second thoughts')
      expect(session(id).title).toBe('Second thoughts')
    })

    it('never overwrites a name the user typed', () => {
      const id = createTestSession()
      useSessionsStore.getState().renameSession(id, 'Mine')
      useSessionsStore.getState().applyAiTitle(id, 'Claude knows better')
      expect(session(id).title).toBe('Mine')
    })

    it('leaves a fork wearing its fork suffix', () => {
      const id = createTestSession()
      useSessionsStore.getState().renameSession(id, 'Panel resizing')
      const forkId = useSessionsStore.getState().forkSession(id)
      useSessionsStore.getState().applyAiTitle(forkId, 'Panel resizing and persistence')
      expect(session(forkId).title).toBe('Panel resizing – fork')
    })

    it('starts over on a cleared chat', () => {
      const id = createTestSession()
      useSessionsStore.getState().renameSession(id, 'Mine')
      useSessionsStore.getState().clearMessages(id)
      useSessionsStore.getState().applyAiTitle(id, 'Whatever came next')
      expect(session(id).title).toBe('Whatever came next')
    })

    it('ignores an empty title and an unknown chat', () => {
      const id = createTestSession()
      useSessionsStore.getState().applyAiTitle(id, '   ')
      useSessionsStore.getState().applyAiTitle('nope', 'Somewhere else')
      expect(session(id).title).toBe('New session')
    })

    it('does not rebuild the session list for a title that has not changed', () => {
      const id = createTestSession()
      useSessionsStore.getState().applyAiTitle(id, 'Settled')
      const before = useSessionsStore.getState().sessions
      useSessionsStore.getState().applyAiTitle(id, 'Settled')
      expect(useSessionsStore.getState().sessions).toBe(before)
    })
  })

  describe('forkSession', () => {
    it('creates a forked session with copied messages and null claudeSessionId', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, { id: 'msg-1', role: 'user', text: 'Hello' })
      useSessionsStore.getState().addMessage(id, { id: 'msg-2', role: 'assistant', text: 'Hi!' })
      useSessionsStore.getState().updateClaudeSessionId(id, 'cli-123')

      const forkId = useSessionsStore.getState().forkSession(id)
      const state = useSessionsStore.getState()
      const forked = state.sessions.find((s) => s.id === forkId)!

      expect(forked).toBeDefined()
      expect(forked.claudeSessionId).toBeNull()
      expect(forked.messages).toHaveLength(2)
      expect(forked.messages[0].id).not.toBe('msg-1') // new IDs
      expect((forked.messages[0] as { text: string }).text).toBe('Hello')
      expect(forked.forkOf?.sessionId).toBe(id)
      expect(state.activeSessionId).toBe(forkId)
    })

    it('forks up to a specific message', () => {
      const id = createTestSession()
      useSessionsStore.getState().addMessage(id, { id: 'msg-1', role: 'user', text: 'First' })
      useSessionsStore.getState().addMessage(id, { id: 'msg-2', role: 'assistant', text: 'Response' })
      useSessionsStore.getState().addMessage(id, { id: 'msg-3', role: 'user', text: 'Second' })

      const forkId = useSessionsStore.getState().forkSession(id, 'msg-2')
      const forked = useSessionsStore.getState().sessions.find((s) => s.id === forkId)!

      // Should only have messages before msg-2 (index 1), so 1 message
      expect(forked.messages).toHaveLength(1)
      expect((forked.messages[0] as { text: string }).text).toBe('First')
    })
  })

  describe('deleteSession', () => {
    it('removes the session and switches active to first remaining', () => {
      const id1 = createTestSession()
      const id2 = createTestSession()
      useSessionsStore.getState().setActiveSession(id1)
      useSessionsStore.getState().deleteSession(id1)
      const state = useSessionsStore.getState()
      expect(state.sessions).toHaveLength(1)
      expect(state.activeSessionId).toBe(id2)
    })

    it('sets activeSessionId to null when last session is deleted', () => {
      const id = createTestSession()
      useSessionsStore.getState().deleteSession(id)
      expect(useSessionsStore.getState().activeSessionId).toBeNull()
    })
  })

  describe('setMcpServers', () => {
    it('stores MCP server info on the session', () => {
      const id = createTestSession()
      const servers: McpServerInfo[] = [
        { name: 'context7', status: 'connected', tools: ['resolve-library-id', 'query-docs'] },
        { name: 'canvas-mcp', status: 'failed', tools: [] }
      ]
      useSessionsStore.getState().setMcpServers(id, servers)
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.mcpServers).toHaveLength(2)
      expect(session.mcpServers![0].status).toBe('connected')
      expect(session.mcpServers![0].tools).toEqual(['resolve-library-id', 'query-docs'])
      expect(session.mcpServers![1].status).toBe('failed')
    })
  })

  describe('addUsage', () => {
    it('accumulates token usage', () => {
      const id = createTestSession()
      const store = useSessionsStore.getState()
      store.addUsage(id, { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 5 })
      store.addUsage(id, { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 20, cacheReadTokens: 10 })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.usage).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        cacheCreationTokens: 30,
        cacheReadTokens: 15
      })
    })
  })

  describe('agents', () => {
    it('adds and updates agents', () => {
      const id = createTestSession()
      const store = useSessionsStore.getState()
      store.addAgent(id, {
        toolId: 'a1',
        name: 'Explore',
        subagentType: 'Explore',
        status: 'running',
        startedAt: 1000
      })
      store.updateAgent(id, 'a1', { status: 'done', durationMs: 5000 })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.agents).toHaveLength(1)
      expect(session.agents[0].status).toBe('done')
      expect(session.agents[0].durationMs).toBe(5000)
    })
  })

  describe('message queue', () => {
    it('enqueues in order and dequeues from the front', () => {
      const id = useSessionsStore.getState().createSession('/tmp')
      const store = useSessionsStore.getState()
      store.enqueueMessage(id, { text: 'first' })
      store.enqueueMessage(id, { text: 'second' })

      expect(queueOf(session(id))).toEqual([{ text: 'first' }, { text: 'second' }])
      expect(useSessionsStore.getState().dequeueMessage(id)).toEqual({ text: 'first' })
      expect(queueOf(session(id))).toEqual([{ text: 'second' }])
    })

    it('dequeue returns null when nothing is queued', () => {
      const id = useSessionsStore.getState().createSession('/tmp')
      expect(useSessionsStore.getState().dequeueMessage(id)).toBeNull()
    })

    it('removes one message by index, keeping the rest in order', () => {
      const id = useSessionsStore.getState().createSession('/tmp')
      const store = useSessionsStore.getState()
      store.enqueueMessage(id, { text: 'a' })
      store.enqueueMessage(id, { text: 'b' })
      store.enqueueMessage(id, { text: 'c' })

      useSessionsStore.getState().removeQueuedMessage(id, 1)
      expect(queueOf(session(id))).toEqual([{ text: 'a' }, { text: 'c' }])
    })

    it('clears the whole queue', () => {
      const id = useSessionsStore.getState().createSession('/tmp')
      useSessionsStore.getState().enqueueMessage(id, { text: 'a' })
      useSessionsStore.getState().clearQueue(id)
      expect(queueOf(session(id))).toEqual([])
    })

    it('drains a message queued before the queue was a list', () => {
      // Persisted sessions carry the old singular field; it still has to send.
      const legacy = { queuedMessage: { text: 'from an older build' } }
      expect(queueOf(legacy)).toEqual([{ text: 'from an older build' }])
      expect(queueOf({})).toEqual([])
    })
  })

  describe('gitInfo and worktree', () => {
    it('sets git info on a session', () => {
      const id = createTestSession()
      useSessionsStore.getState().setGitInfo(id, { isGitRepo: true, branch: 'main' })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.isGitRepo).toBe(true)
      expect(session.branch).toBe('main')
    })

    it('sets git info to non-repo', () => {
      const id = createTestSession()
      useSessionsStore.getState().setGitInfo(id, { isGitRepo: false })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.isGitRepo).toBe(false)
      expect(session.branch).toBeUndefined()
    })

    it('sets worktree and updates branch', () => {
      const id = createTestSession()
      useSessionsStore.getState().setWorktree(id, { name: 'feat-pay', branch: 'feat/payments', path: '/tmp/wt' })
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.worktree).toEqual({ name: 'feat-pay', branch: 'feat/payments', path: '/tmp/wt' })
      expect(session.branch).toBe('feat/payments')
    })

    it('clears worktree when set to null', () => {
      const id = createTestSession()
      useSessionsStore.getState().setWorktree(id, { name: 'wt', branch: 'b', path: '/p' })
      useSessionsStore.getState().setWorktree(id, null)
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.worktree).toBeNull()
    })
  })

  describe('truncateAtMessage', () => {
    it('removes messages from the given ID onward and resets session state', () => {
      const id = createTestSession()
      const store = useSessionsStore.getState()
      store.addMessage(id, { id: 'msg-1', role: 'user', text: 'first' })
      store.addMessage(id, { id: 'msg-2', role: 'assistant', text: 'response' })
      store.addMessage(id, { id: 'msg-3', role: 'user', text: 'second' })
      store.updateClaudeSessionId(id, 'claude-abc')

      useSessionsStore.getState().truncateAtMessage(id, 'msg-2')
      const session = useSessionsStore.getState().sessions.find((s) => s.id === id)!
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].id).toBe('msg-1')
      expect(session.claudeSessionId).toBeNull()
    })
  })

  describe('pendingAction', () => {
    it('sets and clears pending actions', () => {
      const store = useSessionsStore.getState()
      store.setPendingAction({ type: 'send', text: '/help' })
      expect(useSessionsStore.getState().pendingAction).toEqual({ type: 'send', text: '/help' })
      useSessionsStore.getState().clearPendingAction()
      expect(useSessionsStore.getState().pendingAction).toBeNull()
    })
  })

  describe('toggleFavorite', () => {
    const fav = (id: string): boolean =>
      !!useSessionsStore.getState().sessions.find((s) => s.id === id)?.favorite
    const order = (id: string): number | undefined =>
      useSessionsStore.getState().sessions.find((s) => s.id === id)?.favoriteOrder

    it('marks a session as favorite and back', () => {
      const id = createTestSession()
      expect(fav(id)).toBe(false)
      useSessionsStore.getState().toggleFavorite(id)
      expect(fav(id)).toBe(true)
      useSessionsStore.getState().toggleFavorite(id)
      expect(fav(id)).toBe(false)
    })

    it('appends new favorites to the bottom of the manual order', () => {
      const a = createTestSession()
      const b = createTestSession()
      const c = createTestSession()
      useSessionsStore.getState().toggleFavorite(a)
      useSessionsStore.getState().toggleFavorite(b)
      useSessionsStore.getState().toggleFavorite(c)
      expect(order(a)).toBe(0)
      expect(order(b)).toBe(1)
      expect(order(c)).toBe(2)
    })

    it('does nothing for an unknown session id', () => {
      const id = createTestSession()
      useSessionsStore.getState().toggleFavorite('nope')
      expect(fav(id)).toBe(false)
    })
  })

  describe('reorderFavorites', () => {
    it('rewrites favoriteOrder to match the given id order', () => {
      const a = createTestSession()
      const b = createTestSession()
      const store = useSessionsStore.getState()
      store.toggleFavorite(a)
      store.toggleFavorite(b)
      // a=0, b=1 → move b above a
      useSessionsStore.getState().reorderFavorites([b, a])
      const get = (id: string): number | undefined =>
        useSessionsStore.getState().sessions.find((s) => s.id === id)?.favoriteOrder
      expect(get(b)).toBe(0)
      expect(get(a)).toBe(1)
    })

    it('leaves sessions not in the list untouched', () => {
      const a = createTestSession()
      const b = createTestSession()
      useSessionsStore.getState().toggleFavorite(a)
      useSessionsStore.getState().reorderFavorites([a])
      const bSession = useSessionsStore.getState().sessions.find((s) => s.id === b)!
      expect(bSession.favoriteOrder).toBeUndefined()
    })
  })
})

describe('message ids', () => {
  it('never mints the same id twice, even inside one millisecond', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newMessageId()))
    expect(ids.size).toBe(5000)
  })

  // The transcript is virtualized and keys on this id. A duplicate made React
  // reuse the wrong row, so measured heights landed on the wrong index and
  // messages drew on top of each other — a burst of denied edits did it every
  // time. addMessage is the one place that can guarantee it.
  it('renames a colliding id rather than admitting it', () => {
    const store = useSessionsStore.getState()
    store.createSession('/repo')
    const sid = useSessionsStore.getState().activeSessionId!

    store.addMessage(sid, { id: 'same', role: 'assistant', text: 'first' } as Message)
    store.addMessage(sid, { id: 'same', role: 'assistant', text: 'second' } as Message)

    const msgs = useSessionsStore.getState().sessions.find((s) => s.id === sid)!.messages
    expect(msgs).toHaveLength(2)
    expect(new Set(msgs.map((m) => m.id)).size).toBe(2)
    expect(msgs[1].id).not.toBe('same')
  })
})
