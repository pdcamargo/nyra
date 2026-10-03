import { describe, expect, it } from 'vitest'
import {
  answerText,
  formatAnswers,
  isAnswered,
  progressOf,
  questionsOf,
  sectionsOf,
  sentLabel,
  type Questionnaire
} from '../../renderer/src/lib/questionnaire'
import { recordOf } from '../../renderer/src/components/MessageContextLines'

const q = (answers: Questionnaire['answers'] = {}): Questionnaire => ({
  id: 'q_1',
  title: 'Closeup design system',
  project: '/p',
  chatId: 'c',
  createdAt: '',
  updatedAt: '',
  sent: [],
  answers,
  rounds: [
    {
      at: '',
      questions: [
        {
          id: 'where',
          section: 'Where it lives',
          question: 'Where should it live?',
          kind: 'single',
          options: [{ label: 'In the repo', suggested: true }, { label: 'In Nyra' }]
        },
        { id: 'accent', section: 'Color', question: 'Which colour should lead?', kind: 'color', suggested: '#6E56CF' },
        { id: 'radius', section: 'Shape', question: 'How round?', kind: 'scale', scale: { min: 0, max: 16, unit: 'px' } },
        { id: 'never', section: 'Voice', question: 'Never look like?', kind: 'text' },
        { id: 'motion', section: 'Motion', question: 'How should things move?', kind: 'single', options: [{ label: 'Snappy' }] },
        // A question with an odd kind and string options still shows.
        { id: 'odd', question: 'Pick some', kind: 'weird' as never, options: ['A', 'B'] as never }
      ]
    }
  ]
})

describe('a questionnaire, read', () => {
  it('reads every question leniently and groups them by section in asked order', () => {
    const all = questionsOf(q())
    expect(all.map((x) => x.id)).toEqual(['where', 'accent', 'radius', 'never', 'motion', 'odd'])
    expect(all.find((x) => x.id === 'odd')).toMatchObject({ kind: 'text', options: [{ label: 'A' }, { label: 'B' }] })
    expect(sectionsOf(all).map((s) => s.name)).toEqual(['Where it lives', 'Color', 'Shape', 'Voice', 'Motion', 'Questions'])
  })

  it('counts only answers that say something', () => {
    expect(isAnswered({ kind: 'picked', labels: [] })).toBe(false)
    expect(isAnswered({ kind: 'typed', text: '   ' })).toBe(false)
    expect(isAnswered({ kind: 'decide' })).toBe(true)
    const p = progressOf(q({ where: { kind: 'picked', labels: ['In the repo'] }, never: { kind: 'typed', text: '' } }))
    expect(p).toEqual({ answered: 1, total: 6 })
  })
})

describe('what Claude receives', () => {
  const answered = q({
    where: { kind: 'picked', labels: ['In the repo'] },
    accent: { kind: 'value', value: '#6E56CF' },
    radius: { kind: 'value', value: 8 },
    never: { kind: 'typed', text: 'A generic SaaS dashboard.' },
    motion: { kind: 'decide' }
  })

  it('names each answer, the suggestion it took, and what is left to Claude', () => {
    const text = formatAnswers(answered)
    expect(text.split('\n')[0]).toBe('<questionnaire id="q_1" title="Closeup design system" answered="5" of="6">')
    expect(text).toContain('Where should it live? → In the repo (your suggestion)')
    expect(text).toContain('Which colour should lead? → #6E56CF')
    expect(text).toContain('How round? → 8 px (on 0–16)')
    expect(text).toContain('Never look like? → A generic SaaS dashboard.')
    expect(text).toContain('Decide for me → How should things move?')
    expect(text).toContain('Not answered (yours to decide) → Pick some')
    expect(text.endsWith('</questionnaire>')).toBe(true)
  })

  it('the bubble line says how many, about what', () => {
    expect(sentLabel(answered)).toBe('Answered 5 of 6 questions about Closeup')
  })

  it('the bubble record reads back what was sent', () => {
    const rows = recordOf(formatAnswers(answered))
    expect(rows[0]).toEqual({ question: 'Where should it live?', answer: 'In the repo (your suggestion)', kind: 'picked' })
    expect(rows.at(-1)).toMatchObject({ kind: 'decide', answer: 'Left to Claude' })
  })

  it('a long answer and added files survive the trip, and the record names files by name', () => {
    const withFiles: Questionnaire = {
      ...q({
        never: { kind: 'typed', text: 'A generic SaaS dashboard.\nOr a bank.' },
        refs: {
          kind: 'files',
          files: [
            { name: 'logo.svg', path: '/home/me/.nyra/designs/questionnaires/q_1/logo.svg', size: 6 },
            { name: 'site.png', path: '/home/me/.nyra/designs/questionnaires/q_1/site.png', size: 9 }
          ]
        }
      }),
      rounds: [
        ...q().rounds,
        { at: '', questions: [{ id: 'refs', question: 'Logo?', kind: 'files', placeholder: 'Screenshots', handBack: false }] }
      ]
    }
    expect(questionsOf(withFiles).at(-1)).toMatchObject({ kind: 'files', placeholder: 'Screenshots', handBack: false })
    const text = formatAnswers(withFiles)
    expect(text).toContain('Never look like? → A generic SaaS dashboard.\n  Or a bank.')
    expect(text).toContain('Logo? → /home/me/.nyra/designs/questionnaires/q_1/logo.svg · /home/me/.nyra/designs/questionnaires/q_1/site.png')
    expect(text).toContain('Read them.')
    const rows = recordOf(text)
    expect(rows.find((r) => r.question === 'Never look like?')).toEqual({
      question: 'Never look like?',
      answer: 'A generic SaaS dashboard.\nOr a bank.',
      kind: 'typed'
    })
    expect(rows.find((r) => r.question === 'Logo?')?.answer).toBe('logo.svg, site.png')
    expect(isAnswered({ kind: 'files', files: [] })).toBe(false)
  })

  it('the record says what you chose, not what Claude was told to do with it', () => {
    const explored = recordOf(formatAnswers(q({ never: { kind: 'explore' } })))
    expect(explored.find((r) => r.question === 'Never look like?')).toEqual({
      question: 'Never look like?',
      answer: 'Claude drafts options',
      kind: 'decide'
    })
  })

  it('explore asks Claude to draft before asking again', () => {
    const [first] = questionsOf(answered)
    expect(answerText(first, { kind: 'explore' })).toMatch(/draft a few directions/)
  })
})
