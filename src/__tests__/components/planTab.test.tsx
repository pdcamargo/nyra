import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import PlanTab from '@renderer/components/plan/PlanTab'
import { usePlanApprovalStore } from '@renderer/store/planApprovals'
import { useSessionsStore, type ToolCallMessage } from '@renderer/store/sessions'
import type { PlanWorkspaceTab } from '@renderer/store/workspace'

const SID = 'chat-1'
const tab: PlanWorkspaceTab = { kind: 'plan', id: 'p1', toolId: 't1' }

const plan: ToolCallMessage = {
  id: 'm1',
  role: 'tool_call',
  tool_id: 't1',
  tool_name: 'ExitPlanMode',
  input: { plan: '## Retire the Agents tab\n\nMove the panel, then delete the rail.', path: '/p.md' }
}

const seed = (messages: ToolCallMessage[]): void => {
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, cwd: '/repo', messages }] as never,
    projects: []
  } as never)
}

beforeEach(() => usePlanApprovalStore.setState({ pending: {}, drafting: {} }))

describe('PlanTab', () => {
  it('gives the plan a column: title in the header, body below', () => {
    seed([plan])
    usePlanApprovalStore.setState({ pending: { t1: SID }, drafting: {} })

    render(<PlanTab sessionId={SID} tab={tab} />)

    expect(screen.getByText('Retire the Agents tab')).toBeInTheDocument()
    expect(screen.getByText(/Move the panel, then delete the rail/)).toBeInTheDocument()
    expect(screen.getByText('Awaiting your approval')).toBeInTheDocument()
  })

  it('carries no verdict — the plan composer owns that', () => {
    seed([plan])
    usePlanApprovalStore.setState({ pending: { t1: SID }, drafting: {} })

    render(<PlanTab sessionId={SID} tab={tab} />)

    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
    expect(screen.queryByText('Approve & auto-edit')).not.toBeInTheDocument()
  })

  it('ignores the Write that shares the plan\'s tool id', () => {
    // `plan_ready` carries the tool_id of the Write that produced the plan, so
    // the transcript holds two calls under it. Taking the first match rendered
    // the Write's input — a JSON blob of `content` and `file_path` — where the
    // plan should have been. Caught in the running app, not by a test.
    const write: ToolCallMessage = {
      id: 'm0',
      role: 'tool_call',
      tool_id: 't1',
      tool_name: 'Write',
      input: { content: '# Retire the Agents tab', file_path: '/p.md' }
    }
    seed([write, plan])
    usePlanApprovalStore.setState({ pending: { t1: SID }, drafting: {} })

    render(<PlanTab sessionId={SID} tab={tab} />)

    expect(screen.getByText('Retire the Agents tab')).toBeInTheDocument()
    expect(screen.queryByText(/file_path/)).not.toBeInTheDocument()
  })

  it('says so when the chat the plan lived in is gone, rather than showing a blank pane', () => {
    seed([])

    render(<PlanTab sessionId={SID} tab={tab} />)

    expect(screen.getByText(/no longer in the conversation/)).toBeInTheDocument()
  })

  it('reports a plan still being written as such, not as approved', () => {
    seed([plan])
    usePlanApprovalStore.setState({ pending: {}, drafting: { t1: SID } })

    render(<PlanTab sessionId={SID} tab={tab} />)

    expect(screen.getByText('Still being written')).toBeInTheDocument()
  })
})
