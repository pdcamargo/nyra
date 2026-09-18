import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_BROWSER, useBrowserStore } from '@renderer/store/browser'
import {
  browserKey,
  fileKey,
  syncBrowserGone,
  syncSidecarTabs,
  tabKey,
  useWorkspaceStore,
  workspaceFor
} from '@renderer/store/workspace'
import type { BrowserTab } from '@renderer/lib/api-types'

const SID = 'chat-1'

const tab = (tabId: string): BrowserTab => ({
  tabId,
  targetId: `target-${tabId}`,
  url: `https://example.test/${tabId}`,
  title: tabId,
  loading: false,
  canGoBack: false,
  canGoForward: false
})

const ws = (sessionId = SID): ReturnType<typeof workspaceFor> =>
  workspaceFor(useWorkspaceStore.getState(), sessionId)
const browser = (sessionId = SID): typeof EMPTY_BROWSER =>
  useBrowserStore.getState().bySession[sessionId] ?? EMPTY_BROWSER

describe('syncSidecarTabs', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ bySession: {} })
    useBrowserStore.setState({ bySession: {}, cdpUrl: null })
  })

  it('moves both stores together', () => {
    syncSidecarTabs(SID, [tab('t1'), tab('t2')])

    expect(browser().tabs.map((t) => t.tabId)).toEqual(['t1', 't2'])
    expect(ws().tabs.map(tabKey)).toEqual([browserKey('t1'), browserKey('t2')])
    expect(ws().activeKey).toBe(browserKey('t1'))
  })

  // The whole point of the split: the sidecar broadcasts its list and the strip
  // keeps the row it has never heard of.
  it('leaves a file tab alone and selected', () => {
    const key = useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    syncSidecarTabs(SID, [tab('t1')])

    expect(ws().tabs.map(tabKey)).toEqual([key, browserKey('t1')])
    expect(ws().activeKey).toBe(key)
  })

  it('carries a browser title change without disturbing the strip', () => {
    syncSidecarTabs(SID, [tab('t1')])
    const before = ws()

    syncSidecarTabs(SID, [{ ...tab('t1'), title: 'Renamed' }])

    expect(browser().tabs[0].title).toBe('Renamed')
    expect(ws()).toBe(before)
  })

  it('degrades a mixed chat to files-only on an eviction', () => {
    const key = useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    syncSidecarTabs(SID, [tab('t1')])
    useWorkspaceStore.getState().selectTab(SID, browserKey('t1'))

    syncSidecarTabs(SID, [])

    expect(browser().tabs).toEqual([])
    expect(ws().tabs.map(tabKey)).toEqual([key])
    expect(ws().activeKey).toBe(key)
  })
})

describe('syncBrowserGone', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ bySession: {} })
    useBrowserStore.setState({ bySession: {}, cdpUrl: 'ws://localhost:1' })
  })

  it('clears every chat’s browser and keeps every chat’s files', () => {
    const a = useWorkspaceStore.getState().openFileTab('chat-a', '/a.ts')
    syncSidecarTabs('chat-a', [tab('t1')])
    syncSidecarTabs('chat-b', [tab('t2')])

    syncBrowserGone()

    expect(useBrowserStore.getState().cdpUrl).toBeNull()
    expect(browser('chat-a').phase).toBe('off')
    expect(browser('chat-a').tabs).toEqual([])
    expect(browser('chat-b').tabs).toEqual([])

    expect(ws('chat-a').tabs.map(tabKey)).toEqual([a])
    expect(ws('chat-a').activeKey).toBe(a)
    expect(ws('chat-b').tabs).toEqual([])
    expect(ws('chat-b').activeKey).toBeNull()
  })

  it('is safe with nothing open', () => {
    expect(() => syncBrowserGone()).not.toThrow()
  })
})

describe('the file key namespace', () => {
  // Two id spaces in one strip: a browser tab and a file tab could otherwise
  // collide on a bare id and select each other.
  it('cannot collide with a browser key', () => {
    expect(fileKey('t1')).not.toBe(browserKey('t1'))
  })
})
