import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DeferredTray from '@renderer/components/DeferredTray'
import DeferredQuestionMarker from '@renderer/components/DeferredQuestionMarker'
import type { DeferredState, ToolCallMessage } from '@renderer/store/sessions'

const later = (id: string, header: string, assumed: string, state: DeferredState = 'open', result?: string): ToolCallMessage => ({
  id,
  role: 'tool_call',
  tool_id: id,
  tool_name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: `Which ${header.toLowerCase()}?`,
        header,
        assumed,
        options: [{ label: 'OAuth', description: 'Nothing to store' }, { label: 'API key' }]
      }
    ]
  },
  deferred: state,
  ...(result ? { result } : {})
})

describe('DeferredTray', () => {
  it('starts as one line that says what Claude is going with', () => {
    render(<DeferredTray questions={[later('a', 'Auth', 'API key')]} running onAnswer={vi.fn()} onKeep={vi.fn()} />)

    expect(screen.getByText('1 open question')).toBeInTheDocument()
    expect(screen.getByText('Claude is going with API key until you answer')).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('sends only an answer that changes what Claude is doing', async () => {
    const onAnswer = vi.fn()
    render(<DeferredTray questions={[later('a', 'Auth', 'API key')]} running onAnswer={onAnswer} onKeep={vi.fn()} />)
    await userEvent.click(screen.getByText('1 open question'))

    const send = screen.getByRole('button', { name: 'Send answer' })
    expect(send).toBeDisabled()
    // Picking the assumption is keeping it, not an answer to send.
    await userEvent.click(screen.getByRole('radio', { name: /API key/ }))
    expect(send).toBeDisabled()

    await userEvent.click(screen.getByRole('radio', { name: /OAuth/ }))
    await userEvent.click(send)
    expect(onAnswer).toHaveBeenCalledWith('a', 'OAuth')
  })

  it('keeps the assumption without sending anything', async () => {
    const onKeep = vi.fn()
    const onAnswer = vi.fn()
    render(<DeferredTray questions={[later('a', 'Auth', 'API key')]} running onAnswer={onAnswer} onKeep={onKeep} />)
    await userEvent.click(screen.getByText('1 open question'))
    await userEvent.click(screen.getByRole('button', { name: 'Keep API key' }))

    expect(onKeep).toHaveBeenCalledWith('a')
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('lists several, and opens the one you pick', async () => {
    render(
      <DeferredTray
        questions={[later('a', 'Auth', 'API key'), later('b', 'Sessions', 'Postgres')]}
        running
        onAnswer={vi.fn()}
        onKeep={vi.fn()}
      />
    )
    await userEvent.click(screen.getByText('2 open questions'))
    await userEvent.click(screen.getByText('Which sessions?'))

    expect(screen.getByText('Open question')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep Postgres' })).toBeInTheDocument()
  })

  it('says an answer starts a new turn once Claude has finished', () => {
    render(<DeferredTray questions={[later('a', 'Auth', 'API key')]} running={false} onAnswer={vi.fn()} onKeep={vi.fn()} />)
    expect(screen.getByText('Claude finished with API key. Answering starts a new turn.')).toBeInTheDocument()
  })
})

describe('DeferredQuestionMarker', () => {
  it.each([
    ['open', undefined, 'Going with API key'],
    ['sending', 'OAuth', 'OAuth · reaches Claude at its next step'],
    ['read', 'OAuth', 'OAuth · read by Claude'],
    ['kept', undefined, 'Kept API key']
  ] as const)('reads %s', (state, result, note) => {
    render(<DeferredQuestionMarker message={later('a', 'Auth', 'API key', state, result)} />)
    expect(screen.getByText(note)).toBeInTheDocument()
  })
})
