import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import WorkspacePanel from '@renderer/components/workspace/WorkspacePanel'
import WorkspaceTabStrip from '@renderer/components/workspace/WorkspaceTabStrip'
import { useBrowserStore } from '@renderer/store/browser'
import { useSessionsStore } from '@renderer/store/sessions'
import { useUiStore } from '@renderer/store/ui'
import { browserKey, tabKey, useWorkspaceStore, type WorkspaceTab } from '@renderer/store/workspace'
import type { BrowserTab } from '@renderer/lib/api-types'

const SID = 'chat-1'

const browserTab = (tabId: string, over: Partial<BrowserTab> = {}): BrowserTab => ({
  tabId,
  targetId: `target-${tabId}`,
  url: `https://example.test/${tabId}`,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over
})

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
  useBrowserStore.setState({ bySession: {}, cdpUrl: null, install: null })
  useSessionsStore.setState({ activeSessionId: SID })
  useUiStore.setState({ rightPanelOpen: true })
  vi.restoreAllMocks()
})

describe('WorkspaceTabStrip', () => {
  const renderStrip = (tabs: WorkspaceTab[], browserTabs: BrowserTab[] = []) => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={tabs}
        activeKey={tabs[0] ? tabKey(tabs[0]) : null}
        browserTabs={browserTabs}
        onSelect={onSelect}
        onClose={onClose}
        onNew={vi.fn()}
      />
    )
    return { onSelect, onClose }
  }

  it('draws a browser row and a file row side by side', () => {
    renderStrip(
      [
        { kind: 'browser', tabId: 't1' },
        { kind: 'file', id: 'x', path: '/repo/src/app.ts' }
      ],
      [browserTab('t1', { title: 'Example' })]
    )

    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByText('Example')).toBeInTheDocument()
    expect(screen.getByText('app.ts')).toBeInTheDocument()
  })

  it('calls a file tab "Open file" until it has a file', () => {
    renderStrip([{ kind: 'file', id: 'x', path: null }])
    expect(screen.getByText('Open file')).toBeInTheDocument()
  })

  it('falls back to the host when a page has no title yet', () => {
    renderStrip([{ kind: 'browser', tabId: 't1' }], [browserTab('t1')])
    expect(screen.getByText('example.test')).toBeInTheDocument()
  })

  it('closes the row it was asked to close, not the one selected', async () => {
    const user = userEvent.setup()
    const { onClose, onSelect } = renderStrip([
      { kind: 'file', id: 'x', path: '/a.ts' },
      { kind: 'file', id: 'y', path: '/b.ts' }
    ])

    await user.click(screen.getAllByLabelText('Close tab')[1])
    expect(onClose).toHaveBeenCalledWith('file:y')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('asks which kind of tab rather than assuming', async () => {
    const user = userEvent.setup()
    renderStrip([])

    await user.click(screen.getByLabelText('New tab'))
    expect(screen.getByRole('menuitem', { name: /Browser/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Files/ })).toBeInTheDocument()
  })
})

describe('WorkspacePanel', () => {
  it('offers both choices when the panel is empty', () => {
    render(<WorkspacePanel />)
    expect(screen.getByRole('button', { name: /Browser/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument()
  })

  // The headline requirement. Opening the panel to read a file used to mean
  // downloading a 182 MB browser engine, because mounting the panel *was* the
  // request for one.
  it('never starts a browser for a files-only workspace', async () => {
    const status = vi.spyOn(window.api.browser, 'status')
    const openChat = vi.spyOn(window.api.browser, 'openChat')

    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    render(<WorkspacePanel />)
    await Promise.resolve()

    expect(status).not.toHaveBeenCalled()
    expect(openChat).not.toHaveBeenCalled()
  })

  it('starts one as soon as the chat has a browser tab', async () => {
    const status = vi.spyOn(window.api.browser, 'status').mockResolvedValue({ ok: false, error: 'nope' })

    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    render(<WorkspacePanel />)
    await Promise.resolve()

    expect(status).toHaveBeenCalled()
  })

  it('shows a file tab rather than the browser when a file tab is selected', () => {
    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    useBrowserStore.getState().setTabs(SID, [browserTab('t1')])
    const key = useWorkspaceStore.getState().openFileTab(SID)
    useWorkspaceStore.getState().selectTab(SID, key)

    render(<WorkspacePanel />)

    expect(screen.getByText('Select a file from the workspace tree.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Address')).toBeNull()
  })

  it('shows the address bar when a browser tab is selected', () => {
    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    useBrowserStore.getState().setTabs(SID, [browserTab('t1')])
    useWorkspaceStore.getState().selectTab(SID, browserKey('t1'))

    render(<WorkspacePanel />)
    expect(screen.getByLabelText('Address')).toBeInTheDocument()
  })

  // The download prompt used to take the whole panel, tab strip included.
  it('keeps the strip while Chromium is missing', () => {
    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    useBrowserStore.getState().setPhase(SID, 'needs-chromium')

    render(<WorkspacePanel />)

    // Scoped to the strip: the breadcrumb says the file's name too.
    const strip = screen.getByRole('tablist')
    expect(within(strip).getByRole('tab', { name: /a\.ts/ })).toBeInTheDocument()
  })

  it('offers the download when something asked for a browser and there is none', () => {
    useBrowserStore.getState().setPhase(SID, 'needs-chromium')
    render(<WorkspacePanel />)
    expect(screen.getByText('Nyra needs a browser engine')).toBeInTheDocument()
  })

  // A chat keeps its browser context after its last tab closes, so the phase
  // stays `ready` — which the panel used to read as "a browser is starting".
  it('offers the two choices again once the tabs are gone, not a starting browser', () => {
    useBrowserStore.getState().setPhase(SID, 'ready')

    render(<WorkspacePanel />)

    expect(screen.queryByText('Starting the browser…')).toBeNull()
    expect(screen.getByRole('button', { name: /Browser/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument()
  })

  it('puts the panel away when the last tab is closed', async () => {
    const user = userEvent.setup()
    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')

    render(<WorkspacePanel />)
    await user.click(screen.getByLabelText('Close tab'))

    expect(useUiStore.getState().rightPanelOpen).toBe(false)
  })

  it('stays open while another tab is left', async () => {
    const user = userEvent.setup()
    useWorkspaceStore.getState().openFileTab(SID, '/repo/a.ts')
    useWorkspaceStore.getState().openFileTab(SID, '/repo/b.ts')

    render(<WorkspacePanel />)
    await user.click(screen.getAllByLabelText('Close tab')[0])

    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })

  it('closes on the last browser tab too, without waiting for the sidecar', async () => {
    const user = userEvent.setup()
    const tabClose = vi.spyOn(window.api.browser, 'tabClose')
    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    useBrowserStore.getState().setTabs(SID, [browserTab('t1')])

    render(<WorkspacePanel />)
    await user.click(screen.getByLabelText('Close tab'))

    expect(tabClose).toHaveBeenCalledWith(SID, 't1')
    expect(useUiStore.getState().rightPanelOpen).toBe(false)
  })

  // The panel must not vanish because the browser went down or was evicted —
  // only because somebody put it away.
  it('stays open when the strip empties on its own', () => {
    useWorkspaceStore.getState().reconcile(SID, ['t1'])
    render(<WorkspacePanel />)

    useWorkspaceStore.getState().reconcile(SID, [])

    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })

  it('says so with no chat on screen', () => {
    useSessionsStore.setState({ activeSessionId: null })
    render(<WorkspacePanel />)
    expect(screen.getByText('Open a chat to give it a workspace.')).toBeInTheDocument()
  })
})
