import type React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'

/** Controls carry real tooltips now, and Radix needs the provider App mounts at
 *  the root. A slice of the tree has to supply its own. */
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
import userEvent from '@testing-library/user-event'
import PlanCard, { splitPlan } from '../../renderer/src/components/PlanCard'
import { usePlanApprovalStore } from '../../renderer/src/store/planApprovals'
import { useSessionsStore, type ToolCallMessage } from '../../renderer/src/store/sessions'
import { useUiStore } from '../../renderer/src/store/ui'
import { useWorkspaceStore, workspaceFor } from '../../renderer/src/store/workspace'

const plan: ToolCallMessage = {
  id: 'm1',
  role: 'tool_call',
  tool_id: 't1',
  tool_name: 'ExitPlanMode',
  input: { plan: '## Do the thing\n\nFirst this, then that.', path: '/p.md' }
}

describe('splitPlan', () => {
  it('lifts the opening heading out so the card does not print it twice', () => {
    const { title, body } = splitPlan('## Retire the Agents tab\n\nMove the panel.')
    expect(title).toBe('Retire the Agents tab')
    expect(body).toBe('Move the panel.')
  })

  it('leaves a heading alone when prose comes first — that names a section', () => {
    const plan = 'Here is the shape of it.\n\n## Phase 1\n\nDo the thing.'
    const { title, body } = splitPlan(plan)
    expect(title).toBe('Here is the shape of it.')
    expect(body).toBe(plan)
  })

  it('tolerates blank lines before the heading', () => {
    expect(splitPlan('\n\n# Title\n\nbody').title).toBe('Title')
  })

  it('falls back to a truncated first line, and to a label when empty', () => {
    expect(splitPlan('x'.repeat(200)).title).toHaveLength(90)
    expect(splitPlan('   \n\n  ').title).toBe('Plan')
  })
})

describe('usePlanApprovalStore', () => {
  beforeEach(() => usePlanApprovalStore.setState({ pending: {}, drafting: {} }))

  it('tracks which session a plan is parked on', () => {
    const { add } = usePlanApprovalStore.getState()
    add('t1', 's1')
    expect(usePlanApprovalStore.getState().pending.t1).toBe('s1')
  })

  it('reports a plan as pending even when it carries no session id', () => {
    usePlanApprovalStore.getState().add('t1', undefined)
    // `in` and not a truthiness check — the card's status hangs off this.
    expect('t1' in usePlanApprovalStore.getState().pending).toBe(true)
  })

  it('resolve drops one plan, clearSession drops a whole conversation', () => {
    const { add, resolve, clearSession } = usePlanApprovalStore.getState()
    add('t1', 's1')
    add('t2', 's1')
    add('t3', 's2')
    resolve('t1')
    expect(Object.keys(usePlanApprovalStore.getState().pending)).toEqual(['t2', 't3'])
    clearSession('s1')
    expect(Object.keys(usePlanApprovalStore.getState().pending)).toEqual(['t3'])
  })
})

describe('a plan still being drafted', () => {
  beforeEach(() => usePlanApprovalStore.setState({ pending: {}, drafting: {} }))

  it('owes no answer until the turn that wrote it ends', () => {
    const { draft, promote } = usePlanApprovalStore.getState()
    draft('t1', 's1')
    // The whole point: a half-written plan must not claim to be waiting on you.
    expect('t1' in usePlanApprovalStore.getState().pending).toBe(false)
    promote('s1')
    expect(usePlanApprovalStore.getState().pending.t1).toBe('s1')
    expect(usePlanApprovalStore.getState().drafting).toEqual({})
  })

  it('promote wakes one conversation, not every conversation', () => {
    const { draft, promote } = usePlanApprovalStore.getState()
    draft('t1', 's1')
    draft('t2', 's2')
    promote('s1')
    expect(Object.keys(usePlanApprovalStore.getState().pending)).toEqual(['t1'])
    expect(Object.keys(usePlanApprovalStore.getState().drafting)).toEqual(['t2'])
  })

  it('resolve and clearSession reach into drafting as well as pending', () => {
    const { draft, resolve, clearSession } = usePlanApprovalStore.getState()
    draft('t1', 's1')
    draft('t2', 's2')
    resolve('t1')
    expect(usePlanApprovalStore.getState().drafting).toEqual({ t2: 's2' })
    clearSession('s2')
    expect(usePlanApprovalStore.getState().drafting).toEqual({})
  })

  it('says so, and offers nothing to press', () => {
    usePlanApprovalStore.setState({ pending: {}, drafting: { t1: 's1' } })
    render(<PlanCard message={plan} />)
    expect(screen.getByText('Drafting…')).toBeInTheDocument()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
    // Never this one. "Kept planning" is a verdict, and nothing but a click gives it.
    expect(screen.queryByText('Kept planning')).not.toBeInTheDocument()
  })
})

describe('opening a plan', () => {
  beforeEach(() => {
    usePlanApprovalStore.setState({ pending: {}, drafting: {} })
    useWorkspaceStore.setState({ bySession: {} })
    useUiStore.setState({ rightPanelOpen: false })
    useSessionsStore.setState({
      activeSessionId: 's1',
      sessions: [{ id: 's1', cwd: '/repo' }] as never,
      projects: []
    } as never)
  })

  it('sends the plan to the side panel instead of expanding in place', async () => {
    render(<PlanCard message={plan} />)

    await userEvent.click(screen.getByRole('button', { name: /Open plan/ }))

    expect(useUiStore.getState().rightPanelOpen).toBe(true)
    expect(workspaceFor(useWorkspaceStore.getState(), 's1').tabs).toEqual([
      { kind: 'plan', id: expect.any(String), toolId: 't1' }
    ])
  })

  it('shows no body in the transcript — the panel is where a plan is read', () => {
    render(<PlanCard message={plan} />)
    expect(screen.queryByText('First this, then that.')).not.toBeInTheDocument()
  })
})

describe('PlanCard actions', () => {
  beforeEach(() => usePlanApprovalStore.setState({ pending: { t1: 's1' }, drafting: {} }))

  it('stays out of the transcript while it is pinned above the composer', () => {
    // Otherwise the same plan asks the same question in two places at once.
    const { container } = render(<PlanCard message={plan} onAnswer={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('comes back to the transcript once answered', () => {
    usePlanApprovalStore.setState({ pending: {} })
    render(<PlanCard message={{ ...plan, result: 'ok' }} onAnswer={vi.fn()} />)
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
  })

  it('shows the plan under a fade rather than only its title', () => {
    // A title is not enough to approve on, and a long plan should not become the
    // whole screen either.
    render(<PlanCard message={plan} onAnswer={vi.fn()} pinned />)
    expect(screen.getByText(/First this, then that/)).toBeInTheDocument()
  })

  it('offers no "Keep planning" button — the composer below is that answer', () => {
    render(<PlanCard message={plan} onAnswer={vi.fn()} pinned />)

    // It existed only to reveal a text field two inches under the one already in
    // front of you. The placeholder carries it now.
    expect(screen.queryByRole('button', { name: /keep planning/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/what should change/i)).not.toBeInTheDocument()
  })

  it('offers both ways of saying yes, and tells them apart', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<PlanCard message={plan} onAnswer={onAnswer} pinned />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(onAnswer).toHaveBeenCalledWith('t1', 'approve', '/p.md', undefined)
  })

  it('auto-edit is a separate yes, not the same button', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<PlanCard message={plan} onAnswer={onAnswer} pinned />)

    await user.click(screen.getByRole('button', { name: /auto-edit/i }))
    expect(onAnswer).toHaveBeenCalledWith('t1', 'approve-auto', '/p.md', undefined)
  })
})
