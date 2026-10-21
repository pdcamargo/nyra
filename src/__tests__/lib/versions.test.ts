import { describe, expect, it } from 'vitest'
import { turnRegens, versionViews } from '../../renderer/src/lib/versions'
import type { Message, VersionSet } from '../../renderer/src/store/sessions'

const user = (id: string, extra: Record<string, unknown> = { resumeAt: null }): Message =>
  ({ id, role: 'user', text: id, ...extra }) as Message
const reply = (id: string): Message => ({ id, role: 'assistant', text: id })
const edit = (id: string, path: string): Message =>
  ({ id, role: 'tool_call', tool_id: id, tool_name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }) as Message
const empty = { messages: [], anchor: null }

describe('versionViews', () => {
  it('puts a regenerated turn’s switcher under its final reply', () => {
    const messages = [user('u1', { resumeAt: null, replyVersions: 'k' }), reply('a1'), reply('a2'), user('u2'), reply('a3')]
    const versions: Record<string, VersionSet> = {
      k: { kind: 'reply', tails: [{ messages: [reply('x')], anchor: null }, empty], current: 1, ran: 1 }
    }
    const views = versionViews(messages, versions, new Set(['a2', 'a3']))
    expect([...views.keys()]).toEqual(['a2'])
    expect(views.get('a2')).toEqual({ key: 'k', index: 1, total: 2, ranElsewhere: null })
  })

  it('puts an edited prompt’s switcher under the prompt', () => {
    const messages = [user('u1', { resumeAt: null, promptVersions: 'k' }), reply('a1')]
    const versions: Record<string, VersionSet> = {
      k: { kind: 'prompt', tails: [{ messages: [user('u0'), reply('a0')], anchor: null }, empty], current: 1, ran: 1 }
    }
    expect(versionViews(messages, versions, new Set(['a1'])).get('u1')?.total).toBe(2)
  })

  it('says which version is on disk only when one of them changed files', () => {
    const messages = [user('u1', { resumeAt: null, replyVersions: 'k' }), reply('a1')]
    const quiet: Record<string, VersionSet> = {
      k: { kind: 'reply', tails: [empty, { messages: [reply('x')], anchor: null }], current: 0, ran: 1 }
    }
    expect(versionViews(messages, quiet, new Set(['a1'])).get('a1')?.ranElsewhere).toBeNull()

    const edited: Record<string, VersionSet> = {
      k: { kind: 'reply', tails: [empty, { messages: [edit('e', '/r/a.ts'), reply('x')], anchor: null }], current: 0, ran: 1 }
    }
    expect(versionViews(messages, edited, new Set(['a1'])).get('a1')?.ranElsewhere).toBe(1)
  })
})

describe('turnRegens', () => {
  it('offers each turn’s prompt, with the files that turn changed', () => {
    const messages = [user('u1'), edit('e1', '/r/a.ts'), reply('a1'), user('u2'), reply('a2')]
    const regens = turnRegens(messages, new Set(['a1', 'a2']))
    expect(regens.get('a1')).toEqual({ promptId: 'u1', files: ['/r/a.ts'] })
    expect(regens.get('a2')).toEqual({ promptId: 'u2', files: [] })
  })

  it('skips a turn opened by a message steered into a running one', () => {
    const messages = [user('u1'), reply('a1'), user('s1', {}), reply('a2')]
    expect(turnRegens(messages, new Set(['a1', 'a2'])).has('a2')).toBe(false)
  })
})
