import { beforeEach, describe, expect, it } from 'vitest'
import { btwQuestion, sideContext, sidePrompt } from '../../renderer/src/lib/sideQuestions'
import { useSideQuestionsStore, type SideThread } from '../../renderer/src/store/sideQuestions'

const thread = (partial: Partial<SideThread> = {}): SideThread => ({
  id: 't1',
  turns: [{ id: 'q1', question: 'Where does the counter live?', answer: 'In queue.mjs.', status: 'done' }],
  ...partial
})

describe('btwQuestion', () => {
  it('reads the question off a /btw line, in any case', () => {
    expect(btwQuestion('/btw is it per chat?')).toBe('is it per chat?')
    expect(btwQuestion('  /BTW  multi\nline  ')).toBe('multi\nline')
  })

  it('treats a bare /btw as an empty question', () => {
    expect(btwQuestion('/btw')).toBe('')
  })

  it('leaves anything else alone', () => {
    expect(btwQuestion('/btwx no')).toBeNull()
    expect(btwQuestion('by the way /btw')).toBeNull()
  })
})

describe('sideContext', () => {
  it('labels one answer by its question, and says the main thread never saw it', () => {
    const c = sideContext([
      thread({ quote: { messageId: 'm', source: 'assistant', start: 0, end: 5, quote: 'by sequence\nnumber' } })
    ])
    expect(c.kind).toBe('side-question')
    expect(c.label).toBe('Side answer: Where does the counter live?')
    expect(c.body).toContain("which you can't see")
    expect(c.body).toContain('About your reply:\n> by sequence\n> number')
    expect(c.body).toContain('Q: Where does the counter live?\nA: In queue.mjs.')
  })

  it('counts several', () => {
    expect(sideContext([thread(), thread({ id: 't2' })]).label).toBe('2 side answers')
  })
})

describe('sidePrompt', () => {
  it('frames the question as read-only and quotes what it is about', () => {
    const p = sidePrompt('Why?', { messageId: 'm', source: 'user', start: 0, end: 1, quote: 'x' })
    expect(p).toMatch(/Do not change any files/)
    expect(p).toContain('About this part of my earlier message:\n> x\n\nWhy?')
  })
})

describe('side questions store', () => {
  beforeEach(() => useSideQuestionsStore.setState({ open: {}, kept: {} }))

  it('keeps only answered turns, and hands them over once', () => {
    const s = useSideQuestionsStore.getState()
    s.start('chat', { id: 't1', turns: [] })
    s.addTurn('chat', { id: 'a', question: 'one', answer: 'yes', status: 'done' })
    s.addTurn('chat', { id: 'b', question: 'two', answer: '', status: 'error', error: 'x' })
    expect(s.keep('chat')?.id).toBe('t1')
    expect(useSideQuestionsStore.getState().open.chat).toBeUndefined()
    expect(s.take('chat').map((t) => t.turns.map((x) => x.id))).toEqual([['a']])
    expect(s.take('chat')).toEqual([])
  })

  it('will not keep a thread with no answer', () => {
    const s = useSideQuestionsStore.getState()
    s.start('chat', { id: 't1', turns: [] })
    expect(s.keep('chat')).toBeUndefined()
    expect(useSideQuestionsStore.getState().open.chat?.id).toBe('t1')
  })

  it('replacing a thread hands back the old one, so its process can be ended', () => {
    const s = useSideQuestionsStore.getState()
    s.start('chat', { id: 't1', turns: [] })
    expect(s.start('chat', { id: 't2', turns: [] })?.id).toBe('t1')
  })

  it('streams into a turn by thread id, whichever chat holds it', () => {
    const s = useSideQuestionsStore.getState()
    s.start('chat', { id: 't1', turns: [] })
    s.addTurn('chat', { id: 'a', question: 'q', answer: '', status: 'streaming' })
    s.appendAnswer('t1', 'a', 'Hel')
    s.appendAnswer('t1', 'a', 'lo')
    s.patchTurn('t1', 'a', { status: 'done' })
    expect(useSideQuestionsStore.getState().open.chat?.turns[0]).toMatchObject({ answer: 'Hello', status: 'done' })
  })
})
