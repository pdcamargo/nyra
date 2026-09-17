import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AskUserQuestionCard from '../../renderer/src/components/AskUserQuestionCard'
import { useUiStore } from '../../renderer/src/store/ui'
import { useSessionsStore } from '../../renderer/src/store/sessions'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const ask = (over: Partial<ToolCallMessage> = {}): ToolCallMessage =>
  ({
    id: 't1',
    role: 'tool_call',
    tool_id: 'tool-1',
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which base?',
          options: [
            { label: 'Radix', description: 'The CLI default' },
            { label: 'Base UI', description: 'The other one' }
          ]
        }
      ]
    },
    ...over
  }) as ToolCallMessage

describe('AskUserQuestionCard', () => {
  it('puts the chosen option in the composer rather than sending it', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ pendingInputPrefill: null })

    render(<AskUserQuestionCard message={ask()} />)
    await user.click(screen.getByText('Radix'))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    expect(useUiStore.getState().pendingInputPrefill).toBe('Radix')
  })

  it('accepts a written answer when none of the options fit', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ pendingInputPrefill: null })

    render(<AskUserQuestionCard message={ask()} />)
    // Nothing ticked — the questionnaire refuses to submit an unanswered item,
    // so typing has to count as answering or the text is silently swallowed.
    await user.type(screen.getByPlaceholderText(/something else/i), 'Neither, use Ark')
    await user.click(screen.getByRole('button', { name: /submit/i }))

    expect(useUiStore.getState().pendingInputPrefill).toBe('Neither, use Ark')
  })

  it('records the answer on the message so a reload does not re-ask', async () => {
    const user = userEvent.setup()
    const sid = useSessionsStore.getState().createSession('/tmp/ask')
    useSessionsStore.getState().addMessage(sid, ask())

    render(<AskUserQuestionCard message={ask()} />)
    await user.click(screen.getByText('Radix'))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    const stored = useSessionsStore.getState().sessions.find((s) => s.id === sid)
    expect((stored?.messages[0] as ToolCallMessage).result).toBe('Radix')
  })

  it('is read-only once the call has a result', () => {
    render(<AskUserQuestionCard message={ask({ result: 'Radix' })} />)
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
    expect(screen.getByText('Radix')).toBeInTheDocument()
  })

  it('is read-only when the call was denied', () => {
    render(<AskUserQuestionCard message={ask({ denied: true })} />)
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
  })

  it('survives a malformed input without throwing', () => {
    render(<AskUserQuestionCard message={ask({ input: { questions: 'nope' } })} />)
    expect(screen.getByText('(no questions provided)')).toBeInTheDocument()
  })
})
