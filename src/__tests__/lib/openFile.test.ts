import { beforeEach, describe, expect, it } from 'vitest'
import { isDesignPath, openFileInPanel, splitDesignRef } from '@renderer/lib/openFile'
import { useSessionsStore } from '@renderer/store/sessions'
import { useUiStore } from '@renderer/store/ui'
import {
  tabKey,
  useWorkspaceStore,
  workspaceFor,
  type FileWorkspaceTab
} from '@renderer/store/workspace'
import {
  openChangesInPanel,
  openPlanInPanel,
  CHANGES_MIN_WIDTH,
  PLAN_MIN_WIDTH
} from '@renderer/lib/openFile'
import { PANEL_DEFAULTS, usePanelSizesStore } from '@renderer/store/panelSizes'
import { useChangesStore } from '@renderer/store/changes'

const SID = 'chat-1'

const ws = () => workspaceFor(useWorkspaceStore.getState(), SID)
const paths = (): (string | null)[] =>
  ws().tabs.map((t) =>
    t.kind === 'file'
      ? t.path
      : t.kind === 'browser'
        ? `browser:${t.tabId}`
        : t.kind === 'plan'
          ? `plan:${t.toolId}`
          : 'changes'
  )

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

describe('openChangesInPanel', () => {
  beforeEach(() => {
    usePanelSizesStore.setState({ rightPanelWidth: PANEL_DEFAULTS.rightPanelWidth })
    useChangesStore.setState({ bySession: {} })
  })

  it('opens the panel and adds the changes tab', () => {
    openChangesInPanel()

    expect(useUiStore.getState().rightPanelOpen).toBe(true)
    expect(paths()).toEqual(['changes'])
  })

  // The panel ships at 256 and `treeFits` wants 280, so at the default the tree
  // can never appear and a code line is cut off around column 35.
  it('widens a panel that is narrower than a diff needs', () => {
    expect(PANEL_DEFAULTS.rightPanelWidth).toBeLessThan(CHANGES_MIN_WIDTH)

    openChangesInPanel()

    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(CHANGES_MIN_WIDTH)
  })

  it('leaves a width the user dragged wider alone', () => {
    usePanelSizesStore.setState({ rightPanelWidth: 900 })

    openChangesInPanel()

    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(900)
  })

  it('carries a card’s base through, so the diff it opens is the one it described', () => {
    openChangesInPanel({ scope: { kind: 'since', base: '50cb2a4' }, focusPath: 'src/a.ts' })

    const changes = useChangesStore.getState().bySession[SID]
    expect(changes.scope).toEqual({ kind: 'since', base: '50cb2a4' })
    expect(changes.pendingFocus).toBe('src/a.ts')
  })

  it('reuses the row rather than opening a second one', () => {
    openChangesInPanel()
    openChangesInPanel()

    expect(paths()).toEqual(['changes'])
  })
})

describe('openPlanInPanel', () => {
  beforeEach(() => {
    usePanelSizesStore.setState({ rightPanelWidth: PANEL_DEFAULTS.rightPanelWidth })
  })

  it('opens the panel and adds the plan tab', () => {
    openPlanInPanel('t1')

    expect(useUiStore.getState().rightPanelOpen).toBe(true)
    expect(paths()).toEqual(['plan:t1'])
  })

  it('widens a panel too narrow to read prose in', () => {
    expect(PANEL_DEFAULTS.rightPanelWidth).toBeLessThan(PLAN_MIN_WIDTH)

    openPlanInPanel('t1')

    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(PLAN_MIN_WIDTH)
  })

  it('leaves a width the user dragged wider alone', () => {
    usePanelSizesStore.setState({ rightPanelWidth: 900 })

    openPlanInPanel('t1')

    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(900)
  })

  it('retargets the one row rather than opening a tab per plan', () => {
    openPlanInPanel('t1')
    openPlanInPanel('t2')

    expect(paths()).toEqual(['plan:t2'])
  })

  it('does nothing without an active chat, rather than opening an empty panel', () => {
    useSessionsStore.setState({ activeSessionId: null } as never)

    openPlanInPanel('t1')

    expect(useUiStore.getState().rightPanelOpen).toBe(false)
    expect(paths()).toEqual([])
  })
})

describe('a design opens as a design', () => {
  /**
   * The bug: Claude prints where it wrote the document, the path renders as a
   * file chip, and clicking it opens the JSON — the source nobody wrote by
   * hand, instead of the picture they asked for.
   */
  it('recognises a design document by extension', () => {
    expect(isDesignPath('/a/b/vpn-settings-d_ac7eca37b7.nyui.json')).toBe(true)
    expect(isDesignPath('/a/b/BILLING.NYUI.JSON')).toBe(true)
    expect(isDesignPath('/a/b/package.json')).toBe(false)
    expect(isDesignPath('/a/b/notes.nyui.md')).toBe(false)
  })
})

describe('a design reference can point at one artboard', () => {
  /**
   * `…/vpn-settings.nyui.json#settings-protocol` — a path with a fragment,
   * which needs no new convention because it is what a fragment already means.
   */
  it('splits a ref into its path and artboard', () => {
    expect(splitDesignRef('/a/b.nyui.json#settings-protocol')).toEqual({
      path: '/a/b.nyui.json',
      artboard: 'settings-protocol'
    })
    expect(splitDesignRef('/a/b.nyui.json')).toEqual({ path: '/a/b.nyui.json', artboard: null })
    // A trailing hash points at the document, not at an artboard called "".
    expect(splitDesignRef('/a/b.nyui.json#')).toEqual({ path: '/a/b.nyui.json', artboard: null })
  })

  it('still recognises a design when a fragment is attached', () => {
    // The plain file-path matcher rejects a fragment, so this had to be its own
    // check or a pointed-at artboard would render as inert code.
    expect(isDesignPath('/a/b.nyui.json#panel')).toBe(true)
    expect(isDesignPath('/a/b.json#panel')).toBe(false)
  })
})
