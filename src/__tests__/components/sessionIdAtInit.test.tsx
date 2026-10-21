import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import Chat from '../../renderer/src/components/Chat'
import { TooltipProvider } from '../../renderer/src/components/ui/tooltip'
import { useSessionsStore } from '../../renderer/src/store/sessions'
import { useRunningStore } from '../../renderer/src/store/running'

type Api = { claude: Record<string, unknown>; agents: Record<string, unknown> }

let emit: (event: unknown) => void = () => {}

const claudeSessionId = () => useSessionsStore.getState().sessions.find((s) => s.id === 's1')?.claudeSessionId

describe("a chat's Claude session id", () => {
  beforeEach(() => {
    const api = (window as unknown as { api: Api }).api
    api.claude = {
      ...api.claude,
      onEvent: (cb: (event: unknown) => void) => {
        emit = cb
        return () => {}
      },
      onPermission: () => () => {}
    }
    api.agents = { ...api.agents, list: () => Promise.resolve({ project: [], global: [] }) }
    useRunningStore.setState({ running: {}, thinkingSince: {} })
    useSessionsStore.setState({
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          claudeSessionId: null,
          title: 'Chat',
          cwd: '/tmp',
          createdAt: 0,
          messages: [],
          tasks: [],
          agents: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
        }
      ]
    })
  })

  // The app can die before the first turn ends — a turn fed by background-task
  // notifications ran for 45 minutes without a `result`, and the relaunched chat
  // started a blank conversation while the old one kept working unseen.
  it('is recorded at init, before the turn has a result', () => {
    render(
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    )
    act(() => emit({ type: 'system', subtype: 'init', session_id: 'c-new', nyraSessionId: 's1' }))
    expect(claudeSessionId()).toBe('c-new')
  })

  it('is left alone by an init that names none', () => {
    useSessionsStore.setState((state) => ({
      sessions: state.sessions.map((s) => ({ ...s, claudeSessionId: 'c-old' }))
    }))
    render(
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    )
    act(() => emit({ type: 'system', subtype: 'init', nyraSessionId: 's1' }))
    expect(claudeSessionId()).toBe('c-old')
  })
})
