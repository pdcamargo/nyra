import { beforeEach, describe, expect, it } from 'vitest'
import { showResource } from '../../renderer/src/lib/resourceCommands'
import { useResourceDockStore } from '../../renderer/src/store/resourceDock'
import { useSessionsStore, type Session } from '../../renderer/src/store/sessions'

const session: Session = {
  id: 'chat-a',
  claudeSessionId: null,
  title: 'A chat',
  cwd: '/repo',
  projectId: null,
  createdAt: 1,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [{ ...session, messages: [] }] })
  useResourceDockStore.setState({ bySession: {} })
})

describe('composer resource commands', () => {
  it.each(['mcp', 'status'] as const)('opens %s without leaving a transcript badge', (kind) => {
    showResource('chat-a', kind)

    expect(useResourceDockStore.getState().bySession['chat-a']).toBe(kind)
    expect(useSessionsStore.getState().sessions[0].messages).toEqual([])
  })
})
