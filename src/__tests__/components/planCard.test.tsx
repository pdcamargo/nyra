import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PlanCard, { splitPlan } from '../../renderer/src/components/PlanCard'
import { usePlanApprovalStore } from '../../renderer/src/store/planApprovals'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

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
  beforeEach(() => usePlanApprovalStore.setState({ pending: {} }))

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

describe('PlanCard actions', () => {
  beforeEach(() => usePlanApprovalStore.setState({ pending: { t1: 's1' } }))

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

  it('carries the reason along when the plan is turned down', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<PlanCard message={plan} onAnswer={onAnswer} pinned />)

    await user.click(screen.getByRole('button', { name: /keep planning/i }))
    await user.type(screen.getByPlaceholderText(/what should change/i), 'Phase 2 is wrong')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(onAnswer).toHaveBeenCalledWith('t1', 'reject', '/p.md', 'Phase 2 is wrong')
  })

  it('sends no note when none was written', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<PlanCard message={plan} onAnswer={onAnswer} pinned />)

    await user.click(screen.getByRole('button', { name: /keep planning/i }))
    // The button stays honest about what it will do while the box is empty.
    await user.click(screen.getByRole('button', { name: /^keep planning$/i }))

    expect(onAnswer).toHaveBeenCalledWith('t1', 'reject', '/p.md', undefined)
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
