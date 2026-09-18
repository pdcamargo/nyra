import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMPTY_WORKSPACE,
  sanitizeWorkspaces,
  reconcileTabs,
  tabKey,
  useWorkspaceStore,
  workspaceFor,
  type ChatWorkspace
} from '@renderer/store/workspace'
import {
  byChurn,
  EMPTY_CHANGES,
  scopeBase,
  scopeLabel,
  totals,
  useChangesStore
} from '@renderer/store/changes'
import type { ChangedFile } from '@renderer/lib/api-types'

const SID = 'chat-1'
const ws = (): ChatWorkspace => workspaceFor(useWorkspaceStore.getState(), SID)

const file = (path: string, insertions = 0, deletions = 0): ChangedFile => ({
  path,
  status: 'M',
  insertions,
  deletions,
  binary: false,
  untracked: false
})

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
  useChangesStore.setState({ bySession: {} })
})

describe('the changes tab in the strip', () => {
  it('opens one and selects it', () => {
    const key = useWorkspaceStore.getState().openChangesTab(SID)
    expect(ws().tabs).toEqual([{ kind: 'changes', id: expect.any(String) }])
    expect(ws().activeKey).toBe(key)
  })

  it('reuses the existing row rather than stacking a second one', () => {
    const first = useWorkspaceStore.getState().openChangesTab(SID)
    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    const second = useWorkspaceStore.getState().openChangesTab(SID)

    expect(second).toBe(first)
    expect(ws().tabs.filter((t) => t.kind === 'changes')).toHaveLength(1)
    expect(ws().activeKey).toBe(first)
  })

  it('gets its own key namespace, so it cannot collide with a file tab', () => {
    expect(tabKey({ kind: 'changes', id: 'x' })).toBe('changes:x')
    expect(tabKey({ kind: 'file', id: 'x', path: null })).toBe('file:x')
  })

  it('survives a sidecar reconcile that empties the browser half of the strip', () => {
    useWorkspaceStore.getState().openChangesTab(SID)
    const before = ws()
    const after = reconcileTabs(before, [])
    // The regression this guards: the survivor filter used to be `kind === 'file'`,
    // which would drop a changes row every time the browser reported its tabs.
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].kind).toBe('changes')
  })
})

describe('persistence', () => {
  it('restores a changes row — nothing behind it can be stale', () => {
    const restored = sanitizeWorkspaces({
      [SID]: { ...EMPTY_WORKSPACE, tabs: [{ kind: 'changes', id: 'c1' }], activeKey: 'changes:c1' }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'changes', id: 'c1' }])
    expect(restored[SID].activeKey).toBe('changes:c1')
  })

  it('still drops browser rows, whose Chromium is gone', () => {
    const restored = sanitizeWorkspaces({
      [SID]: {
        ...EMPTY_WORKSPACE,
        tabs: [{ kind: 'browser', tabId: 'b1' }, { kind: 'changes', id: 'c1' }]
      }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'changes', id: 'c1' }])
  })

  it('reads a corrupt row as absent rather than as a broken tab', () => {
    const restored = sanitizeWorkspaces({
      [SID]: { ...EMPTY_WORKSPACE, tabs: [{ kind: 'changes' }, null, 7] }
    })
    expect(restored[SID]?.tabs ?? []).toEqual([])
  })
})

describe('scope', () => {
  it('sends null for the working tree, so git compares against HEAD', () => {
    expect(scopeBase({ kind: 'worktree' })).toBeNull()
    expect(scopeBase({ kind: 'branch', base: 'main' })).toBe('main')
    expect(scopeBase({ kind: 'since', base: '50cb2a4' })).toBe('50cb2a4')
  })

  it('labels each case distinguishably', () => {
    expect(scopeLabel({ kind: 'worktree' })).toBe('Working tree')
    expect(scopeLabel({ kind: 'branch', base: 'main' })).toBe('vs main')
    expect(scopeLabel({ kind: 'since', base: '50cb2a4' })).toBe('since 50cb2a4')
  })
})

describe('file ordering', () => {
  it('puts the most-changed file first', () => {
    const files = [file('small.ts', 1), file('big.ts', 200, 12), file('mid.ts', 20)]
    expect(byChurn(files).map((f) => f.path)).toEqual(['big.ts', 'mid.ts', 'small.ts'])
  })

  it('totals both columns', () => {
    expect(totals([file('a', 2, 3), file('b', 4, 5)])).toEqual({ insertions: 6, deletions: 8 })
  })
})

describe('revealing a file', () => {
  it('bumps a nonce so picking the same file twice scrolls twice', () => {
    const store = useChangesStore.getState()
    store.revealFile(SID, 'src/a.ts')
    const first = useChangesStore.getState().bySession[SID].scrollTo

    store.revealFile(SID, 'src/a.ts')
    const second = useChangesStore.getState().bySession[SID].scrollTo

    expect(first?.path).toBe('src/a.ts')
    expect(second?.path).toBe('src/a.ts')
    // A bare path would compare equal here and the second pick would do nothing.
    expect(second?.nonce).toBeGreaterThan(first!.nonce)
  })
})

describe('whitespace', () => {
  it('drops read patches, since git computed them for the other question', () => {
    useChangesStore.setState({
      bySession: {
        [SID]: {
          ...EMPTY_CHANGES,
          files: [file('a.ts', 1)],
          byFile: {
            'a.ts': { patch: '@@ -1 +1 @@', loading: false, error: null, expanded: true }
          }
        }
      }
    })

    useChangesStore.getState().invalidatePatches(SID)

    const after = useChangesStore.getState().bySession[SID].byFile['a.ts']
    expect(after.patch).toBeNull()
    // What is open stays open — only the body is re-read.
    expect(after.expanded).toBe(true)
  })
})

describe('switching scope', () => {
  it('clears the files and patches, which described a different base', () => {
    useChangesStore.setState({
      bySession: {
        [SID]: {
          ...EMPTY_CHANGES,
          files: [file('a.ts', 1)],
          byFile: { 'a.ts': { patch: 'x', loading: false, error: null, expanded: true } }
        }
      }
    })

    useChangesStore.getState().setScope(SID, { kind: 'since', base: '50cb2a4' })

    const after = useChangesStore.getState().bySession[SID]
    expect(after.files).toEqual([])
    expect(after.byFile).toEqual({})
    expect(after.baseResolved).toBe(true)
  })
})
