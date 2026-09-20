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

const plan: ToolCallMessage = {
  id: 'm2',
  role: 'tool_call',
  tool_id: 'p1',
  tool_name: 'ExitPlanMode',
  input: { plan: '## Do it', path: '/p.md' }
}

const intent = (o: Partial<Parameters<typeof composerIntent>[0]>) =>
  composerIntent({ text: '', question: null, plan: null, mode: 'picked', picks: {}, ...o })

describe('composerIntent', () => {
  it('sends a plain message when nothing is waiting', () => {
    expect(intent({ text: 'hello' })).toEqual({ kind: 'message' })
  })

  describe('with a question live', () => {
    it('takes what you typed when typing was the last thing you did', () => {
      expect(
        intent({ text: '  Neither, use Redis  ', question: question(), mode: 'typed' })
      ).toEqual({ kind: 'answer', toolId: 'q1', answer: 'Neither, use Redis' })
    })

    it('takes the ticks and ignores the text when ticking was last', () => {
      // The text is left in the box and dimmed rather than deleted, so it is
      // still here — and must not reach Claude.
      expect(
        intent({
          text: 'Neither, use Redis',
          question: question(),
          mode: 'picked',
          picks: { 0: ['Postgres'] }
        })
      ).toEqual({ kind: 'answer', toolId: 'q1', answer: 'Postgres' })
    })

    it('joins several ticks on a multi-select', () => {
      expect(
        intent({ question: question(true), mode: 'picked', picks: { 0: ['Postgres', 'SQLite'] } })
      ).toEqual({ kind: 'answer', toolId: 'q1', answer: 'Postgres, SQLite' })
    })

    it('does nothing when nothing has been ticked or typed', () => {
      expect(intent({ question: question() })).toEqual({ kind: 'none' })
    })

    it('does nothing when typing was last but the box is now empty', () => {
      expect(intent({ text: '   ', question: question(), mode: 'typed' })).toEqual({ kind: 'none' })
    })

    it('outranks a plan waiting at the same time', () => {
      expect(
        intent({ text: 'Postgres', question: question(), plan, mode: 'typed' })
      ).toEqual({ kind: 'answer', toolId: 'q1', answer: 'Postgres' })
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
