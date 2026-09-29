import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import Chat from '../../renderer/src/components/Chat'
import { TooltipProvider } from '../../renderer/src/components/ui/tooltip'
import { useSessionsStore } from '../../renderer/src/store/sessions'
import { useRunningStore } from '../../renderer/src/store/running'

type Api = { claude: Record<string, unknown>; agents: Record<string, unknown> }

let emit: (event: unknown) => void = () => {}

describe('a turn the CLI starts by itself', () => {
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
    // The composer loads agent definitions on mount; the shared stub's empty
    // answer is not the shape it spreads.
    api.agents = { ...api.agents, list: () => Promise.resolve({ project: [], global: [] }) }
    useRunningStore.setState({ running: {}, thinkingSince: {} })
    useSessionsStore.setState({
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          claudeSessionId: 'c1',
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

  it('shows as running once Claude starts talking, and stops at the result', () => {
    render(
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    )
    expect(useRunningStore.getState().running.s1).toBeUndefined()

    act(() => emit({ type: 'assistant_text', text: 'The suite finished.', nyraSessionId: 's1' }))
    expect(useRunningStore.getState().running.s1).toBe(true)

    act(() =>
      emit({ type: 'result', result: 'done', session_id: 'c1', is_error: false, nyraSessionId: 's1' })
    )
    expect(useRunningStore.getState().running.s1).toBeUndefined()
  })

  it('is not woken by background chatter between turns', () => {
    render(
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    )
    act(() =>
      emit({
        type: 'background_tasks',
        tasks: [{ task_id: 'b1', description: 'Run the suite', task_type: 'local_bash' }],
        nyraSessionId: 's1'
      })
    )
    act(() => emit({ type: 'ai_title', title: 'Tests', nyraSessionId: 's1' }))
    expect(useRunningStore.getState().running.s1).toBeUndefined()
  })
})
