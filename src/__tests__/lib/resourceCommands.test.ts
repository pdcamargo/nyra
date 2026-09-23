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
  it('opens MCP without leaving a transcript badge', () => {
    showResource('chat-a', 'mcp')

    expect(useResourceDockStore.getState().bySession['chat-a']).toBe('mcp')
    expect(useSessionsStore.getState().sessions[0].messages).toEqual([])
  })

  it('opens status and leaves a link that can reopen it', () => {
    showResource('chat-a', 'status')

    expect(useResourceDockStore.getState().bySession['chat-a']).toBe('status')
    expect(useSessionsStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({ role: 'assistant', text: '[Session status](nyra://status)' })
    ])
  })
})
