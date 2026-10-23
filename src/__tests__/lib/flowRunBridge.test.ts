import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleFlowEvent, FLOW_RUN_TOOL } from '../../renderer/src/lib/flowRunBridge'
import { receiveSendToChat, type SendToChat } from '../../renderer/src/lib/messageContext'
import { useFlowRunsStore } from '../../renderer/src/store/flowRuns'
import { usePanelTabsStore } from '../../renderer/src/store/panelTabs'
import { useSessionsStore, type Session, type ToolCallMessage } from '../../renderer/src/store/sessions'
import type { FlowRunSummary, FlowRunWait } from '../../shared/workflow-types'

const chat = (id: string): Session => ({
  id,
  provider: 'claude',
  providerSessionIds: {},
  title: id,
  cwd: '/repo',
  createdAt: 0,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
})

const summary = (chatId: string | null): FlowRunSummary => ({
  executionId: 'exec-1',
  workflowId: 'retro',
  workflowName: 'Retrospective',
  chatId,
  cwd: '/repo',
  inputValues: {},
  triggeredBy: 'manual',
  startedAt: 1,
  steps: [
    { id: 'b', label: 'Draft retrospective', type: 'prompt' },
    { id: 'c', label: 'Review with you', type: 'chat' },
    { id: 'd', label: 'Save to vault', type: 'script' }
  ]
})

const wait: FlowRunWait = { kind: 'chat', nodeId: 'c', label: 'Review with you', input: 'the draft', output: 'final' }

const get = (id: string): Session => useSessionsStore.getState().sessions.find((s) => s.id === id)!

describe('a run reporting into its chat', () => {
  let sent: SendToChat[]
  let stop: () => void

  beforeEach(() => {
    sent = []
    stop = receiveSendToChat((d) => sent.push(d))
    useSessionsStore.setState({ sessions: [chat('chat-1'), chat('other')], projects: [], activeSessionId: 'other' })
    useFlowRunsStore.setState({ runs: {}, historyLoaded: {} })
    usePanelTabsStore.setState({ bySession: {} })
  })
  afterEach(() => stop())

  it('leaves a card and a side-panel tab in the chat that started it', () => {
    handleFlowEvent({ type: 'execution:start', executionId: 'exec-1', run: summary('chat-1') })

    const card = get('chat-1').messages.find((m) => m.role === 'tool_call') as ToolCallMessage
    expect(card.tool_name).toBe(FLOW_RUN_TOOL)
    expect(card.input.executionId).toBe('exec-1')
    const tabs = usePanelTabsStore.getState().bySession['chat-1']?.tabs ?? []
    expect(tabs).toEqual([expect.objectContaining({ kind: 'flowRun', executionId: 'exec-1' })])
    // Started again (a re-sent event) it does not leave a second card.
    handleFlowEvent({ type: 'execution:start', executionId: 'exec-1', run: summary('chat-1') })
    expect(get('chat-1').messages.filter((m) => m.role === 'tool_call')).toHaveLength(1)
  })

  it('hands Claude the step when it pauses, and marks the chat as waiting on you', async () => {
    handleFlowEvent({ type: 'execution:start', executionId: 'exec-1', run: summary('chat-1') })
    handleFlowEvent({ type: 'node:awaiting-chat', executionId: 'exec-1', nodeId: 'c', chatId: 'chat-1', workflowName: 'Retrospective', wait })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].sessionId).toBe('chat-1')
    expect(sent[0].context?.[0]).toMatchObject({ kind: 'flow-run', label: 'Retrospective paused at Review with you' })
    expect(sent[0].context?.[0].body).toContain('the draft')
    expect(useFlowRunsStore.getState().runs['exec-1'].status).toBe('paused')
    expect(get('chat-1').needsAnswer).toBe(true)

    // Continued — by the bar or by Claude — the step finishes and the chat is free.
    handleFlowEvent({ type: 'node:done', executionId: 'exec-1', nodeId: 'c', output: 'final draft' })
    expect(useFlowRunsStore.getState().runs['exec-1'].status).toBe('running')
    expect(get('chat-1').needsAnswer).toBe(false)
  })

  it('tells the chat how it ended, but not that you stopped it', () => {
    handleFlowEvent({ type: 'execution:start', executionId: 'exec-1', run: summary('chat-1') })
    handleFlowEvent({ type: 'execution:done', executionId: 'exec-1' })
    expect(sent).toHaveLength(1)
    expect(sent[0].context?.[0].label).toBe('Retrospective finished')

    sent = []
    handleFlowEvent({ type: 'execution:start', executionId: 'exec-2', run: { ...summary('chat-1'), executionId: 'exec-2' } })
    handleFlowEvent({ type: 'execution:aborted', executionId: 'exec-2' })
    expect(sent).toHaveLength(0)
  })

  it('opens a chat for a run nobody started from one, without taking the screen', async () => {
    handleFlowEvent({ type: 'execution:start', executionId: 'exec-1', run: summary(null) })
    handleFlowEvent({ type: 'node:awaiting-chat', executionId: 'exec-1', nodeId: 'c', chatId: null, workflowName: 'Retrospective', wait })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const opened = useSessionsStore.getState().sessions.find((s) => s.title === 'Retrospective · Review with you')
    expect(opened).toBeDefined()
    expect(sent[0].sessionId).toBe(opened!.id)
    expect(useFlowRunsStore.getState().runs['exec-1'].chatId).toBe(opened!.id)
    expect(useSessionsStore.getState().activeSessionId).toBe('other')
  })
})
