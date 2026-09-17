import { describe, expect, it } from 'vitest'
import { defaultBranchName, managedCount, prunableSessions } from '@renderer/lib/worktrees'
import type { Session, WorktreeInfo } from '@renderer/store/sessions'

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: 'feat',
  branch: 'feat',
  path: '/wt/feat',
  ...over
})

const session = (over: Partial<Session> & { id: string }): Session => ({
  claudeSessionId: null,
  title: 'chat',
  cwd: '/wt/feat',
  createdAt: 0,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

describe('defaultBranchName', () => {
  it('is dated, namespaced and filesystem-safe', () => {
    expect(defaultBranchName(new Date(2026, 8, 16))).toMatch(/^nyra\/2026-09-16-[a-z0-9]{4}$/)
  })

  it('does not collide on repeated calls in the same day', () => {
    const at = new Date(2026, 8, 16)
    const names = new Set(Array.from({ length: 50 }, () => defaultBranchName(at)))
    expect(names.size).toBeGreaterThan(40)
  })
})

describe('managedCount', () => {
  it('counts managed worktrees, ignoring permanent ones and local chats', () => {
    expect(
      managedCount([
        session({ id: 'a', worktree: wt() }),
        session({ id: 'b', worktree: wt({ permanent: true }) }),
        session({ id: 'c', worktree: null })
      ])
    ).toBe(1)
  })
})

describe('prunableSessions', () => {
  it('offers the oldest managed worktree first', () => {
    const list = prunableSessions(
      [
        session({ id: 'new', createdAt: 200, worktree: wt() }),
        session({ id: 'old', createdAt: 100, worktree: wt() })
      ],
      {}
    )
    expect(list.map((s) => s.id)).toEqual(['old', 'new'])
  })

  it('never offers a pinned chat', () => {
    // Codex protects worktrees a pinned chat is tied to — which is exactly what
    // renaming Favorites to Pinned buys us.
    expect(prunableSessions([session({ id: 'a', favorite: true, worktree: wt() })], {})).toEqual([])
  })

  it('never offers a chat that is still working', () => {
    expect(prunableSessions([session({ id: 'a', worktree: wt() })], { a: true })).toEqual([])
  })

  it('never offers a permanent worktree', () => {
    expect(prunableSessions([session({ id: 'a', worktree: wt({ permanent: true }) })], {})).toEqual([])
  })

  it('ignores chats with no worktree at all', () => {
    expect(prunableSessions([session({ id: 'a', worktree: null })], {})).toEqual([])
  })
})
