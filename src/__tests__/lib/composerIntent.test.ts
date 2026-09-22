import { describe, expect, it } from 'vitest'
import { composerIntent } from '@renderer/lib/composerIntent'
import type { ToolCallMessage } from '@renderer/store/sessions'

const question = (multiSelect = false): ToolCallMessage => ({
  id: 'm1',
  role: 'tool_call',
  tool_id: 'q1',
  tool_name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which store?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        ...(multiSelect ? { multiSelect: true } : {})
      }
    ]
  }
})

/** Three questions, which is where the per-question rules actually bite. */
const threeQuestions: ToolCallMessage = {
  id: 'm3',
  role: 'tool_call',
  tool_id: 'q3',
  tool_name: 'AskUserQuestion',
  input: {
    questions: [
      { question: 'Which store?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Which host?', options: [{ label: 'Fly' }, { label: 'Render' }] },
      { question: 'Which CI?', options: [{ label: 'Actions' }, { label: 'Buildkite' }] }
    ]
  }
}

const plan: ToolCallMessage = {
  id: 'm2',
  role: 'tool_call',
  tool_id: 'p1',
  tool_name: 'ExitPlanMode',
  input: { plan: '## Do it', path: '/p.md' }
}

const intent = (o: Partial<Parameters<typeof composerIntent>[0]>) =>
  composerIntent({ text: '', question: null, plan: null, picks: {}, typed: {}, page: 0, ...o })

describe('composerIntent', () => {
  it('sends a plain message when nothing is waiting', () => {
    expect(intent({ text: 'hello' })).toEqual({ kind: 'message' })
  })

  describe('with a question live', () => {
    it('takes what you typed when typing was the last thing you did', () => {
      expect(intent({ text: '  Neither, use Redis  ', question: question() })).toEqual({
        kind: 'answer',
        toolId: 'q1',
        answer: 'Neither, use Redis'
      })
    })

    it('takes the ticks and ignores the text when ticking was last', () => {
      // The text is left in the box and dimmed rather than deleted, so it is
      // still here — and must not reach Claude.
      expect(
        intent({
          text: 'Neither, use Redis',
          question: question(),
          picks: { 0: ['Postgres'] }
        })
      ).toEqual({ kind: 'answer', toolId: 'q1', answer: 'Postgres' })
    })

    it('joins several ticks on a multi-select', () => {
      expect(
        intent({ question: question(true), picks: { 0: ['Postgres', 'SQLite'] } })
      ).toEqual({ kind: 'answer', toolId: 'q1', answer: 'Postgres, SQLite' })
    })

    it('does nothing when nothing has been ticked or typed', () => {
      expect(intent({ question: question() })).toEqual({ kind: 'none' })
    })

    it('does nothing when typing was last but the box is now empty', () => {
      expect(intent({ text: '   ', question: question() })).toEqual({ kind: 'none' })
    })

    it('outranks a plan waiting at the same time', () => {
      expect(intent({ text: 'Postgres', question: question(), plan })).toEqual({
        kind: 'answer',
        toolId: 'q1',
        answer: 'Postgres'
      })
    })
  })

  describe('with a set of questions', () => {
    // The bug: typing on question 1 and pressing Enter submitted the whole set
    // immediately, carrying only that sentence and discarding every other
    // answer. Enter on a question that is not the last one moves on instead.
    it('records your words on this question and moves to the next', () => {
      expect(
        intent({ text: 'Neither, use Redis', question: threeQuestions, page: 0 })
      ).toEqual({ kind: 'next-question', toolId: 'q3', page: 0 })
    })

    it('moves on from a ticked question too', () => {
      expect(intent({ question: threeQuestions, page: 1, picks: { 1: ['Fly'] } })).toEqual({
        kind: 'next-question',
        toolId: 'q3',
        page: 1
      })
    })

    it('does nothing on a question with no answer, so Enter is not a skip', () => {
      expect(intent({ question: threeQuestions, page: 0 })).toEqual({ kind: 'none' })
    })

    // The whole point: typed and ticked answers compose instead of replacing
    // each other.
    it('submits every answer from the last question, mixing typed and ticked', () => {
      expect(
        intent({
          text: 'Buildkite, self-hosted',
          question: threeQuestions,
          page: 2,
          picks: { 1: ['Fly'] },
          typed: { 0: 'Neither, use Redis' }
        })
      ).toEqual({
        kind: 'answer',
        toolId: 'q3',
        answer:
          'Which store? Neither, use Redis\n' +
          'Which host? Fly\n' +
          'Which CI? Buildkite, self-hosted'
      })
    })

    it('leaves out the questions nobody answered', () => {
      expect(
        intent({ question: threeQuestions, page: 2, picks: { 1: ['Fly'] } })
      ).toEqual({ kind: 'answer', toolId: 'q3', answer: 'Which host? Fly' })
    })

    // A tick clears that question's typed answer in the store, so reading the
    // live composer unconditionally would resurrect the overruled words.
    it('lets a tick on the current question beat text still in the box', () => {
      expect(
        intent({
          text: 'Neither, use Redis',
          question: threeQuestions,
          page: 2,
          picks: { 2: ['Actions'] }
        })
      ).toEqual({ kind: 'answer', toolId: 'q3', answer: 'Which CI? Actions' })
    })
  })

  describe('with a plan waiting', () => {
    it('reads anything typed as keeping planning, and carries it as the note', () => {
      expect(intent({ text: '  Phase 2 is wrong  ', plan })).toEqual({
        kind: 'keep-planning',
        toolId: 'p1',
        path: '/p.md',
        note: 'Phase 2 is wrong'
      })
    })

    it('leaves an empty composer alone, so Enter on nothing is not a rejection', () => {
      expect(intent({ text: '   ', plan })).toEqual({ kind: 'message' })
    })

    it('copes with a plan that arrived without a path', () => {
      const pathless = { ...plan, input: { plan: '## Do it' } }
      expect(intent({ text: 'no', plan: pathless })).toEqual({
        kind: 'keep-planning',
        toolId: 'p1',
        path: undefined,
        note: 'no'
      })
    })
  })
})
