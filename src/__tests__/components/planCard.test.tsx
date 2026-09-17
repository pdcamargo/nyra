import { describe, it, expect, beforeEach } from 'vitest'
import { splitPlan } from '../../renderer/src/components/PlanCard'
import { usePlanApprovalStore } from '../../renderer/src/store/planApprovals'

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
