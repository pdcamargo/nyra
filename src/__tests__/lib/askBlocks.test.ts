import { describe, it, expect } from 'vitest'
import { extractAskBlocks, parseAskBlock, composeAnswer } from '../../renderer/src/lib/askBlocks'

const block = (body: string): string => '```nyra-ask\n' + body + '\n```'

describe('parseAskBlock', () => {
  it('reads a question and its options', () => {
    const [q] = parseAskBlock('## Which auth method?\n- OAuth\n- API key')
    expect(q.question).toBe('Which auth method?')
    expect(q.options).toEqual([{ label: 'OAuth' }, { label: 'API key' }])
    expect(q.multiSelect).toBeUndefined()
  })

  it('splits a description off any of the dashes a model reaches for', () => {
    const [q] = parseAskBlock(
      '## Pick\n- Em — long dash\n- En – short dash\n- Ascii - plain\n- Double -- wide'
    )
    expect(q.options).toEqual([
      { label: 'Em', description: 'long dash' },
      { label: 'En', description: 'short dash' },
      { label: 'Ascii', description: 'plain' },
      { label: 'Double', description: 'wide' }
    ])
  })

  it('keeps a hyphenated label intact', () => {
    const [q] = parseAskBlock('## Pick\n- multi-select mode')
    expect(q.options[0]).toEqual({ label: 'multi-select mode' })
  })

  it('picks up the multi marker and the header chip, and strips both', () => {
    const [q] = parseAskBlock('## [Auth] Which methods? (multi)\n- OAuth\n- API key')
    expect(q).toMatchObject({ question: 'Which methods?', header: 'Auth', multiSelect: true })
  })

  it('handles several questions, any heading level, and * bullets', () => {
    const qs = parseAskBlock('# First\n* a\n* b\n\n### Second\n- c')
    expect(qs.map((q) => q.question)).toEqual(['First', 'Second'])
    expect(qs[1].options).toEqual([{ label: 'c' }])
  })

  it('drops a heading with no options — that is prose, not a question', () => {
    expect(parseAskBlock('## Just a thought\n\nSome text.')).toEqual([])
  })

  it('ignores bullets before any heading', () => {
    expect(parseAskBlock('- orphan\n## Real?\n- yes')).toHaveLength(1)
  })
})

describe('extractAskBlocks', () => {
  it('lifts the block out of the reply and leaves the prose', () => {
    const reply = `Two ways to go here.\n\n${block('## Which?\n- A\n- B')}\n\nSay the word.`
    const { text, questions } = extractAskBlocks(reply)
    expect(text).toBe('Two ways to go here.\n\nSay the word.')
    expect(questions).toHaveLength(1)
    expect(text).not.toContain('nyra-ask')
  })

  it('leaves a reply with no block completely alone', () => {
    const reply = 'Here is a plan.\n\n```ts\nconst x = 1\n```'
    expect(extractAskBlocks(reply)).toEqual({ text: reply, questions: [] })
  })

  it('merges several blocks', () => {
    const reply = `${block('## One\n- a')}\ntext\n${block('## Two\n- b')}`
    const { questions } = extractAskBlocks(reply)
    expect(questions.map((q) => q.question)).toEqual(['One', 'Two'])
  })

  it('still removes a block it could not parse — a stray fence helps nobody', () => {
    const { text, questions } = extractAskBlocks(`Before\n\n${block('nothing useful')}\n\nAfter`)
    expect(questions).toEqual([])
    expect(text).toBe('Before\n\nAfter')
  })

  it('survives an unclosed fence at the end of a truncated reply', () => {
    const { text, questions } = extractAskBlocks('Prose\n\n```nyra-ask\n## Which?\n- A\n- B')
    expect(questions).toHaveLength(1)
    expect(text).toBe('Prose')
  })

  it('does not touch a fence that merely mentions the name', () => {
    const reply = '```\nnyra-ask is the convention\n```'
    expect(extractAskBlocks(reply).questions).toEqual([])
  })
})

describe('composeAnswer', () => {
  const one = [{ question: 'Which store?', options: [{ label: 'Postgres' }] }]
  const two = [
    { question: 'Which store?', options: [{ label: 'Postgres' }] },
    { question: 'Which host?', options: [{ label: 'Fly' }] }
  ]

  it('sends a single question back as the bare choice', () => {
    expect(composeAnswer(one, { 0: ['Postgres'] })).toBe('Postgres')
  })

  it('puts the question in front once there is more than one', () => {
    // "Postgres\nFly" on its own is not something the reader can make sense of.
    expect(composeAnswer(two, { 0: ['Postgres'], 1: ['Fly'] })).toBe(
      'Which store? Postgres\nWhich host? Fly'
    )
  })

  it('leaves out a question nothing was ticked on rather than sending it blank', () => {
    expect(composeAnswer(two, { 1: ['Fly'] })).toBe('Which host? Fly')
  })

  it('is empty when nothing was answered at all, so the caller can do nothing', () => {
    expect(composeAnswer(two, {})).toBe('')
  })
})
