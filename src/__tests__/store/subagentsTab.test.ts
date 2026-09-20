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

describe('the subagents tab in the strip', () => {
  it('opens on the list and selects it', () => {
    const key = useWorkspaceStore.getState().openSubagentsTab(SID, null)
    expect(ws().tabs).toEqual([{ kind: 'subagents', id: expect.any(String), focus: null }])
    expect(ws().activeKey).toBe(key)
  })

  it('reuses the existing row rather than stacking one per agent', () => {
    const first = useWorkspaceStore.getState().openSubagentsTab(SID, null)
    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    const second = useWorkspaceStore.getState().openSubagentsTab(SID, 'agent-1')

    expect(second).toBe(first)
    expect(ws().tabs.filter((t) => t.kind === 'subagents')).toHaveLength(1)
    expect(ws().activeKey).toBe(first)
  })

  it('retargets focus, which is what makes the back arrow free', () => {
    const key = useWorkspaceStore.getState().openSubagentsTab(SID, 'agent-1')
    useWorkspaceStore.getState().openSubagentsTab(SID, 'agent-2')
    expect(ws().tabs).toEqual([{ kind: 'subagents', id: expect.any(String), focus: 'agent-2' }])

    // The back arrow is the same call with a null focus — no new row, no close.
    expect(useWorkspaceStore.getState().openSubagentsTab(SID, null)).toBe(key)
    expect(ws().tabs).toEqual([{ kind: 'subagents', id: expect.any(String), focus: null }])
  })

  it('gets its own key namespace, so it cannot collide with another kind', () => {
    // `tabKey` falls through to `changes:` by default, so an omitted case here
    // would silently make two different tabs the same tab.
    expect(tabKey({ kind: 'subagents', id: 'x', focus: null })).toBe('subagents:x')
    expect(tabKey({ kind: 'plan', id: 'x', toolId: 't' })).toBe('plan:x')
    expect(tabKey({ kind: 'changes', id: 'x' })).toBe('changes:x')
    expect(tabKey({ kind: 'file', id: 'x', path: null })).toBe('file:x')
  })

  it('survives a sidecar reconcile that empties the browser half of the strip', () => {
    useWorkspaceStore.getState().openSubagentsTab(SID, 'agent-1')
    const after = reconcileTabs(ws(), [])
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].kind).toBe('subagents')
  })
})

describe('persistence', () => {
  it('restores the row and the agent it was focused on', () => {
    const restored = sanitizeWorkspaces({
      [SID]: {
        ...EMPTY_WORKSPACE,
        tabs: [{ kind: 'subagents', id: 's1', focus: 'agent-1' }],
        activeKey: 'subagents:s1'
      }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'subagents', id: 's1', focus: 'agent-1' }])
    expect(restored[SID].activeKey).toBe('subagents:s1')
  })

  it('restores a list-mode row, whose focus is legitimately null', () => {
    const restored = sanitizeWorkspaces({
      [SID]: { ...EMPTY_WORKSPACE, tabs: [{ kind: 'subagents', id: 's1', focus: null }] }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'subagents', id: 's1', focus: null }])
  })

  it('treats a missing focus as the list rather than dropping the row', () => {
    const restored = sanitizeWorkspaces({
      [SID]: { ...EMPTY_WORKSPACE, tabs: [{ kind: 'subagents', id: 's1' }] }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'subagents', id: 's1', focus: null }])
  })
})
