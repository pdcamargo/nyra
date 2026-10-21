import { describe, expect, it } from 'vitest'
import { buildTimeline, fileName } from '../../renderer/src/lib/promptTimeline'
import type { Message } from '../../renderer/src/store/sessions'

const T0 = 1_700_000_000_000

const user = (id: string, text: string, timestamp = T0): Message => ({ id, role: 'user', text, timestamp })
const reply = (id: string, text: string, timestamp?: number): Message => ({ id, role: 'assistant', text, timestamp })
const tool = (id: string, tool_name: string, input: Record<string, unknown>, extra: Partial<Message> = {}): Message =>
  ({ id, role: 'tool_call', tool_id: id, tool_name, input, ...extra }) as Message

describe('buildTimeline', () => {
  it('makes one entry per user message, numbered from 1, on its first non-blank line', () => {
    const t = buildTimeline([user('u1', '\n  Fix the queue\nand more'), reply('a1', 'ok'), user('u2', 'Then test it')])
    expect(t.map((p) => [p.id, p.n, p.text])).toEqual([
      ['u1', 1, 'Fix the queue'],
      ['u2', 2, 'Then test it']
    ])
  })

  it('ignores anything before the first prompt', () => {
    expect(buildTimeline([reply('a0', 'hello'), user('u1', 'hi')]).map((p) => p.id)).toEqual(['u1'])
  })

  it('sums edit tool calls per file, biggest first, and skips denied or failed ones', () => {
    const t = buildTimeline([
      user('u1', 'go'),
      tool('t1', 'Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'x\ny' }),
      tool('t2', 'Edit', { file_path: '/r/a.ts', old_string: 'p\nq', new_string: 'r' }),
      tool('t3', 'Write', { file_path: '/r/b.ts', content: '1\n2\n3\n4\n5\n' }),
      tool('t4', 'Edit', { file_path: '/r/c.ts', old_string: 'a', new_string: 'b' }, { denied: true }),
      tool('t5', 'Edit', { file_path: '/r/d.ts', old_string: 'a', new_string: 'b' }, { isError: true }),
      tool('t6', 'Read', { file_path: '/r/e.ts' })
    ])
    expect(t[0].files).toEqual([
      { path: '/r/a.ts', insertions: 3, deletions: 3 },
      { path: '/r/b.ts', insertions: 5, deletions: 0 }
    ])
    expect(t[0].base).toBeUndefined()
  })

  it('counts a Write over an existing file as replacing it', () => {
    const t = buildTimeline([
      user('u1', 'go'),
      tool('t1', 'Write', { file_path: '/r/a.ts', content: 'new' }, { originalContent: 'old\nold' })
    ])
    expect(t[0].files).toEqual([{ path: '/r/a.ts', insertions: 1, deletions: 2 }])
  })

  it('prefers the turn’s latest nyra-changes block, with its base, over tool inputs', () => {
    const t = buildTimeline([
      user('u1', 'go'),
      tool('t1', 'Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }),
      { id: 'a1', role: 'assistant', text: '', changes: { base: 'aaaaaaa', files: [{ path: 'a.ts', insertions: 1, deletions: 1 }] } },
      { id: 'a2', role: 'assistant', text: '', changes: { base: 'bbbbbbb', files: [{ path: 'src/a.ts', insertions: 9, deletions: 2 }] } }
    ])
    expect(t[0].files).toEqual([{ path: 'src/a.ts', insertions: 9, deletions: 2 }])
    expect(t[0].base).toBe('bbbbbbb')
  })

  it('measures a turn from its prompt to its last timestamped message', () => {
    const t = buildTimeline([user('u1', 'go', T0), reply('a1', 'x', T0 + 4_000), reply('a2', 'y'), user('u2', 'next', T0 + 9_000)])
    expect(t[0].durationMs).toBe(4_000)
    expect(t[1].durationMs).toBeUndefined()
  })

  it('names an attachment-only prompt', () => {
    expect(buildTimeline([user('u1', '   ')])[0].text).toBe('Attachment')
  })
})

describe('fileName', () => {
  it('takes the last segment of either separator', () => {
    expect(fileName('C:\\r\\src\\a.ts')).toBe('a.ts')
    expect(fileName('src/b.ts')).toBe('b.ts')
  })
})
