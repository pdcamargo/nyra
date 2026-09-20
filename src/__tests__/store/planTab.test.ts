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

const SID = 'chat-1'
const ws = (): ChatWorkspace => workspaceFor(useWorkspaceStore.getState(), SID)

beforeEach(() => useWorkspaceStore.setState({ bySession: {} }))

describe('the plan tab in the strip', () => {
  it('opens one and selects it', () => {
    const key = useWorkspaceStore.getState().openPlanTab(SID, 't1')
    expect(ws().tabs).toEqual([{ kind: 'plan', id: expect.any(String), toolId: 't1' }])
    expect(ws().activeKey).toBe(key)
  })

  it('reuses the existing row rather than stacking a second one', () => {
    const first = useWorkspaceStore.getState().openPlanTab(SID, 't1')
    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    const second = useWorkspaceStore.getState().openPlanTab(SID, 't1')

    expect(second).toBe(first)
    expect(ws().tabs.filter((t) => t.kind === 'plan')).toHaveLength(1)
    expect(ws().activeKey).toBe(first)
  })

  it('retargets that row at the newer plan instead of opening another', () => {
    const first = useWorkspaceStore.getState().openPlanTab(SID, 't1')
    const second = useWorkspaceStore.getState().openPlanTab(SID, 't2')

    // Clicking a second plan card means "show me this one instead".
    expect(second).toBe(first)
    expect(ws().tabs).toEqual([{ kind: 'plan', id: expect.any(String), toolId: 't2' }])
  })

  it('gets its own key namespace, so it cannot collide with a file or changes tab', () => {
    expect(tabKey({ kind: 'plan', id: 'x', toolId: 't' })).toBe('plan:x')
    expect(tabKey({ kind: 'changes', id: 'x' })).toBe('changes:x')
    expect(tabKey({ kind: 'file', id: 'x', path: null })).toBe('file:x')
  })

  it('survives a sidecar reconcile that empties the browser half of the strip', () => {
    useWorkspaceStore.getState().openPlanTab(SID, 't1')
    const after = reconcileTabs(ws(), [])
    // Same regression the changes row guards against: a survivor filter that
    // names kinds explicitly drops every kind added after it was written.
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].kind).toBe('plan')
  })
})

describe('persistence', () => {
  it('restores a plan row — the plan behind it is saved with the chat', () => {
    const restored = sanitizeWorkspaces({
      [SID]: {
        ...EMPTY_WORKSPACE,
        tabs: [{ kind: 'plan', id: 'p1', toolId: 't1' }],
        activeKey: 'plan:p1'
      }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'plan', id: 'p1', toolId: 't1' }])
    expect(restored[SID].activeKey).toBe('plan:p1')
  })

  it('drops a plan row with no toolId rather than restoring a tab pointing nowhere', () => {
    const restored = sanitizeWorkspaces({
      [SID]: { ...EMPTY_WORKSPACE, tabs: [{ kind: 'plan', id: 'p1' }] }
    })
    expect(restored[SID]?.tabs ?? []).toEqual([])
  })
})
