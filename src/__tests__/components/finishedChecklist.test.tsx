import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FinishedChecklist from '../../renderer/src/components/FinishedChecklist'
import type { ToolCallMessage, TaskStatus } from '../../renderer/src/store/sessions'

/** `n` tasks, the first `done` of them completed. */
const checklist = (n: number, done = n): ToolCallMessage => ({
  id: 'c1',
  role: 'tool_call',
  tool_id: 'checklist-1',
  tool_name: 'TaskChecklist',
  input: {
    tasks: Array.from({ length: n }, (_, i) => ({
      taskId: `t${i}`,
      subject: `Step ${i + 1}`,
      description: '',
      status: (i < done ? 'completed' : 'pending') as TaskStatus
    }))
  },
  result: 'done'
})

describe('FinishedChecklist', () => {
  it('collapses to a count and opens to the list', async () => {
    const user = userEvent.setup()
    render(<FinishedChecklist message={checklist(3)} />)

    expect(screen.getByText('3 tasks done')).toBeInTheDocument()
    expect(screen.queryByText('Step 1')).toBeNull()

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Step 1')).toBeInTheDocument()
  })

  it('counts one task in the singular', () => {
    render(<FinishedChecklist message={checklist(1)} />)
    expect(screen.getByText('1 task done')).toBeInTheDocument()
  })

  // A turn can end with items still open — the work was abandoned, or Claude
  // stopped restating the block. Saying "5 tasks done" there would be a lie.
  it('reports a partial list as "N of M", not as done', () => {
    render(<FinishedChecklist message={checklist(5, 3)} />)
    expect(screen.getByText('3 of 5 done')).toBeInTheDocument()
    expect(screen.queryByText('5 tasks done')).toBeNull()
  })

  it('still reads as done when every item is ticked', () => {
    render(<FinishedChecklist message={checklist(4, 4)} />)
    expect(screen.getByText('4 tasks done')).toBeInTheDocument()
  })

  it('renders nothing for a message with no tasks on it', () => {
    const empty = { ...checklist(0), input: {} }
    const { container } = render(<FinishedChecklist message={empty} />)
    expect(container).toBeEmptyDOMElement()
  })
})
