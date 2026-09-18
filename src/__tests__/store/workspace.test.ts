import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMPTY_WORKSPACE,
  activeBrowserTabId,
  browserKey,
  fileKey,
  reconcileTabs,
  sanitizeWorkspaces,
  tabKey,
  useWorkspaceStore,
  wantsBrowser,
  workspaceFor,
  type ChatWorkspace,
  type WorkspaceTab
} from '@renderer/store/workspace'

const SID = 'chat-1'

/** A strip, written the way it reads: 'b:t1' is browser tab t1, 'f:x' a file tab. */
function strip(spec: string[], activeKey: string | null = null): ChatWorkspace {
  const tabs: WorkspaceTab[] = spec.map((s) => {
    const [kind, id] = s.split(':')
    return kind === 'b' ? { kind: 'browser', tabId: id } : { kind: 'file', id, path: `/repo/${id}.ts` }
  })
  return { ...EMPTY_WORKSPACE, tabs, activeKey }
}

const keys = (ws: ChatWorkspace): string[] => ws.tabs.map(tabKey)

describe('reconcileTabs', () => {
  it('appends an agent-opened tab at the end without moving the selection', () => {
    const before = strip(['b:t1', 'f:x'], fileKey('x'))
    const after = reconcileTabs(before, ['t1', 't2'])

    expect(keys(after)).toEqual([browserKey('t1'), fileKey('x'), browserKey('t2')])
    expect(after.activeKey).toBe(fileKey('x'))
  })

  it('keeps a file tab in place when a browser tab before it closes', () => {
    const before = strip(['b:t1', 'f:x', 'b:t2'], fileKey('x'))
    const after = reconcileTabs(before, ['t2'])

    expect(keys(after)).toEqual([fileKey('x'), browserKey('t2')])
    expect(after.activeKey).toBe(fileKey('x'))
  })

  // The eviction sequence: the sidecar drops the context, then the agent opens
  // something new. Neither step may touch what the user was reading.
  it('keeps a file tab selected across an eviction and the tab that follows it', () => {
    const evicted = reconcileTabs(strip(['b:t1', 'f:x'], fileKey('x')), [])
    expect(keys(evicted)).toEqual([fileKey('x')])
    expect(evicted.activeKey).toBe(fileKey('x'))

    const reopened = reconcileTabs(evicted, ['t9'])
    expect(keys(reopened)).toEqual([fileKey('x'), browserKey('t9')])
    expect(reopened.activeKey).toBe(fileKey('x'))
  })

  it('drops every browser entry on an empty list and keeps every file entry', () => {
    const after = reconcileTabs(strip(['b:t1', 'f:x', 'b:t2', 'f:y'], browserKey('t1')), [])
    expect(keys(after)).toEqual([fileKey('x'), fileKey('y')])
  })

  // Falling back to tabs[0] would throw you to the front of the strip whenever
  // the agent closed the tab you were on.
  it('selects the neighbour, not the first tab, when the active tab disappears', () => {
    const after = reconcileTabs(strip(['b:t1', 'b:t2', 'b:t3'], browserKey('t2')), ['t1', 't3'])
    expect(after.activeKey).toBe(browserKey('t3'))
  })

  it('selects the new last tab when the active one was at the end', () => {
    const after = reconcileTabs(strip(['b:t1', 'b:t2'], browserKey('t2')), ['t1'])
    expect(after.activeKey).toBe(browserKey('t1'))
  })

  it('selects something when nothing was selected and the strip fills', () => {
    expect(reconcileTabs(EMPTY_WORKSPACE, ['t1']).activeKey).toBe(browserKey('t1'))
  })

  it('clears the selection when the strip empties', () => {
    const after = reconcileTabs(strip(['b:t1'], browserKey('t1')), [])
    expect(after.tabs).toEqual([])
    expect(after.activeKey).toBeNull()
  })

  it('honours a parked selection once the tab arrives, and clears it', () => {
    const before = { ...strip(['f:x'], fileKey('x')), pendingSelectKey: browserKey('t1') }
    const after = reconcileTabs(before, ['t1'])

    expect(after.activeKey).toBe(browserKey('t1'))
    expect(after.pendingSelectKey).toBeNull()
  })

  it('leaves a parked selection parked while its tab is still missing', () => {
    const before = { ...strip(['f:x'], fileKey('x')), pendingSelectKey: browserKey('t1') }
    const after = reconcileTabs(before, [])

    expect(after.activeKey).toBe(fileKey('x'))
    expect(after.pendingSelectKey).toBe(browserKey('t1'))
  })

  // The sidecar re-broadcasts several times per navigation. A new object each
  // time would re-render the strip for news it already had.
  it('returns the identical object when nothing changed', () => {
    const before = strip(['b:t1', 'f:x'], fileKey('x'))
    expect(reconcileTabs(before, ['t1'])).toBe(before)
  })

  it('does not reorder survivors to match the sidecar', () => {
    const before = strip(['b:t2', 'b:t1'], browserKey('t2'))
    expect(keys(reconcileTabs(before, ['t1', 't2']))).toEqual([browserKey('t2'), browserKey('t1')])
  })
})

describe('selectors', () => {
  it('wantsBrowser is false for a files-only strip', () => {
    expect(wantsBrowser(strip(['f:x', 'f:y']))).toBe(false)
    expect(wantsBrowser(EMPTY_WORKSPACE)).toBe(false)
  })

  it('wantsBrowser is true once a browser tab exists or has been asked for', () => {
    expect(wantsBrowser(strip(['f:x', 'b:t1']))).toBe(true)
    expect(wantsBrowser({ ...EMPTY_WORKSPACE, pendingSelectKey: browserKey('t1') })).toBe(true)
    expect(wantsBrowser({ ...EMPTY_WORKSPACE, pendingSelectKey: fileKey('x') })).toBe(false)
  })

  it('activeBrowserTabId prefers the active tab, then the first browser tab', () => {
    expect(activeBrowserTabId(strip(['f:x', 'b:t1'], browserKey('t1')))).toBe('t1')
    expect(activeBrowserTabId(strip(['b:t1', 'b:t2'], fileKey('x')))).toBe('t1')
    expect(activeBrowserTabId(strip(['f:x'], fileKey('x')))).toBeNull()
  })
})

describe('the store', () => {
  beforeEach(() => useWorkspaceStore.setState({ bySession: {} }))

  const ws = (): ChatWorkspace => workspaceFor(useWorkspaceStore.getState(), SID)

  it('opens a file tab, selects it, and renames it when a file is picked', () => {
    const key = useWorkspaceStore.getState().openFileTab(SID)
    expect(ws().activeKey).toBe(key)
    expect((ws().tabs[0] as { path: string | null }).path).toBeNull()

    const id = (ws().tabs[0] as { id: string }).id
    useWorkspaceStore.getState().setFilePath(SID, id, '/repo/a.ts')
    expect((ws().tabs[0] as { path: string | null }).path).toBe('/repo/a.ts')
  })

  it('closes a file tab locally and picks the neighbour', () => {
    const store = useWorkspaceStore.getState()
    store.openFileTab(SID, '/a')
    const second = store.openFileTab(SID, '/b')
    store.openFileTab(SID, '/c')

    store.selectTab(SID, second)
    store.closeTab(SID, second)

    expect(ws().tabs).toHaveLength(2)
    expect((ws().tabs.find((t) => tabKey(t) === ws().activeKey) as { path: string }).path).toBe('/c')
  })

  it('parks a selection for a tab that does not exist yet', () => {
    useWorkspaceStore.getState().selectTab(SID, browserKey('t1'))
    expect(ws().activeKey).toBeNull()
    expect(ws().pendingSelectKey).toBe(browserKey('t1'))

    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    expect(ws().activeKey).toBe(browserKey('t1'))
  })

  it('forgets a chat and prunes the ones that are gone', () => {
    useWorkspaceStore.getState().openFileTab(SID, '/a')
    useWorkspaceStore.getState().openFileTab('chat-2', '/b')

    useWorkspaceStore.getState().forget(SID)
    expect(SID in useWorkspaceStore.getState().bySession).toBe(false)

    useWorkspaceStore.getState().prune([])
    expect(useWorkspaceStore.getState().bySession).toEqual({})
  })

  it('toggles a tree directory and remembers the width', () => {
    const store = useWorkspaceStore.getState()
    store.toggleTreeDir(SID, 'src')
    store.toggleTreeDir(SID, 'src/lib')
    expect(ws().treeExpanded).toEqual(['src', 'src/lib'])

    store.toggleTreeDir(SID, 'src')
    expect(ws().treeExpanded).toEqual(['src/lib'])

    store.setTreeWidth(SID, 240)
    expect(ws().treeWidth).toBe(240)
  })
})

describe('sanitizeWorkspaces', () => {
  it('drops browser entries and re-resolves an activeKey that named one', () => {
    const out = sanitizeWorkspaces({
      [SID]: {
        tabs: [
          { kind: 'browser', tabId: 't1' },
          { kind: 'file', id: 'x', path: '/repo/a.ts' }
        ],
        activeKey: browserKey('t1')
      }
    })
    expect(out[SID].tabs).toEqual([{ kind: 'file', id: 'x', path: '/repo/a.ts' }])
    expect(out[SID].activeKey).toBe(fileKey('x'))
  })

  it('clamps a width that would render a zero-width pane', () => {
    const out = sanitizeWorkspaces({
      [SID]: { tabs: [{ kind: 'file', id: 'x', path: null }], treeWidth: Number.NaN }
    })
    expect(out[SID].treeWidth).toBeNull()
  })

  it('never restores an in-flight selection', () => {
    const out = sanitizeWorkspaces({
      [SID]: { tabs: [{ kind: 'file', id: 'x', path: null }], pendingSelectKey: browserKey('t1') }
    })
    expect(out[SID].pendingSelectKey).toBeNull()
  })

  it('forgets a chat with nothing worth restoring', () => {
    expect(sanitizeWorkspaces({ [SID]: { tabs: [], treeExpanded: [] } })).toEqual({})
  })

  it('keeps a chat that only customised its tree', () => {
    const out = sanitizeWorkspaces({ [SID]: { tabs: [], treeOpen: false } })
    expect(out[SID].treeOpen).toBe(false)
  })

  it('survives a garbage blob', () => {
    expect(sanitizeWorkspaces(undefined)).toEqual({})
    expect(sanitizeWorkspaces('nope')).toEqual({})
    expect(sanitizeWorkspaces({ [SID]: { tabs: 'nope' } })).toEqual({})
    expect(sanitizeWorkspaces({ [SID]: { tabs: [{ kind: 'file' }, null, 7] } })).toEqual({})
  })
})
