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

  it('shows the ticks as cleared once you type', () => {
    // Typing is what clears them, and it clears only this question's.
    useQuestionAnswerStore.setState({ picks: {}, typed: { 0: 'Neither, use Redis' } })

    render(<QuestionDock message={ask()} text="Neither, use Redis" onSubmit={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /Postgres/ })).not.toBeChecked()
    // And says nothing about it: the hint narrated the box you are typing in.
    expect(screen.queryByText(/Pick one, or just type/)).not.toBeInTheDocument()
  })

  it('warns that a tick beats whatever is still sitting in the composer', () => {
    useQuestionAnswerStore.setState({ picks: { 0: ['Postgres'] }, typed: {} })

    render(<QuestionDock message={ask()} text="Neither, use Redis" onSubmit={vi.fn()} />)

    expect(screen.getByText(/Picked — your text is ignored/)).toBeInTheDocument()
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
  // The bug this replaced: one `mode` flag for the whole set, so a keystroke on
  // question 3 cleared the answers to 1 and 2 and the reply carried only the
  // sentence just typed.
  it('typing clears the ticks on that question and no others', () => {
    useQuestionAnswerStore.setState({ picks: { 0: ['a'], 1: ['b'] }, typed: {} })

    useQuestionAnswerStore.getState().setTyped(1, 'something else')

    expect(useQuestionAnswerStore.getState()).toMatchObject({
      picks: { 0: ['a'] },
      typed: { 1: 'something else' }
    })
  })

  it('ticking clears what was typed on that question and no others', () => {
    useQuestionAnswerStore.setState({ picks: {}, typed: { 0: 'mine', 1: 'also mine' } })

    useQuestionAnswerStore.getState().pick(1, 'b', false)

    expect(useQuestionAnswerStore.getState()).toMatchObject({
      picks: { 1: ['b'] },
      typed: { 0: 'mine' }
    })
  })

  it('emptying the box drops that question back to unanswered', () => {
    useQuestionAnswerStore.setState({ picks: {}, typed: { 0: 'mine' } })

    useQuestionAnswerStore.getState().setTyped(0, '   ')

    expect(useQuestionAnswerStore.getState().typed).toEqual({})
  })

  it('is a no-op once there is nothing to record or clear, so keystrokes do not re-render', () => {
    useQuestionAnswerStore.setState({ picks: {}, typed: {} })
    const before = useQuestionAnswerStore.getState()

    useQuestionAnswerStore.getState().setTyped(0, '')

    expect(useQuestionAnswerStore.getState().picks).toBe(before.picks)
    expect(useQuestionAnswerStore.getState().typed).toBe(before.typed)
  })

  // Typing is recorded as it happens, so Skip has to undo it — otherwise the
  // words still in the box travel with the reply for a question you skipped.
  it('skip drops that question\u2019s answer, typed or ticked', () => {
    useQuestionAnswerStore.setState({
      picks: { 0: ['a'], 1: ['b'] },
      typed: { 0: 'mine', 2: 'also mine' }
    })

    useQuestionAnswerStore.getState().skip(0)

    expect(useQuestionAnswerStore.getState()).toMatchObject({
      picks: { 1: ['b'] },
      typed: { 2: 'also mine' }
    })
  })

  describe('advance', () => {
    it('records this question and lands on the next with an empty box', () => {
      useQuestionAnswerStore.setState({ picks: {}, typed: {}, page: 0 })

      const next = useQuestionAnswerStore.getState().advance(0, 'Neither, use Redis')

      expect(next).toBe('')
      expect(useQuestionAnswerStore.getState()).toMatchObject({
        page: 1,
        typed: { 0: 'Neither, use Redis' }
      })
    })

    it('brings back what the next question was already answered with', () => {
      useQuestionAnswerStore.setState({ picks: {}, typed: { 1: 'earlier words' }, page: 0 })

      expect(useQuestionAnswerStore.getState().advance(0, 'mine')).toBe('earlier words')
    })

    it('keeps the ticks on other questions', () => {
      useQuestionAnswerStore.setState({ picks: { 1: ['Fly'] }, typed: {}, page: 0 })

      useQuestionAnswerStore.getState().advance(0, 'Neither, use Redis')

      expect(useQuestionAnswerStore.getState().picks).toEqual({ 1: ['Fly'] })
    })
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
