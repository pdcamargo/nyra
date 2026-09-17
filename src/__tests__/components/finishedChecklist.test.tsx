import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FinishedChecklist from '../../renderer/src/components/FinishedChecklist'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const checklist = (n: number): ToolCallMessage => ({
  id: 'c1',
  role: 'tool_call',
  tool_id: 'checklist-1',
  tool_name: 'TaskChecklist',
  input: {
    tasks: Array.from({ length: n }, (_, i) => ({
      taskId: `t${i}`, subject: `Step ${i + 1}`, description: '', status: 'completed'
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

  it('survives a message with no tasks on it', () => {
    const empty = { ...checklist(0), input: {} }
    render(<FinishedChecklist message={empty} />)
    expect(screen.getByText('0 tasks done')).toBeInTheDocument()
  })
})
