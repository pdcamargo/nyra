import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ToolCallGroup from '../../renderer/src/components/ToolCallGroup'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const later: ToolCallMessage = {
  id: 'q1',
  role: 'tool_call',
  tool_id: 'ask-later-1-0',
  tool_name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Two searches in one reply — merged how?',
        header: 'Merge',
        options: [{ label: 'Concatenate A then B' }, { label: 'Interleave by relevance' }],
        assumed: 'Concatenate A then B'
      }
    ]
  },
  deferred: 'open'
}

describe('a question Claude carried on past, in the transcript', () => {
  it('is the marker, not a second questionnaire beside the tray', () => {
    render(<ToolCallGroup messages={[later]} onQuestionAnswer={() => {}} />)
    expect(screen.getByText('Going with Concatenate A then B')).toBeInTheDocument()
    expect(screen.queryByText('Pick to answer')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
  })
})
