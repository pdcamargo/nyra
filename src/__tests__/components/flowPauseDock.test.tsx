import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FlowPauseDock from '@renderer/components/flowRuns/FlowPauseDock'
import { useFlowRunsStore, type FlowRun } from '@renderer/store/flowRuns'
import { useSessionsStore, type Session } from '@renderer/store/sessions'
import { receiveSendToChat, type SendToChat } from '@renderer/lib/messageContext'

const paused = (output: 'final' | 'lastReply'): FlowRun => ({
  executionId: 'exec-1',
  workflowId: 'retro',
  workflowName: 'Retrospective',
  chatId: 'chat-1',
  cwd: '/repo',
  inputValues: {},
  triggeredBy: 'manual',
  startedAt: 0,
  steps: [
    { id: 'c', label: 'Review with you', type: 'chat' },
    { id: 'd', label: 'Save to vault', type: 'script' }
  ],
  status: 'paused',
  nodeStates: { c: { nodeId: 'c', status: 'awaiting_review' } },
  vars: {},
  waits: [{ kind: 'chat', nodeId: 'c', label: 'Review with you', input: 'draft', output }]
})

const chat: Session = {
  id: 'chat-1',
  provider: 'claude',
  providerSessionIds: {},
  title: 'Retro',
  cwd: '/repo',
  createdAt: 0,
  messages: [{ id: 'm1', role: 'assistant', text: 'the final draft' }],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

describe('the pause bar', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [chat], activeSessionId: 'chat-1' })
  })

  // Its selector once built a new object per read, and React never settled.
  it('renders, and says where Continue hands the work', () => {
    useFlowRunsStore.setState({ runs: { 'exec-1': paused('final') }, historyLoaded: {} })
    render(<FlowPauseDock sessionId="chat-1" />)
    expect(screen.getByText('Retrospective is waiting at Review with you')).toBeInTheDocument()
    expect(screen.getByText('Continue asks Claude for the final version and hands it to Save to vault.')).toBeInTheDocument()
  })

  it('is not there for a chat with nothing paused', () => {
    useFlowRunsStore.setState({ runs: { 'exec-1': paused('final') }, historyLoaded: {} })
    const { container } = render(<FlowPauseDock sessionId="other" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('asks Claude for the final version when Claude writes it', async () => {
    const sent: SendToChat[] = []
    const stop = receiveSendToChat((d) => sent.push(d))
    useFlowRunsStore.setState({ runs: { 'exec-1': paused('final') }, historyLoaded: {} })
    render(<FlowPauseDock sessionId="chat-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Continue flow' }))
    expect(sent[0].context?.[0].body).toContain('The user pressed Continue flow')
    expect(useFlowRunsStore.getState().runs['exec-1'].handingOver).toBe(true)
    stop()
  })

  it("carries Claude's last reply on itself when the step takes that", async () => {
    const respond = vi.spyOn(window.api.workflow, 'reviewResponse').mockResolvedValue({ ok: true })
    useFlowRunsStore.setState({ runs: { 'exec-1': paused('lastReply') }, historyLoaded: {} })
    render(<FlowPauseDock sessionId="chat-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Continue flow' }))
    expect(respond).toHaveBeenCalledWith('exec-1', 'c', true, 'the final draft')
    respond.mockRestore()
  })
})
