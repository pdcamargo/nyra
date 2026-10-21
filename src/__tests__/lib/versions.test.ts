import { describe, expect, it } from 'vitest'
import {
  chatEditedPaths,
  lastWritten,
  overwrittenEdits,
  shellCommands,
  turnHashes,
  turnRegens,
  versionCheckpoint,
  versionViews
} from '../../renderer/src/lib/versions'
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
    expect(views.get('a2')).toEqual({ key: 'k', index: 1, total: 2, ranElsewhere: null, restorable: false })
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
    expect(regens.get('a1')).toEqual({ promptId: 'u1', files: ['/r/a.ts'], commands: [] })
    expect(regens.get('a2')).toEqual({ promptId: 'u2', files: [], commands: [] })
  })

  it('skips a turn opened by a message steered into a running one', () => {
    const messages = [user('u1'), reply('a1'), user('s1', {}), reply('a2')]
    expect(turnRegens(messages, new Set(['a1', 'a2'])).has('a2')).toBe(false)
  })
})

const bash = (id: string, command: string): Message =>
  ({ id, role: 'tool_call', tool_id: id, tool_name: 'Bash', input: { command } }) as Message

describe('file restore', () => {
  it('offers the turn’s checkpoint and the shell commands it ran', () => {
    const messages = [user('u1', { resumeAt: null, checkpoint: 'c1' }), bash('b1', 'npm run fmt'), reply('a1')]
    expect(turnRegens(messages, new Set(['a1'])).get('a1')).toEqual({
      promptId: 'u1',
      files: [],
      checkpoint: 'c1',
      commands: ['npm run fmt']
    })
  })

  it('finds where each version’s own run began', () => {
    const reply: VersionSet = {
      kind: 'reply',
      tails: [{ messages: [], anchor: null, run: { checkpoint: 'c1' } }, empty],
      current: 1,
      ran: 1
    }
    expect(versionCheckpoint(reply, 0)).toBe('c1')
    expect(versionCheckpoint(reply, 1)).toBeUndefined()

    const prompt: VersionSet = {
      kind: 'prompt',
      tails: [{ messages: [user('u0', { checkpoint: 'c0' })], anchor: null }, empty],
      current: 1,
      ran: 1
    }
    expect(versionCheckpoint(prompt, 0)).toBe('c0')
  })

  it('offers a version’s files back only with a copy of them and a checkpoint to rewind to', () => {
    const messages = [user('u1', { resumeAt: null, replyVersions: 'k' }), edit('e1', '/r/a.ts'), reply('a1')]
    const set = (files?: string, checkpoint?: string): Record<string, VersionSet> => ({
      k: {
        kind: 'reply',
        tails: [
          { messages: [], anchor: null, ...(files ? { files } : {}) },
          { messages: [edit('e2', '/r/b.ts'), reply('x')], anchor: null, ...(checkpoint ? { run: { checkpoint } } : {}) }
        ],
        current: 0,
        ran: 1
      }
    })
    const restorable = (v: Record<string, VersionSet>): boolean | undefined =>
      versionViews(messages, v, new Set(['a1'])).get('a1')?.restorable
    expect(restorable(set('copy', 'c2'))).toBe(true)
    expect(restorable(set(undefined, 'c2'))).toBe(false)
    expect(restorable(set('copy'))).toBe(false)
  })

  it('copies every file the chat edited, put away or not', () => {
    const messages = [user('u1'), edit('e1', '/r/a.ts')]
    const versions: Record<string, VersionSet> = {
      k: { kind: 'reply', tails: [{ messages: [edit('e2', '/r/b.ts'), edit('e3', '/r/a.ts')], anchor: null }, empty], current: 1, ran: 1 }
    }
    expect(chatEditedPaths(messages, versions)).toEqual(['/r/a.ts', '/r/b.ts'])
  })

  it('skips a shell command that was refused', () => {
    const denied = { ...(bash('b2', 'rm -rf /') as object), denied: true } as Message
    expect(shellCommands([bash('b1', ' ls '), denied])).toEqual(['ls'])
  })

  it('names the overwritten files that held something Claude did not leave', () => {
    const messages = [
      user('u1', { fileHashes: { '/r/a.ts': 'h1', '/r/b.ts': 'h1' } }),
      user('u2', { fileHashes: { '/r/a.ts': 'h2' } })
    ]
    const expected = lastWritten(turnHashes(messages))
    expect(expected.get('/r/a.ts')).toBe('h2')
    const before = { '/r/a.ts': 'h2', '/r/b.ts': 'hand', '/r/c.ts': 'x' }
    // a.ts is as Claude left it; b.ts is not; c.ts was never Claude's to judge.
    expect(overwrittenEdits(['/r/a.ts', '/r/b.ts', '/r/c.ts'], before, expected)).toEqual(['/r/b.ts'])
  })
})
