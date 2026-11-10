import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  branchFromTitle,
  defaultBranchName,
  managedCount,
  nameWorktreeAfterTitle,
  prunableSessions
} from '@renderer/lib/worktrees'
import { useSessionsStore, type Session, type WorktreeInfo } from '@renderer/store/sessions'
import { useSettingsStore } from '@renderer/store/settings'
import { DEFAULT_SETTINGS } from '../../shared/types'

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: 'feat',
  branch: 'feat',
  path: '/wt/feat',
  ...over
})

const session = (over: Partial<Session> & { id: string }): Session => ({
  provider: 'claude',
  providerSessionIds: {},
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
        // Each chat's own: one two chats share is in use, and never offered.
        session({ id: 'new', createdAt: 200, worktree: wt({ path: '/wt/new' }) }),
        session({ id: 'old', createdAt: 100, worktree: wt({ path: '/wt/old' }) })
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

describe('branchFromTitle', () => {
  it('slugs the title under nyra/', () => {
    expect(branchFromTitle('Fix login redirect')).toBe('nyra/fix-login-redirect')
    expect(branchFromTitle('Café: "décor" & v2.1')).toBe('nyra/cafe-decor-v2-1')
  })

  it('cuts a long title at a word', () => {
    const name = branchFromTitle('Make the worktree the default for new chats in every git project')!
    expect(name).toBe('nyra/make-the-worktree-the-default-for-new')
    expect(name.length).toBeLessThanOrEqual('nyra/'.length + 40)
  })

  it('gives up on a title with nothing a branch can carry', () => {
    expect(branchFromTitle('🚀 — ?')).toBeNull()
  })
})

describe('nameWorktreeAfterTitle', () => {
  const generated = 'nyra/2026-11-10-ab12'

  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState(DEFAULT_SETTINGS)
  })

  const seed = (over: Partial<WorktreeInfo> = {}, title = 'Fix login redirect'): void => {
    const worktree = wt({ name: generated, branch: generated, autoNamed: true, ...over })
    useSessionsStore.setState({
      sessions: [
        session({ id: 'a', title, worktree }),
        // A fork working in the same worktree.
        session({ id: 'b', title: 'fork', worktree })
      ]
    })
  }
  const worktreeOf = (id: string): WorktreeInfo | null | undefined =>
    useSessionsStore.getState().sessions.find((s) => s.id === id)?.worktree

  it('renames a generated branch, for every chat in the worktree', async () => {
    seed()
    const rename = vi.spyOn(window.api.git, 'branchRename')
    await nameWorktreeAfterTitle('a')
    expect(rename).toHaveBeenCalledWith('/wt/feat', generated, 'nyra/fix-login-redirect')
    for (const id of ['a', 'b']) {
      expect(worktreeOf(id)).toMatchObject({ branch: 'nyra/fix-login-redirect', path: '/wt/feat', autoNamed: false })
    }
  })

  it('falls back to the generated suffix when the name is taken', async () => {
    seed()
    vi.spyOn(window.api.git, 'branchRename')
      .mockResolvedValueOnce({ success: false, error: 'already exists' })
      .mockResolvedValueOnce({ success: true })
    await nameWorktreeAfterTitle('a')
    expect(worktreeOf('a')?.branch).toBe('nyra/fix-login-redirect-ab12')
  })

  it('tries once, keeping the branch when git refuses', async () => {
    seed()
    const rename = vi.spyOn(window.api.git, 'branchRename').mockResolvedValue({ success: false })
    await nameWorktreeAfterTitle('a')
    await nameWorktreeAfterTitle('a')
    expect(rename).toHaveBeenCalledTimes(2)
    expect(worktreeOf('a')).toMatchObject({ branch: generated, autoNamed: false })
  })

  it('leaves a name the user chose, a permanent worktree, and the setting off alone', async () => {
    const rename = vi.spyOn(window.api.git, 'branchRename')
    seed({ autoNamed: false })
    await nameWorktreeAfterTitle('a')
    seed({ permanent: true })
    await nameWorktreeAfterTitle('a')
    seed()
    useSettingsStore.setState({ worktreeNameFromTitle: false })
    await nameWorktreeAfterTitle('a')
    expect(rename).not.toHaveBeenCalled()
  })
})
