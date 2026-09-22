import { describe, expect, it } from 'vitest'
import { buildRecap, formatAway, RECAP_FILE_LIMIT } from '../../renderer/src/lib/recap'
import type { Message, Session } from '../../renderer/src/store/sessions'

const T0 = 1_700_000_000_000

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    claudeSessionId: null,
    title: 'Test',
    cwd: '/tmp',
    createdAt: T0,
    messages: [],
    tasks: [],
    agents: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ...partial
  }
}

function assistant(id: string, timestamp: number, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', text: 'ok', timestamp, ...extra } as Message
}

describe('buildRecap', () => {
  it('is null without an away window', () => {
    expect(buildRecap(session(), T0)).toBeNull()
  })

  it('is null when the window has nothing worth reporting', () => {
    const s = session({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 2,
      messages: [assistant('a', T0 + 100)]
    })
    // Prose only: no tasks, no files, no PR, no error. The turn count alone is
    // not news, and a card that says nothing is worse than no card.
    expect(buildRecap(s, T0 + 1000)).toBeNull()
  })

  it('counts only the turns that ran after you looked away', () => {
    const s = session({
      away: { since: T0, turnsAtLeave: 3 },
      turns: 7,
      tasks: [{ taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }],
      messages: [assistant('a', T0 + 100)]
    })
    expect(buildRecap(s, T0)!.turns).toBe(4)
  })

  it('excludes messages from before the window', () => {
    const s = session({
      away: { since: T0 + 500, turnsAtLeave: 0 },
      turns: 1,
      tasks: [{ taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }],
      messages: [assistant('old', T0), assistant('new', T0 + 600)]
    })
    expect(buildRecap(s, T0 + 1000)!.firstMessageId).toBe('new')
  })

  it('sums a file touched by several turns into one row', () => {
    const s = session({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 2,
      messages: [
        assistant('a', T0 + 1, {
          changes: { base: 'abc1234', files: [{ path: 'a.ts', insertions: 10, deletions: 2 }] }
        }),
        assistant('b', T0 + 2, {
          changes: {
            base: 'abc1234',
            files: [
              { path: 'a.ts', insertions: 5, deletions: 1 },
              { path: 'b.ts', insertions: 1, deletions: 0 }
            ]
          }
        })
      ]
    })
    const recap = buildRecap(s, T0 + 10)!
    expect(recap.files).toEqual([
      { path: 'a.ts', insertions: 15, deletions: 3 },
      { path: 'b.ts', insertions: 1, deletions: 0 }
    ])
  })

  it('orders files by how much moved, so the limit keeps the biggest', () => {
    const files = Array.from({ length: RECAP_FILE_LIMIT + 2 }, (_, i) => ({
      path: `f${i}.ts`,
      insertions: i,
      deletions: 0
    }))
    const s = session({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [assistant('a', T0 + 1, { changes: { base: 'abc1234', files } })]
    })
    const recap = buildRecap(s, T0 + 10)!
    expect(recap.files[0].path).toBe(`f${RECAP_FILE_LIMIT + 1}.ts`)
    expect(recap.files).toHaveLength(RECAP_FILE_LIMIT + 2)
  })

  it('reports a PR opened in the window but not one from before it', () => {
    const s = session({
      away: { since: T0 + 500, turnsAtLeave: 0 },
      turns: 1,
      messages: [assistant('a', T0 + 600)],
      pullRequests: [
        { url: 'u1', owner: 'o', repo: 'r', number: 1, createdAt: T0 },
        { url: 'u2', owner: 'o', repo: 'r', number: 2, createdAt: T0 + 600, title: 'New' }
      ]
    })
    const recap = buildRecap(s, T0 + 1000)!
    expect(recap.stats).toEqual([{ kind: 'pr', number: 2, title: 'New', url: 'u2' }])
  })

  it('reports the last error, first line only', () => {
    const s = session({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [
        { id: 'e1', role: 'error', text: 'first failure\nstack', timestamp: T0 + 1 } as Message,
        { id: 'e2', role: 'error', text: 'npm test — 3 failures\ndetail', timestamp: T0 + 2 } as Message
      ]
    })
    const recap = buildRecap(s, T0 + 10)!
    expect(recap.stats).toEqual([{ kind: 'error', text: 'npm test — 3 failures' }])
  })

  it('says how many tasks are done, including partly', () => {
    const s = session({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [assistant('a', T0 + 1)],
      tasks: [
        { taskId: '1', subject: 'a', description: '', status: 'completed', createdByToolId: 't' },
        { taskId: '2', subject: 'b', description: '', status: 'pending', createdByToolId: 't' }
      ]
    })
    expect(buildRecap(s, T0 + 10)!.stats[0]).toEqual({ kind: 'tasks', done: 1, total: 2 })
  })

  it('never reports a negative elapsed', () => {
    const s = session({
      away: { since: T0 + 5000, turnsAtLeave: 0 },
      turns: 1,
      messages: [assistant('a', T0 + 6000)],
      tasks: [{ taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }]
    })
    expect(buildRecap(s, T0)!.awayMs).toBe(0)
  })
})

describe('formatAway', () => {
  it('reads coarsely', () => {
    expect(formatAway(48_000)).toBe('48s')
    expect(formatAway(12 * 60_000)).toBe('12 min')
    expect(formatAway(64 * 60_000)).toBe('1 hr 4 min')
    expect(formatAway(120 * 60_000)).toBe('2 hr')
  })

  it('never says 0s', () => {
    expect(formatAway(0)).toBe('1s')
  })
})
