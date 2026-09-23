import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import WorkspacePanel from '@renderer/components/workspace/WorkspacePanel'
import WorkspaceTabStrip from '@renderer/components/workspace/WorkspaceTabStrip'
import { useBrowserStore } from '@renderer/store/browser'
import { useSessionsStore } from '@renderer/store/sessions'
import { useUiStore } from '@renderer/store/ui'
import { browserKey, tabKey, useWorkspaceStore, type WorkspaceTab } from '@renderer/store/workspace'
import type { BrowserTab } from '@renderer/lib/api-types'
import { TooltipProvider } from '@renderer/components/ui/tooltip'

/** The panel's buttons carry real tooltips now, and Radix requires the provider
 *  App mounts at the root. Rendering a slice of the tree has to supply it. */
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const SID = 'chat-1'

const browserTab = (tabId: string, over: Partial<BrowserTab> = {}): BrowserTab => ({
  device: null,
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
    const onReorder = vi.fn()
    const onPin = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={tabs}
        activeKey={tabs[0] ? tabKey(tabs[0]) : null}
        browserTabs={browserTabs}
        browserPhase="off"
        onSelect={onSelect}
        onClose={onClose}
        onPin={onPin}
        onReorder={onReorder}
        onNew={vi.fn()}
      />
    )
    return { onSelect, onClose, onReorder, onPin }
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

  // Every editor closes a tab with the wheel, and the gesture has to work on
  // every kind of row — a file, a diff, a page.
  it('closes a tab on a middle click', () => {
    const { onClose } = renderStrip([
      { kind: 'file', id: 'x', path: '/a.ts' },
      { kind: 'changes', id: 'c' }
    ])

    fireEvent(screen.getAllByRole('tab')[1], new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(onClose).toHaveBeenCalledWith('changes:c')
  })

  it('ignores a right click, which is a menu and not a close', () => {
    const { onClose } = renderStrip([{ kind: 'file', id: 'x', path: '/a.ts' }])

    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { button: 2, bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  // A preview row is the chat's replaceable slot; a double click is how it
  // stops being one.
  it('pins a preview tab on a double click', () => {
    const { onPin } = renderStrip([{ kind: 'file', id: 'x', path: '/a.ts', preview: true }])

    fireEvent.doubleClick(screen.getByRole('tab'))
    expect(onPin).toHaveBeenCalledWith('file:x')
  })

  it('draws a preview tab italic, and a pinned one upright', () => {
    renderStrip([
      { kind: 'file', id: 'x', path: '/a.ts', preview: true },
      { kind: 'file', id: 'y', path: '/b.ts' }
    ])

    expect(screen.getByText('a.ts').className).toContain('italic')
    expect(screen.getByText('b.ts').className).not.toContain('italic')
  })

  // The tab is the whole point of the provisional row: it is on screen before
  // the browser is, saying what it is waiting for.
  it('draws a browser row that is still waking', () => {
    renderStrip([{ kind: 'browser', tabId: 'pending-1', provisional: true }])

    expect(screen.getByRole('tab')).toHaveTextContent('New tab')
    expect(screen.getByRole('tab').getAttribute('title')).toMatch(/starting the browser/i)
  })

  describe('reordering', () => {
    const dataTransfer = (): DataTransfer =>
      ({ effectAllowed: '', setData: vi.fn(), getData: vi.fn() }) as unknown as DataTransfer

    /**
     * jsdom implements neither DragEvent nor layout.
     *
     * testing-library falls back to a plain `Event` for drag types, which drops
     * clientX — so a drag fired that way lands on the leading half every time and
     * the two branches below would be indistinguishable. A MouseEvent named
     * `dragover` carries the coordinate and still reaches React's handler.
     */
    const dragEvent = (type: string, clientX: number): Event => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer() })
      return event
    }

    /** Every element measures 0x0 in jsdom, so the midpoint has to be given. */
    const withBox = (el: HTMLElement, left: number, width: number): HTMLElement => {
      el.getBoundingClientRect = () => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) })
      return el
    }

    const dragTo = (from: HTMLElement, onto: HTMLElement, clientX: number): void => {
      fireEvent.dragStart(from, { dataTransfer: dataTransfer() })
      withBox(onto, 100, 50)
      fireEvent(onto, dragEvent('dragover', clientX))
      fireEvent(onto, dragEvent('drop', clientX))
    }

    // jsdom reports a zero-size box for everything, so the midpoint is 0 and any
    // positive clientX counts as the right half. That is enough to tell the two
    // branches apart, which is what matters.
    it('drops before a tab when released on its leading half', () => {
      const { onReorder } = renderStrip([
        { kind: 'file', id: 'x', path: '/a.ts' },
        { kind: 'file', id: 'y', path: '/b.ts' }
      ])
      const tabs = screen.getAllByRole('tab')
      dragTo(tabs[1], tabs[0], 110)
      expect(onReorder).toHaveBeenCalledWith('file:y', 'file:x')
    })

    it('drops past the end when released on the last tab\u2019s trailing half', () => {
      const { onReorder } = renderStrip([
        { kind: 'file', id: 'x', path: '/a.ts' },
        { kind: 'file', id: 'y', path: '/b.ts' }
      ])
      const tabs = screen.getAllByRole('tab')
      dragTo(tabs[0], tabs[1], 140)
      // null rather than a key: there is nothing after the last tab to go before.
      expect(onReorder).toHaveBeenCalledWith('file:x', null)
    })

    it('dims the tab being dragged', () => {
      renderStrip([
        { kind: 'file', id: 'x', path: '/a.ts' },
        { kind: 'file', id: 'y', path: '/b.ts' }
      ])
      const tabs = screen.getAllByRole('tab')
      fireEvent.dragStart(tabs[0], { dataTransfer: { setData: vi.fn(), effectAllowed: '' } })
      expect(tabs[0].className).toContain('opacity-40')
    })

    it('does not reorder when nothing was dragged', () => {
      const { onReorder } = renderStrip([{ kind: 'file', id: 'x', path: '/a.ts' }])
      fireEvent.drop(screen.getByRole('tab'))
      expect(onReorder).not.toHaveBeenCalled()
    })

    it('leaves the close button out of the drag', () => {
      renderStrip([{ kind: 'file', id: 'x', path: '/a.ts' }])
      expect(screen.getByLabelText('Close tab')).toHaveAttribute('draggable', 'false')
    })
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
