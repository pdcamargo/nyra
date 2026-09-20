import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SubagentsTab from '@renderer/components/subagents/SubagentsTab'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore, type Agent } from '@renderer/store/sessions'
import { useSubagentTranscriptsStore } from '@renderer/store/subagentTranscripts'
import { useWorkspaceStore, workspaceFor } from '@renderer/store/workspace'
import { useUiStore } from '@renderer/store/ui'
import type { SubagentsWorkspaceTab } from '@renderer/store/workspace'

/** The back arrow carries a real tooltip, and Radix wants the provider App mounts. */
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const SID = 'chat-1'
const list: SubagentsWorkspaceTab = { kind: 'subagents', id: 's1', focus: null }
const focused = (toolId: string): SubagentsWorkspaceTab => ({
  kind: 'subagents',
  id: 's1',
  focus: toolId
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  toolId: 't1',
  name: 'Explore the streaming pipeline',
  subagentType: 'Explore',
  status: 'running',
  startedAt: 0,
  ...over
})

const seed = (agents: Agent[], messages: unknown[] = []): void => {
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, cwd: '/repo', messages, agents }] as never,
    projects: []
  } as never)
}

beforeEach(() => {
  useSubagentTranscriptsStore.setState({ bySession: {} })
  useWorkspaceStore.setState({ bySession: {} })
  useUiStore.setState({ rightPanelOpen: true })
  vi.restoreAllMocks()
})

describe('the list', () => {
  it('is a line per agent, with what it is doing under its name', () => {
    seed([agent({ activity: 'Reading claude.rs' })])
    render(<SubagentsTab sessionId={SID} tab={list} />)

    expect(screen.getByText('Explore the streaming pipeline')).toBeInTheDocument()
    expect(screen.getByText('Reading claude.rs')).toBeInTheDocument()
  })

  it('falls back to the agent kind once there is no live line', () => {
    seed([agent({ status: 'done', activity: 'Reading claude.rs' })])
    render(<SubagentsTab sessionId={SID} tab={list} />)
    expect(screen.getByText('Explore')).toBeInTheDocument()
  })

  it('says so rather than rendering an empty pane', () => {
    seed([])
    render(<SubagentsTab sessionId={SID} tab={list} />)
    expect(screen.getByText('No subagents in this chat yet.')).toBeInTheDocument()
  })

  it('focuses the tab on the agent you clicked, without opening a second row', async () => {
    seed([agent()])
    useWorkspaceStore.getState().openSubagentsTab(SID, null)
    render(<SubagentsTab sessionId={SID} tab={list} />)

    await userEvent.click(screen.getByText('Explore the streaming pipeline'))

    const tabs = workspaceFor(useWorkspaceStore.getState(), SID).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ kind: 'subagents', focus: 't1' })
  })
})

describe('one agent', () => {
  it('streams what it said, in order, rather than waiting for the report', () => {
    seed([agent()])
    useSubagentTranscriptsStore.getState().append(SID, 't1', [
      { kind: 'thinking', text: 'checking the read loop' },
      { kind: 'tool', tool_id: 'a', name: 'Grep', input: { pattern: 'parent_tool_use_id' } },
      { kind: 'text', text: 'Nothing reads that field.' }
    ])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)

    expect(screen.getByText('checking the read loop')).toBeInTheDocument()
    expect(screen.getByText('Nothing reads that field.')).toBeInTheDocument()
    expect(screen.getByText(/parent_tool_use_id/)).toBeInTheDocument()
  })

  it('shows the model it actually ran on', () => {
    seed([agent()])
    useSubagentTranscriptsStore.getState().noteModel(SID, 't1', 'claude-opus-5')
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)
    expect(screen.getByText('Opus 5')).toBeInTheDocument()
  })

  it('says a finished agent left nothing, rather than pulsing forever', () => {
    seed([agent({ status: 'done' })])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)
    expect(screen.getByText('It left no transcript and no report.')).toBeInTheDocument()
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()
  })

  it('shows no badge at all for a model it cannot name', () => {
    seed([agent({ model: 'something-unfamiliar' })])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)
    expect(screen.queryByText(/something-unfamiliar/)).not.toBeInTheDocument()
  })

  it('shows the live line while it is still working and has said nothing', () => {
    seed([agent({ activity: 'Reading claude.rs' })])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)
    expect(screen.getByText('Reading claude.rs')).toBeInTheDocument()
  })

  it('keeps the live line under what it has already said', () => {
    // The gap this closes: a message only lands once it is complete, so between
    // the last tool call and a long answer there was nothing on screen at all,
    // and the answer then arrived in one piece.
    seed([agent({ activity: 'Reading claude.rs' })])
    useSubagentTranscriptsStore
      .getState()
      .append(SID, 't1', [{ kind: 'text', text: "I'll start with the read loop." }])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)

    expect(screen.getByText("I'll start with the read loop.")).toBeInTheDocument()
    expect(screen.getByText('Reading claude.rs')).toBeInTheDocument()
  })

  it('still pulses when the CLI has not named a step yet', () => {
    seed([agent()])
    useSubagentTranscriptsStore.getState().append(SID, 't1', [{ kind: 'text', text: 'Started.' }])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })

  it('drops the live line the moment it finishes', () => {
    seed([agent({ status: 'done', activity: 'Reading claude.rs' })])
    useSubagentTranscriptsStore.getState().append(SID, 't1', [{ kind: 'text', text: 'Done.' }])
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)

    expect(screen.getByText('Done.')).toBeInTheDocument()
    expect(screen.queryByText('Reading claude.rs')).not.toBeInTheDocument()
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()
  })

  it('shows the report under the stream once it lands', () => {
    seed(
      [agent({ status: 'done' })],
      [{ id: 'm1', role: 'tool_call', tool_id: 't1', tool_name: 'Task', input: {}, result: 'It is the missing field.' }]
    )
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)

    expect(screen.getByText('Report')).toBeInTheDocument()
    expect(screen.getByText('It is the missing field.')).toBeInTheDocument()
  })

  it('does not mistake a launch receipt for a report', () => {
    seed(
      [agent()],
      [
        {
          id: 'm1',
          role: 'tool_call',
          tool_id: 't1',
          tool_name: 'Task',
          input: {},
          result: 'Async agent launched successfully.\nagentId: abc\noutput_file: /tmp/a.output'
        }
      ]
    )
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)

    expect(screen.queryByText('Report')).not.toBeInTheDocument()
    expect(screen.queryByText(/agentId/)).not.toBeInTheDocument()
  })

  it('goes back to the list without closing the tab', async () => {
    seed([agent()])
    useWorkspaceStore.getState().openSubagentsTab(SID, 't1')
    render(<SubagentsTab sessionId={SID} tab={focused('t1')} />)

    await userEvent.click(screen.getByLabelText('Back to all subagents'))

    const tabs = workspaceFor(useWorkspaceStore.getState(), SID).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ kind: 'subagents', focus: null })
  })

  it('copes with a chat cleared out from under an open tab', () => {
    seed([])
    render(<SubagentsTab sessionId={SID} tab={focused('gone')} />)
    expect(screen.getByText('That subagent is no longer in the conversation.')).toBeInTheDocument()
  })
})
