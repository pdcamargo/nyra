import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import GoalChip from '../../renderer/src/components/GoalChip'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const goal = (condition: unknown): ToolCallMessage => ({
  id: 'g1',
  role: 'tool_call',
  tool_id: 'goal-1',
  tool_name: 'GoalSet',
  input: { condition },
  result: ''
})

describe('GoalChip', () => {
  it('names the act and quotes the condition', () => {
    render(<GoalChip message={goal('every test in this repo passes')} />)
    expect(screen.getByText('Goal for this turn')).toBeInTheDocument()
    expect(screen.getByText('every test in this repo passes')).toBeInTheDocument()
  })

  it('says "this turn", because that is how long it lasts', () => {
    // The CLI drops the goal after one turn in headless mode, so the chip must
    // not imply the conversation is now in a goal-seeking mode.
    render(<GoalChip message={goal('x')} />)
    expect(screen.queryByText(/Working toward/)).toBeNull()
  })

  it('keeps the full condition reachable when it is too long to show', () => {
    const long = 'a'.repeat(300)
    render(<GoalChip message={goal(long)} />)
    expect(screen.getByTitle(long)).toBeInTheDocument()
  })

  it('draws nothing without a condition', () => {
    const { container } = render(<GoalChip message={goal('')} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws nothing when the condition is not a string', () => {
    const { container } = render(<GoalChip message={goal(42)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
