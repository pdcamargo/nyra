import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import QuestionDock from '@renderer/components/QuestionDock'
import { useQuestionAnswerStore } from '@renderer/store/questionAnswer'
import type { ToolCallMessage } from '@renderer/store/sessions'

const ask = (multiSelect = false): ToolCallMessage => ({
  id: 'm1',
  role: 'tool_call',
  tool_id: 'q1',
  tool_name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which store?',
        options: [{ label: 'Postgres', description: 'Boring and fine' }, { label: 'SQLite' }],
        ...(multiSelect ? { multiSelect: true } : {})
      }
    ]
  }
})

beforeEach(() => useQuestionAnswerStore.getState().clear())

describe('QuestionDock', () => {
  it('renders the real options and no "Something else" row', () => {
    render(<QuestionDock message={ask()} text="" onSubmit={vi.fn()} />)

    expect(screen.getByText('Postgres')).toBeInTheDocument()
    expect(screen.getByText('Boring and fine')).toBeInTheDocument()
    // The composer is that option now; a row whose only job was to enable a text
    // field is a row that says what the text field already says.
    expect(screen.queryByText('Something else')).not.toBeInTheDocument()
  })

  it('ticks what you click, and offers radios for a single-select', async () => {
    render(<QuestionDock message={ask()} text="" onSubmit={vi.fn()} />)

    await userEvent.click(screen.getByRole('radio', { name: /Postgres/ }))

    expect(useQuestionAnswerStore.getState().picks).toEqual({ 0: ['Postgres'] })
    expect(screen.getByRole('radio', { name: /Postgres/ })).toBeChecked()
  })

  it('replaces the pick on a single-select and accumulates on a multi', async () => {
    const { unmount } = render(<QuestionDock message={ask()} text="" onSubmit={vi.fn()} />)
    await userEvent.click(screen.getByRole('radio', { name: /Postgres/ }))
    await userEvent.click(screen.getByRole('radio', { name: /SQLite/ }))
    expect(useQuestionAnswerStore.getState().picks).toEqual({ 0: ['SQLite'] })
    unmount()

    useQuestionAnswerStore.getState().clear()
    render(<QuestionDock message={ask(true)} text="" onSubmit={vi.fn()} />)
    await userEvent.click(screen.getByRole('checkbox', { name: /Postgres/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /SQLite/ }))
    expect(useQuestionAnswerStore.getState().picks).toEqual({ 0: ['Postgres', 'SQLite'] })
  })

  it('shows the ticks as cleared once you type, and says why', () => {
    useQuestionAnswerStore.setState({ picks: { 0: ['Postgres'] }, mode: 'typed' })

    render(<QuestionDock message={ask()} text="Neither, use Redis" onSubmit={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /Postgres/ })).not.toBeChecked()
    expect(screen.getByText(/Your words win/)).toBeInTheDocument()
  })

  it('warns that a tick beats whatever is still sitting in the composer', () => {
    useQuestionAnswerStore.setState({ picks: { 0: ['Postgres'] }, mode: 'picked' })

    render(<QuestionDock message={ask()} text="Neither, use Redis" onSubmit={vi.fn()} />)

    expect(screen.getByText(/Picks win — your text is ignored/)).toBeInTheDocument()
  })

  it('a single-select click is the answer — no Submit press needed', async () => {
    const onSubmit = vi.fn()
    render(<QuestionDock message={ask()} text="" onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('radio', { name: /Postgres/ }))

    expect(onSubmit).toHaveBeenCalledWith('Postgres')
  })

  it('waits for Submit when there is text to be overridden', async () => {
    const onSubmit = vi.fn()
    render(<QuestionDock message={ask()} text="Neither, use Redis" onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('radio', { name: /Postgres/ }))

    // Firing straight off would throw away what is in the composer without ever
    // showing that the pick had won.
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('never fires on its own for a multi-select', async () => {
    const onSubmit = vi.fn()
    render(<QuestionDock message={ask(true)} text="" onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /Postgres/ }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits the composed answer', async () => {
    const onSubmit = vi.fn()
    render(<QuestionDock message={ask()} text="" onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('radio', { name: /SQLite/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith('SQLite')
  })

})

describe('useQuestionAnswerStore', () => {
  it('typing clears every tick, whichever question they were on', () => {
    useQuestionAnswerStore.setState({ picks: { 0: ['a'], 1: ['b'] }, mode: 'picked' })

    useQuestionAnswerStore.getState().noteTyping()

    expect(useQuestionAnswerStore.getState()).toMatchObject({ mode: 'typed', picks: {} })
  })

  it('is a no-op once there is nothing left to clear, so keystrokes do not re-render', () => {
    useQuestionAnswerStore.setState({ picks: {}, mode: 'typed' })
    const before = useQuestionAnswerStore.getState()

    useQuestionAnswerStore.getState().noteTyping()

    expect(useQuestionAnswerStore.getState().picks).toBe(before.picks)
  })

  it('a new question starts clean', () => {
    useQuestionAnswerStore.getState().open('q1')
    useQuestionAnswerStore.getState().pick(0, 'Postgres', false)
    useQuestionAnswerStore.getState().open('q2')

    expect(useQuestionAnswerStore.getState()).toMatchObject({ toolId: 'q2', picks: {}, page: 0 })
  })

  it('re-opening the same question keeps the answers already given', () => {
    useQuestionAnswerStore.getState().open('q1')
    useQuestionAnswerStore.getState().pick(0, 'Postgres', false)
    useQuestionAnswerStore.getState().open('q1')

    expect(useQuestionAnswerStore.getState().picks).toEqual({ 0: ['Postgres'] })
  })
})
