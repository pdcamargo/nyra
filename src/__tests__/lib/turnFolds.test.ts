import { describe, expect, it } from 'vitest'
import { turnFolds } from '@renderer/lib/turnFolds'
import type { Message } from '@renderer/store/sessions'

const user = (id: string, timestamp?: number): Message => ({ id, role: 'user', text: id, timestamp })
const say = (id: string, timestamp?: number): Message => ({ id, role: 'assistant', text: id, timestamp })
const tool = (id: string, tool_name = 'Bash'): Message => ({
  id,
  role: 'tool_call',
  tool_id: id,
  tool_name,
  input: {},
  result: ''
})
const never = (): boolean => false

describe('turnFolds', () => {
  it('folds what came between the prompt and the closing reply, and times it', () => {
    const folds = turnFolds([user('u', 1000), tool('t1'), say('a1'), tool('t2'), say('end', 219_000)], false, never)
    expect([...folds.keys()]).toEqual(['t1', 'a1', 't2'])
    expect(folds.get('a1')).toEqual({ id: 'u', first: 't1', durationMs: 218_000 })
  })

  it('leaves the running turn alone, but not the turns before it', () => {
    const folds = turnFolds([user('u1'), tool('t1'), say('a1'), user('u2'), tool('t2'), say('a2')], true, never)
    expect([...folds.keys()]).toEqual(['t1'])
  })

  it('keeps what the caller says stays, and folds a turn of only that to nothing', () => {
    const stays = (m: Message): boolean => m.role === 'tool_call' && m.tool_name === 'AskUserQuestion'
    const folds = turnFolds(
      [user('u1'), tool('t1'), tool('q', 'AskUserQuestion'), tool('t2'), say('a1'), user('u2'), tool('q2', 'AskUserQuestion'), say('a2')],
      false,
      stays
    )
    expect([...folds.keys()]).toEqual(['t1', 't2'])
  })

  it('folds nothing in a turn with no reply, or one that is only its reply', () => {
    expect(turnFolds([user('u1'), tool('t1'), user('u2'), say('a2')], false, never).size).toBe(0)
  })

  it('leaves calls after the closing reply in view, and has no time without one on both ends', () => {
    const folds = turnFolds([user('u'), tool('t1'), say('end'), tool('after')], false, never)
    expect([...folds.keys()]).toEqual(['t1'])
    expect(folds.get('t1')?.durationMs).toBeUndefined()
  })
})
