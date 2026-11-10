import { beforeEach, describe, expect, it } from 'vitest'
import { handleAppRequest } from '@renderer/lib/appControl'
import { answerChatStart, answerStatusAccess } from '@renderer/lib/chatControl'
import { useChatRequestsStore } from '@renderer/store/chatRequests'
import { useRunningStore } from '@renderer/store/running'
import { useSessionsStore, type Message, type Project, type Session } from '@renderer/store/sessions'

const session = (over: Partial<Session> & { id: string }): Session => ({
  provider: 'claude',
  providerSessionIds: {},
  title: over.id,
  cwd: '/repo',
  createdAt: 0,
  messages: [{ id: `${over.id}-m`, role: 'user', text: 'hi' }],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const project = (id: string, workspaceId = 'ws'): Project => ({ id, name: id, path: `/${id}`, workspaceId })

const asks = (chatId: string) => useChatRequestsStore.getState().bySession[chatId] ?? { starts: [], peeks: [] }
const find = (id: string) => useSessionsStore.getState().sessions.find((s) => s.id === id)

beforeEach(() => {
  useChatRequestsStore.setState({ bySession: {} })
  useRunningStore.setState({ running: {}, startedAt: {}, thinkingSince: {} })
  useSessionsStore.setState({
    projects: [project('nyra'), project('web'), project('elsewhere', 'other-ws')],
    sessions: [
      session({ id: 'asker', title: 'Migrate settings', projectId: 'nyra' }),
      session({ id: 'sibling', title: 'Table widths', projectId: 'nyra' }),
      session({ id: 'web-chat', title: 'Upload retry', projectId: 'web' }),
      session({ id: 'far', title: 'Other account', projectId: 'elsewhere' })
    ],
    activeSessionId: 'asker'
  })
})

describe('starting a chat', () => {
  it('waits in the asking chat, and on a yes starts it in the background with your changes', async () => {
    const answered = handleAppRequest('chat.start', {
      chatId: 'asker',
      title: 'Fix the flaky test',
      reason: 'So this chat can stay on the migration',
      prompt: 'The refresh test flakes on CI.',
      model: 'opus',
      effort: 'high',
      planMode: true
    })
    const request = asks('asker').starts[0]
    expect(request.title).toBe('Fix the flaky test')
    expect(request.projectId).toBe('nyra')

    useChatRequestsStore.getState().editStart('asker', request.requestId, { effort: 'max' })
    answerChatStart('asker', request.requestId, { outcome: 'started', open: false })
    const result = (await answered) as Record<string, unknown>

    expect(result).toMatchObject({ outcome: 'started', effort: 'max', model: 'opus', changedByUser: ['effort'] })
    const started = find(String(result.chat))!
    expect(started).toMatchObject({
      title: 'Fix the flaky test',
      projectId: 'nyra',
      model: 'opus',
      effort: 'max',
      planMode: true,
      spawnedBy: { sessionId: 'asker', title: 'Migrate settings' }
    })
    // You stay where you were.
    expect(useSessionsStore.getState().activeSessionId).toBe('asker')
    expect(asks('asker').starts).toHaveLength(0)
  })

  it('carries a decline note back as the reason', async () => {
    const answered = handleAppRequest('chat.start', { chatId: 'asker', title: 'T', prompt: 'P' })
    answerChatStart('asker', asks('asker').starts[0].requestId, { outcome: 'declined', message: 'Not yet' })
    await expect(answered).resolves.toEqual({ ok: true, outcome: 'declined', message: 'Not yet' })
    expect(useSessionsStore.getState().sessions).toHaveLength(4)
  })

  it('starts only in a project of the same workspace', async () => {
    await expect(
      handleAppRequest('chat.start', { chatId: 'asker', title: 'T', prompt: 'P', project: 'elsewhere' })
    ).resolves.toMatchObject({ ok: false })
    const answered = handleAppRequest('chat.start', { chatId: 'asker', title: 'T', prompt: 'P', project: 'Web' })
    expect(asks('asker').starts[0].projectId).toBe('web')
    answerChatStart('asker', asks('asker').starts[0].requestId, { outcome: 'withdrawn' })
    await expect(answered).resolves.toEqual({ ok: true, outcome: 'withdrawn' })
  })
})

describe('seeing other chats', () => {
  it('lists its own project without asking, and never another workspace', async () => {
    useRunningStore.getState().startRun('sibling')
    const listed = (await handleAppRequest('chat.list', { chatId: 'asker' })) as { chats: { id: string; state: string }[] }
    expect(listed.chats.map((c) => c.id)).toEqual(['sibling'])
    expect(listed.chats[0].state).toBe('running')
    await expect(handleAppRequest('chat.status', { chatId: 'asker', chat: 'far' })).resolves.toMatchObject({ ok: false })
    await expect(handleAppRequest('chat.list', { chatId: 'asker', project: 'elsewhere' })).resolves.toMatchObject({ ok: false })
    expect(asks('asker').peeks).toHaveLength(0)
  })

  it('asks once for another project, and remembers "Always" on the asking project', async () => {
    const first = handleAppRequest('chat.status', { chatId: 'asker', chat: 'web-chat' })
    const peek = asks('asker').peeks[0]
    expect(peek).toMatchObject({ projectKey: 'web', projectName: 'web', canAlways: true })
    answerStatusAccess('asker', peek.key, 'always')
    await expect(first).resolves.toMatchObject({ ok: true, id: 'web-chat', title: 'Upload retry' })
    expect(useSessionsStore.getState().projects.find((p) => p.id === 'nyra')?.statusAccess?.[0].projectId).toBe('web')

    // The sibling chat in the same project inherits it; nothing is asked again.
    await expect(handleAppRequest('chat.status', { chatId: 'sibling', chat: 'web-chat' })).resolves.toMatchObject({ ok: true })
    expect(asks('sibling').peeks).toHaveLength(0)
  })

  it('keeps "In this chat" to the chat, and "No" refuses', async () => {
    const asked = handleAppRequest('chat.list', { chatId: 'asker', project: 'web' })
    answerStatusAccess('asker', asks('asker').peeks[0].key, 'chat')
    await expect(asked).resolves.toMatchObject({ ok: true, project: 'web' })
    expect(find('asker')?.statusGrants).toEqual(['web'])

    const refused = handleAppRequest('chat.status', { chatId: 'sibling', chat: 'web-chat' })
    answerStatusAccess('sibling', asks('sibling').peeks[0].key, 'no')
    await expect(refused).resolves.toMatchObject({ ok: false })
  })

  it('reads the last reply only of a chat it started', async () => {
    const reply: Message[] = [
      { id: 'u', role: 'user', text: 'go' },
      { id: 'a1', role: 'assistant', text: 'Fixed the race.' },
      { id: 't', role: 'tool_call', tool_id: 't', tool_name: 'Bash', input: {}, result: 'ok' },
      { id: 'a2', role: 'assistant', text: 'Draft PR #412.' }
    ]
    useSessionsStore.setState((s) => ({
      sessions: [
        ...s.sessions,
        session({ id: 'child', projectId: 'web', messages: reply, spawnedBy: { sessionId: 'asker', title: 'x', at: 0 } })
      ]
    }))
    await expect(handleAppRequest('chat.read', { chatId: 'asker', chat: 'child' })).resolves.toMatchObject({
      ok: true,
      reply: 'Fixed the race.\n\nDraft PR #412.'
    })
    await expect(handleAppRequest('chat.read', { chatId: 'asker', chat: 'sibling' })).resolves.toMatchObject({ ok: false })
    // Its own child is visible in another project without asking.
    await expect(handleAppRequest('chat.status', { chatId: 'asker', chat: 'child' })).resolves.toMatchObject({
      ok: true,
      startedByYou: true
    })
    expect(asks('asker').peeks).toHaveLength(0)
  })
})
