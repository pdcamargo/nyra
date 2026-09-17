import { describe, it, expect } from 'vitest'
import { extractTaskBlocks, parseTaskBlock } from '../../renderer/src/lib/taskBlocks'

const block = (body: string): string => '```nyra-tasks\n' + body + '\n```'

describe('parseTaskBlock', () => {
  it('reads the three states', () => {
    const tasks = parseTaskBlock('- [x] Done it\n- [>] Doing it\n- [ ] Not yet')
    expect(tasks.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(tasks.map((t) => t.subject)).toEqual(['Done it', 'Doing it', 'Not yet'])
  })

  it('tolerates the other marks a model reaches for', () => {
    expect(parseTaskBlock('- [X] a\n* [~] b\n- [*] c').map((t) => t.status)).toEqual([
      'completed',
      'in_progress',
      'in_progress'
    ])
  })

  it('skips prose and empty items', () => {
    expect(parseTaskBlock('Here is the plan:\n- [ ]   \n- [ ] Real one')).toHaveLength(1)
  })

  it('gives each item a distinct id in list order', () => {
    const ids = parseTaskBlock('- [ ] a\n- [ ] b\n- [ ] c').map((t) => t.taskId)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('extractTaskBlocks', () => {
  it('lifts the block out and leaves the prose', () => {
    const { text, tasks } = extractTaskBlocks(`Starting now.\n\n${block('- [>] First step')}`)
    expect(text).toBe('Starting now.')
    expect(tasks).toHaveLength(1)
  })

  it('returns null when there is no block, so the list is left alone', () => {
    const { text, tasks } = extractTaskBlocks('Just talking.')
    expect(tasks).toBeNull()
    expect(text).toBe('Just talking.')
  })

  it('distinguishes an emptied list from no list at all', () => {
    expect(extractTaskBlocks(block('all done, nothing left')).tasks).toEqual([])
  })

  it('leaves an ordinary fenced block untouched', () => {
    const reply = '```ts\nconst todo = [1]\n```'
    expect(extractTaskBlocks(reply)).toEqual({ text: reply, tasks: null })
  })
})
