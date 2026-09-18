import { beforeEach, describe, expect, it } from 'vitest'
import { openFileInPanel } from '@renderer/lib/openFile'
import { useSessionsStore } from '@renderer/store/sessions'
import { useUiStore } from '@renderer/store/ui'
import {
  tabKey,
  useWorkspaceStore,
  workspaceFor,
  type FileWorkspaceTab
} from '@renderer/store/workspace'

const SID = 'chat-1'

const ws = () => workspaceFor(useWorkspaceStore.getState(), SID)
const paths = (): (string | null)[] =>
  ws().tabs.map((t) => (t.kind === 'file' ? t.path : `browser:${t.tabId}`))

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
  useUiStore.setState({ rightPanelOpen: false })
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, cwd: '/repo' }] as never,
    projects: []
  })
})

describe('openFileInPanel', () => {
  it('opens the panel and adds a tab', () => {
    openFileInPanel('/repo/src/a.ts')

    expect(useUiStore.getState().rightPanelOpen).toBe(true)
    expect(paths()).toEqual(['/repo/src/a.ts'])
  })

  // Claude prints relative paths; resolving them is the rule the old modal
  // owned and this inherits rather than re-implements.
  it('resolves a relative path against the chat’s directory', () => {
    openFileInPanel('src/a.ts')
    expect(paths()).toEqual(['/repo/src/a.ts'])

    useWorkspaceStore.setState({ bySession: {} })
    openFileInPanel('./src/b.ts')
    expect(paths()).toEqual(['/repo/src/b.ts'])
  })

  // Clicking five paths in a row is five looks at the transcript, not a request
  // for five tabs.
  it('reuses the open file tab rather than stacking them up', () => {
    openFileInPanel('/repo/a.ts')
    openFileInPanel('/repo/b.ts')
    openFileInPanel('/repo/c.ts')

    expect(paths()).toEqual(['/repo/c.ts'])
  })

  it('focuses a tab that already has the file instead of retargeting another', () => {
    openFileInPanel('/repo/a.ts')
    const first = ws().tabs[0] as FileWorkspaceTab
    useWorkspaceStore.getState().openFileTab(SID, '/repo/b.ts')

    openFileInPanel('/repo/a.ts')

    expect(paths()).toEqual(['/repo/a.ts', '/repo/b.ts'])
    expect(ws().activeKey).toBe(tabKey(first))
  })

  it('adds a tab rather than retargeting when a browser tab is in front', () => {
    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    openFileInPanel('/repo/a.ts')

    expect(paths()).toEqual(['browser:t1', '/repo/a.ts'])
  })

  it('does nothing with no chat on screen', () => {
    useSessionsStore.setState({ activeSessionId: null })
    openFileInPanel('/repo/a.ts')

    expect(useUiStore.getState().rightPanelOpen).toBe(false)
    expect(ws().tabs).toEqual([])
  })
})
