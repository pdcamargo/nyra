import { describe, expect, it } from 'vitest'
import {
  autoTint,
  chatWait,
  describeRollup,
  formatElapsed,
  isEmptyRollup,
  projectInitial,
  projectRollup,
  shortToolName,
  type WaitContext
} from '@renderer/lib/sidebarStatus'
import { PROJECT_TINTS } from '@renderer/lib/project-appearance'
import type { PullRequest } from '@renderer/lib/pullRequests'

const none: WaitContext = { planPending: new Set(), permissions: {} }

const pr = (n: number, state?: PullRequest['state']): PullRequest => ({
  url: `https://github.com/o/r/pull/${n}`,
  owner: 'o',
  repo: 'r',
  number: n,
  state,
  createdAt: 0
})

describe('chatWait', () => {
  it('is null for a chat waiting on nothing', () => {
    expect(chatWait({ id: 'a' }, none)).toBeNull()
  })

  it('names the tool a permission prompt is for', () => {
    expect(chatWait({ id: 'a' }, { ...none, permissions: { a: 'Bash' } })).toEqual({
      kind: 'permission',
      label: 'Allow Bash'
    })
  })

  it('puts a permission prompt ahead of a plan and a question', () => {
    const ctx: WaitContext = { planPending: new Set(['a']), permissions: { a: 'Edit' } }
    expect(chatWait({ id: 'a', needsAnswer: true }, ctx)?.kind).toBe('permission')
  })

  it('puts a plan ahead of a question', () => {
    const ctx: WaitContext = { planPending: new Set(['a']), permissions: {} }
    expect(chatWait({ id: 'a', needsAnswer: true }, ctx)).toEqual({ kind: 'plan', label: 'Plan' })
  })

  it('reports an unanswered question', () => {
    expect(chatWait({ id: 'a', needsAnswer: true }, none)).toEqual({ kind: 'question', label: 'Question' })
  })
})

describe('shortToolName', () => {
  it('keeps a built-in tool as it is', () => {
    expect(shortToolName('Bash')).toBe('Bash')
  })

  it('drops the server from an MCP tool', () => {
    expect(shortToolName('mcp__nyra-browser__browser_click')).toBe('browser_click')
  })
})

describe('projectRollup', () => {
  it('counts busy and waiting chats', () => {
    const r = projectRollup([{ id: 'a' }, { id: 'b', needsAnswer: true }, { id: 'c' }], {
      ...none,
      busy: { a: true, c: true }
    })
    expect(r).toEqual({ busy: 2, waiting: 1, open: 0, merged: 0 })
  })

  it('counts drafts as open, and leaves closed out', () => {
    const r = projectRollup(
      [{ id: 'a', pullRequests: [pr(1, 'open'), pr(2, 'draft'), pr(3, 'merged'), pr(4, 'closed'), pr(5)] }],
      { ...none, busy: {} }
    )
    expect(r).toMatchObject({ open: 2, merged: 1 })
  })

  it('counts a PR two chats share once', () => {
    const r = projectRollup(
      [
        { id: 'a', pullRequests: [pr(1, 'merged')] },
        { id: 'b', pullRequests: [pr(1, 'merged')] }
      ],
      { ...none, busy: {} }
    )
    expect(r.merged).toBe(1)
  })

  it('describes itself, leaving zeros out', () => {
    expect(describeRollup({ busy: 1, waiting: 0, open: 1, merged: 5 })).toBe('1 running · 1 open PR · 5 merged')
    expect(isEmptyRollup({ busy: 0, waiting: 0, open: 0, merged: 0 })).toBe(true)
  })
})

describe('autoTint', () => {
  it('is one of the preset tints, and the same every time', () => {
    const t = autoTint('project-123')
    expect(PROJECT_TINTS).toContain(t)
    expect(autoTint('project-123')).toBe(t)
  })

  it('spreads projects across more than one tint', () => {
    const tints = new Set(Array.from({ length: 20 }, (_, i) => autoTint(`p${i}`)))
    expect(tints.size).toBeGreaterThan(2)
  })
})

describe('projectInitial', () => {
  it('takes the first letter or digit, upper-cased', () => {
    expect(projectInitial('nyra')).toBe('N')
    expect(projectInitial('.dotfiles')).toBe('D')
    expect(projectInitial('3d-viewer')).toBe('3')
    expect(projectInitial('ético')).toBe('É')
  })

  it('falls back for a name with neither', () => {
    expect(projectInitial('--')).toBe('?')
  })
})

describe('formatElapsed', () => {
  it('reads in seconds, then minutes and seconds, then minutes, then hours', () => {
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(72_000)).toBe('1m 12s')
    expect(formatElapsed(14 * 60_000 + 5_000)).toBe('14m')
    expect(formatElapsed(65 * 60_000)).toBe('1h 05m')
  })

  it('never goes negative on a clock that stepped back', () => {
    expect(formatElapsed(-500)).toBe('0s')
  })
})
