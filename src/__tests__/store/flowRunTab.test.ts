import { beforeEach, describe, expect, it } from 'vitest'
import { sanitizePanelTabs, usePanelTabsStore, panelTabsFor, type ChatPanelTabs } from '@renderer/store/panelTabs'

const SID = 'chat-1'
const ws = (): ChatPanelTabs => panelTabsFor(usePanelTabsStore.getState(), SID)

beforeEach(() => usePanelTabsStore.setState({ bySession: {} }))

describe('the run tab', () => {
  it('is one row per chat, pointed at the newest run', () => {
    const first = usePanelTabsStore.getState().openFlowRunTab(SID, 'exec-1')
    const second = usePanelTabsStore.getState().openFlowRunTab(SID, 'exec-2')
    expect(second).toBe(first)
    expect(ws().tabs).toEqual([{ kind: 'flowRun', id: expect.any(String), executionId: 'exec-2' }])
  })

  it('can be added without taking the strip from what you were reading', () => {
    usePanelTabsStore.getState().openFileTab(SID, '/repo/a.ts')
    const reading = ws().activeKey
    usePanelTabsStore.getState().openFlowRunTab(SID, 'exec-1', false)
    expect(ws().activeKey).toBe(reading)
    expect(ws().tabs.some((t) => t.kind === 'flowRun')).toBe(true)
  })

  it('comes back after a restart', () => {
    const restored = sanitizePanelTabs({
      [SID]: { tabs: [{ kind: 'flowRun', id: 't1', executionId: 'exec-1' }], activeKey: 'flowRun:t1' }
    })
    expect(restored[SID].tabs).toEqual([{ kind: 'flowRun', id: 't1', executionId: 'exec-1' }])
    expect(restored[SID].activeKey).toBe('flowRun:t1')
  })
})
