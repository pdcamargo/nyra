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

  it('opens a file tab, selects it, and starts it on no file at all', () => {
    const key = useWorkspaceStore.getState().openFileTab(SID)
    expect(ws().activeKey).toBe(key)
    expect((ws().tabs[0] as { path: string | null }).path).toBeNull()
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

  describe('moveTab', () => {
    const setup = (): string[] => {
      const store = useWorkspaceStore.getState()
      const a = store.openFileTab(SID, '/a')
      const b = store.openFileTab(SID, '/b')
      const c = store.openFileTab(SID, '/c')
      return [a, b, c]
    }
    const order = (): string[] => ws().tabs.map(tabKey)

    it('moves a tab rightward, in front of the one named', () => {
      const [a, b, c] = setup()
      useWorkspaceStore.getState().moveTab(SID, a, c)
      // Before c, so it lands between b and c — not after c. This is the
      // direction an insert-before reorder gets off by one.
      expect(order()).toEqual([b, a, c])
    })

    it('moves a tab leftward', () => {
      const [a, b, c] = setup()
      useWorkspaceStore.getState().moveTab(SID, c, a)
      expect(order()).toEqual([c, a, b])
    })

    // Unreachable without it: every drop would insert *before* something, so the
    // last position could never be chosen.
    it('moves a tab to the end when told nothing to go before', () => {
      const [a, b, c] = setup()
      useWorkspaceStore.getState().moveTab(SID, a, null)
      expect(order()).toEqual([b, c, a])
    })

    it('keeps the selection on the tab that moved', () => {
      const [a, , c] = setup()
      useWorkspaceStore.getState().selectTab(SID, a)
      useWorkspaceStore.getState().moveTab(SID, a, c)
      expect(ws().activeKey).toBe(a)
    })

    it('is a no-op when the tab would not move', () => {
      const [a, b] = setup()
      const before = ws()

      useWorkspaceStore.getState().moveTab(SID, a, a)
      useWorkspaceStore.getState().moveTab(SID, a, b)
      useWorkspaceStore.getState().moveTab(SID, 'file:gone', b)
      useWorkspaceStore.getState().moveTab(SID, a, 'file:gone')

      expect(ws()).toBe(before)
    })

    it('leaves the last tab alone when sent to the end', () => {
      const [, , c] = setup()
      const before = ws()
      useWorkspaceStore.getState().moveTab(SID, c, null)
      expect(ws()).toBe(before)
    })

    it('reorders browser tabs too, and the sidecar does not undo it', () => {
      useWorkspaceStore.getState().reconcile(SID, ['t1', 't2'])
      useWorkspaceStore.getState().moveTab(SID, browserKey('t2'), browserKey('t1'))
      expect(order()).toEqual([browserKey('t2'), browserKey('t1')])

      // The sidecar re-broadcasts in its own order on every navigation.
      useWorkspaceStore.getState().reconcile(SID, ['t1', 't2'])
      expect(order()).toEqual([browserKey('t2'), browserKey('t1')])
    })
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

describe('the preview slot', () => {
  beforeEach(() => useWorkspaceStore.setState({ bySession: {} }))

  const ws = (): ChatWorkspace => workspaceFor(useWorkspaceStore.getState(), SID)
  const pathOf = (key: string | null): string | null => {
    const tab = ws().tabs.find((t) => tabKey(t) === key)
    return tab?.kind === 'file' ? tab.path : null
  }

  // Clicking five files in a tree is five looks at them, not a request for five
  // tabs. One row is retargeted until something asks for it to stay.
  it('retargets one row instead of stacking a tab per click', () => {
    const store = useWorkspaceStore.getState()
    const first = store.openFilePreviewTab(SID, '/repo/a.ts')
    const second = store.openFilePreviewTab(SID, '/repo/b.ts')

    expect(second).toBe(first)
    expect(ws().tabs).toHaveLength(1)
    expect(pathOf(first)).toBe('/repo/b.ts')
    expect(ws().activeKey).toBe(first)
  })

  it('leaves the preview row alone when a file is pinned', () => {
    const store = useWorkspaceStore.getState()
    const preview = store.openFilePreviewTab(SID, '/repo/a.ts')
    const pinned = store.openFileTab(SID, '/repo/b.ts')

    expect(ws().tabs).toHaveLength(2)
    expect(pathOf(preview)).toBe('/repo/a.ts')
    expect(pathOf(pinned)).toBe('/repo/b.ts')
    expect(ws().activeKey).toBe(pinned)
  })

  it('keeps the row open once it is pinned', () => {
    const store = useWorkspaceStore.getState()
    const key = store.openFilePreviewTab(SID, '/repo/a.ts')
    const id = (ws().tabs[0] as { id: string }).id
    store.pinFileTab(SID, id)

    store.openFilePreviewTab(SID, '/repo/b.ts')

    expect(pathOf(key)).toBe('/repo/a.ts')
    expect(ws().tabs).toHaveLength(2)
  })

  it('pins a row that is already showing the file rather than making a second', () => {
    const store = useWorkspaceStore.getState()
    store.openFilePreviewTab(SID, '/repo/a.ts')
    const id = (ws().tabs[0] as { id: string }).id
    store.pinFileTab(SID, id)

    // Pinning twice, or pinning a file that is already open, is one row.
    store.pinFileTab(SID, id)
    expect(ws().tabs).toHaveLength(1)
  })
})

describe('the provisional browser row', () => {
  beforeEach(() => useWorkspaceStore.setState({ bySession: {} }))

  const ws = (): ChatWorkspace => workspaceFor(useWorkspaceStore.getState(), SID)

  // The whole feature: the row is on screen before the browser is, so a cold
  // start does not look like a button that did nothing.
  it('goes up immediately, and is selected', () => {
    const key = useWorkspaceStore.getState().openProvisionalBrowserTab(SID)

    expect(ws().activeKey).toBe(key)
    expect(ws().tabs).toHaveLength(1)
    expect(ws().tabs[0]).toMatchObject({ kind: 'browser', provisional: true })
    expect(wantsBrowser(ws())).toBe(true)
  })

  it('is asked for twice, and drawn once', () => {
    const first = useWorkspaceStore.getState().openProvisionalBrowserTab(SID)
    const second = useWorkspaceStore.getState().openProvisionalBrowserTab(SID)

    expect(second).toBe(first)
    expect(ws().tabs).toHaveLength(1)
  })

  it('is replaced where it stands, with the selection following the row', () => {
    const store = useWorkspaceStore.getState()
    store.openFileTab(SID, '/repo/a.ts')
    const provisional = store.openProvisionalBrowserTab(SID)
    const id = provisional.slice('browser:'.length)
    // Three rows, with the browser row in the middle: the real tab has to land
    // in that slot rather than at the end.
    store.openFileTab(SID, '/repo/b.ts')
    store.selectTab(SID, provisional)

    const key = store.adoptBrowserTab(SID, id, 't9')

    expect(key).toBe(browserKey('t9'))
    expect(ws().tabs.map(tabKey)).toEqual([
      fileKey((ws().tabs[0] as { id: string }).id),
      browserKey('t9'),
      fileKey((ws().tabs[2] as { id: string }).id)
    ])
    expect(ws().tabs[1]).toMatchObject({ kind: 'browser', tabId: 't9' })
    expect(ws().activeKey).toBe(browserKey('t9'))
  })

  it('does not steal the selection back when the page arrives', () => {
    const store = useWorkspaceStore.getState()
    const provisional = store.openProvisionalBrowserTab(SID)
    const id = provisional.slice('browser:'.length)
    const file = store.openFileTab(SID, '/repo/a.ts')
    store.selectTab(SID, file)

    store.adoptBrowserTab(SID, id, 't9')

    expect(ws().activeKey).toBe(file)
  })

  // The broadcast and the reply that created the tab race each other. Whichever
  // lands second, there is one row and not two.
  it('clears itself when the real row got there first', () => {
    const store = useWorkspaceStore.getState()
    const provisional = store.openProvisionalBrowserTab(SID)
    const id = provisional.slice('browser:'.length)
    store.selectTab(SID, provisional)
    store.reconcile(SID, ['t9'])

    const key = store.adoptBrowserTab(SID, id, 't9')

    expect(key).toBe(browserKey('t9'))
    expect(ws().tabs.map(tabKey)).toEqual([browserKey('t9')])
    expect(ws().activeKey).toBe(browserKey('t9'))
  })

  it('reports a missing placeholder, which is how a cancel is seen', () => {
    const store = useWorkspaceStore.getState()
    const provisional = store.openProvisionalBrowserTab(SID)
    store.closeTab(SID, provisional)

    expect(store.adoptBrowserTab(SID, provisional.slice('browser:'.length), 't9')).toBeNull()
    expect(ws().tabs).toEqual([])
  })

  // A row that left for any other reason is not a cancel: the page exists, so it
  // gets a row rather than being thrown away with the placeholder.
  it('gives the page a row when the placeholder went missing some other way', () => {
    const store = useWorkspaceStore.getState()
    const provisional = store.openProvisionalBrowserTab(SID)
    const id = provisional.slice('browser:'.length)
    useWorkspaceStore.setState({ bySession: {} })

    const key = store.adoptBrowserTab(SID, id, 't9')

    expect(key).toBe(browserKey('t9'))
    expect(ws().tabs.map(tabKey)).toEqual([browserKey('t9')])
    expect(ws().activeKey).toBe(browserKey('t9'))
  })

  // It outlives a broadcast that leaves it out — it is ours, not the sidecar's —
  // and it never becomes the page the miniature is drawn from.
  it('survives an empty broadcast but is not a tab to draw', () => {
    const key = useWorkspaceStore.getState().openProvisionalBrowserTab(SID)
    useWorkspaceStore.getState().reconcile(SID, [])

    expect(ws().tabs.map(tabKey)).toEqual([key])
    expect(activeBrowserTabId(ws())).toBeNull()
  })

  // A provisional row is a browser row on the way out, so the persisted blob
  // never carries a name for a tab that will not exist after a restart.
  it('is dropped on the way out, like every browser row', () => {
    const out = sanitizeWorkspaces({
      [SID]: { tabs: [{ kind: 'browser', tabId: 'pending-1', provisional: true }] }
    })
    expect(out[SID]).toBeUndefined()
  })
})

describe('sanitizeWorkspaces', () => {
  it('restores a preview row as a preview row', () => {
    const out = sanitizeWorkspaces({
      [SID]: { tabs: [{ kind: 'file', id: 'x', path: '/repo/a.ts', preview: true }] }
    })
    expect(out[SID].tabs).toEqual([{ kind: 'file', id: 'x', path: '/repo/a.ts', preview: true }])
  })

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
