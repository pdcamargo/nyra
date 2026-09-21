import type React from 'react'
import {
  Bot,
  ClipboardCopy,
  Eraser,
  FileDiff,
  FileText,
  FolderPlus,
  Globe,
  LogIn,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  PanelRightOpen,
  Plus,
  Receipt,
  RotateCw,
  Smartphone,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Braces,
  ChartNoAxesColumn,
  History,
  LayoutGrid,
  Play,
  Info,
  SlidersHorizontal,
  Zap,
  Square,
  Target,
  TextQuote,
  Workflow
} from 'lucide-react'
import type { Chord } from '../lib/keys'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useWorkflowStore } from '../store/workflow'
import {
  createSiblingSession,
  cwdForSession,
  openFolderAsProject,
  useSessionsStore
} from '../store/sessions'
import { useWorkspaceStore, workspaceFor } from '../store/workspace'
import { startBrowserTab, toggleDeviceMode } from '../components/browser/useBrowserSession'
import { openChangesInPanel, openSubagentsInPanel } from '../lib/openFile'
import { useChangesStore } from '../store/changes'

/**
 * Everything the app can be asked to do, in one list.
 *
 * Not a "shortcut registry" next to the palette's own array — one registry where
 * the binding is optional. `defaultChord: null` means runnable but unbound,
 * which is what lets the palette, the title-bar tooltips and the Settings table
 * all show the same answer, and lets a user put a key on something that only
 * ever had a menu entry.
 */
export type CommandId =
  | 'palette.open'
  | 'palette.history'
  | 'search.inSession'
  | 'app.settings'
  | 'app.permissions'
  | 'app.stats'
  | 'app.login'
  | 'session.new'
  | 'session.prev'
  | 'session.next'
  | 'session.clear'
  | 'session.copy'
  | 'session.abort'
  | 'project.add'
  | 'panel.left'
  | 'panel.right'
  | 'panel.right.browser'
  | 'browser.deviceMode'
  | 'panel.right.file'
  | 'panel.right.changes'
  | 'panel.right.changes.refresh'
  | 'panel.right.subagents'
  | 'panel.right.tree'
  | 'panel.bottom'
  | 'panel.summary'
  | 'panel.canvas'
  | 'flow.run'
  | 'flow.addNode'
  | 'flow.arrange'
  | 'flow.panel.details'
  | 'flow.panel.inputs'
  | 'flow.panel.vars'
  | 'flow.panel.history'
  | 'flow.panel.metrics'
  | 'flow.panel.triggers'
  | 'flow.stop'
  | 'chat.planMode'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'composer.bold'
  | 'composer.italic'
  | 'composer.code'
  | 'composer.link'
  | 'composer.heading'
  | 'composer.stash'
  | 'composer.send'
  | 'composer.newline'

export type CommandGroup = 'General' | 'Session' | 'Panels' | 'View' | 'Composer'

export type Command = {
  id: CommandId
  label: string
  group: CommandGroup
  defaultChord: Chord | null
  icon?: React.ComponentType<{ className?: string }>
  /** Offered in the command palette's action list. */
  palette?: boolean
  /**
   * Fires while an input, textarea or editor surface has focus.
   *
   * Left undefined it follows the chord: anything carrying mod/ctrl/alt does,
   * a bare key does not. That reproduces what the hand-written handlers did.
   */
  allowInInput?: boolean
  /**
   * Listed in the Settings table for reference but owned by the surface that
   * implements it — the composer's editing keys need the caret and the current
   * value, which `run: () => void` cannot reach. Registering them anyway is what
   * lets conflict detection warn before a global binding shadows one.
   */
  readOnly?: true
  run?: () => void
}

const ui = (): ReturnType<typeof useUiStore.getState> => useUiStore.getState()

/**
 * Put a tab in the side panel, opening the panel if it is shut.
 *
 * Deliberately `setRightPanelOpen` rather than the toggle: this is always "show
 * me this", and a toggle would close the panel half the time.
 */
async function openWorkspaceTab(kind: 'browser' | 'file'): Promise<void> {
  const sessionId = useSessionsStore.getState().activeSessionId
  if (!sessionId) return
  ui().setRightPanelOpen(true)
  if (kind === 'file') useWorkspaceStore.getState().openFileTab(sessionId)
  else await startBrowserTab(sessionId)
}

function cycleSession(step: 1 | -1): void {
  const { sessions, activeSessionId, setActiveSession } = useSessionsStore.getState()
  if (sessions.length < 2 || !activeSessionId) return
  const at = sessions.findIndex((s) => s.id === activeSessionId)
  if (at === -1) return
  setActiveSession(sessions[(at + step + sessions.length) % sessions.length].id)
}

export const COMMANDS: Command[] = [
  // ---- General -----------------------------------------------------------
  {
    id: 'palette.open',
    label: 'Command palette',
    group: 'General',
    defaultChord: 'mod+k',
    run: () => ui().openPalette('all')
  },
  {
    id: 'palette.history',
    label: 'Past prompts',
    group: 'General',
    defaultChord: 'mod+r',
    allowInInput: true,
    run: () => ui().openPalette('history')
  },
  {
    id: 'search.inSession',
    label: 'Find in conversation',
    group: 'General',
    defaultChord: 'mod+f',
    icon: Search,
    palette: true,
    allowInInput: true,
    run: () => window.dispatchEvent(new Event('nyra:toggle-insession-search'))
  },
  {
    id: 'app.settings',
    label: 'Settings',
    group: 'General',
    defaultChord: 'mod+,',
    icon: Settings,
    palette: true,
    run: () => ui().openSettings()
  },
  {
    id: 'app.permissions',
    label: 'Tool permissions',
    group: 'General',
    defaultChord: null,
    icon: ShieldCheck,
    palette: true,
    run: () => ui().openSettings('permissions')
  },
  {
    id: 'app.stats',
    label: 'Usage and cost',
    group: 'General',
    defaultChord: null,
    icon: Receipt,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:open-stats'))
  },
  {
    id: 'app.login',
    label: 'Switch account',
    group: 'General',
    defaultChord: null,
    icon: LogIn,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:open-login'))
  },

  // ---- Session -----------------------------------------------------------
  {
    id: 'session.new',
    label: 'New chat',
    group: 'Session',
    defaultChord: 'mod+n',
    icon: Plus,
    palette: true,
    run: () => createSiblingSession()
  },
  {
    id: 'session.prev',
    label: 'Previous chat',
    group: 'Session',
    defaultChord: 'mod+[',
    run: () => cycleSession(-1)
  },
  {
    id: 'session.next',
    label: 'Next chat',
    group: 'Session',
    defaultChord: 'mod+]',
    run: () => cycleSession(1)
  },
  {
    id: 'session.clear',
    label: 'Clear conversation',
    group: 'Session',
    defaultChord: null,
    icon: Eraser,
    palette: true,
    run: () => {
      const { activeSessionId, clearMessages } = useSessionsStore.getState()
      if (activeSessionId) clearMessages(activeSessionId)
    }
  },
  {
    id: 'session.copy',
    label: 'Copy conversation as markdown',
    group: 'Session',
    defaultChord: 'mod+shift+c',
    icon: ClipboardCopy,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:copy-conversation'))
  },
  {
    id: 'session.abort',
    label: 'Stop the current turn',
    group: 'Session',
    defaultChord: 'escape',
    // Escape has to reach this from inside the composer, which is where you are
    // when you decide to stop it.
    allowInInput: true,
    run: () => void window.api.claude.abort(useSessionsStore.getState().activeSessionId ?? undefined)
  },
  {
    id: 'project.add',
    label: 'Add project…',
    group: 'Session',
    defaultChord: null,
    icon: FolderPlus,
    palette: true,
    run: () =>
      void window.api.dialog.pickFolder().then((folder) => {
        if (folder) openFolderAsProject(folder)
      })
  },

  // ---- Panels ------------------------------------------------------------
  {
    id: 'panel.left',
    label: 'Toggle projects panel',
    group: 'Panels',
    defaultChord: 'mod+shift+l',
    icon: PanelLeft,
    palette: true,
    run: () => ui().toggleProjectsPanel()
  },
  {
    id: 'panel.right',
    // Keeps mod+shift+b though the panel is no longer only the browser: the
    // shortcuts store persists overrides, not defaults, so moving this would
    // silently rebind the key under everyone who never customised it.
    label: 'Toggle side panel',
    group: 'Panels',
    defaultChord: 'mod+shift+b',
    icon: PanelRight,
    palette: true,
    run: () => ui().toggleRightPanel()
  },
  {
    id: 'panel.right.browser',
    label: 'New browser tab',
    group: 'Panels',
    defaultChord: 'mod+t',
    icon: Globe,
    palette: true,
    run: () => void openWorkspaceTab('browser')
  },
  {
    // Unbound by default. Worth registering anyway — it is reached often enough
    // to want in the palette, and registering is what puts a live keycap in the
    // menu instead of a glyph that goes stale the moment anyone rebinds.
    id: 'browser.deviceMode',
    label: 'Toggle device mode',
    group: 'Panels',
    defaultChord: null,
    icon: Smartphone,
    palette: true,
    run: () => void toggleDeviceMode()
  },
  {
    id: 'panel.right.file',
    label: 'New file tab',
    group: 'Panels',
    defaultChord: 'mod+p',
    icon: FileText,
    palette: true,
    run: () => void openWorkspaceTab('file')
  },
  {
    id: 'panel.right.changes',
    label: 'Open changes',
    group: 'Panels',
    // mod+shift+d: mod+d is the composer's own, and this is the diff.
    defaultChord: 'mod+shift+d',
    icon: FileDiff,
    palette: true,
    run: () => openChangesInPanel()
  },
  {
    // Unbound by default. There is a row for every agent in the summary and a
    // "See all" above them, so the palette entry is for the times the summary is
    // closed — worth a name and a rebindable key, not worth a chord of its own.
    //
    // Absent from `NEW_TAB_CHOICES` on purpose, like changes and plan: it is
    // about this conversation, and "+" makes a blank workspace tab.
    id: 'panel.right.subagents',
    label: 'Open subagents',
    group: 'Panels',
    defaultChord: null,
    icon: Bot,
    palette: true,
    run: () => openSubagentsInPanel(null)
  },
  {
    // Unbound by default — there is a button for it, and a refresh key that only
    // works on one tab would be a surprise everywhere else.
    id: 'panel.right.changes.refresh',
    label: 'Refresh changes',
    group: 'Panels',
    defaultChord: null,
    icon: RotateCw,
    palette: true,
    run: () => {
      const sessionId = useSessionsStore.getState().activeSessionId
      if (!sessionId) return
      const state = useSessionsStore.getState()
      void useChangesStore
        .getState()
        .refresh(sessionId, cwdForSession(state, sessionId))
    }
  },
  {
    // Unbound by default — there is a button for it. Registered anyway so it can
    // be given a key and so it shows up in the palette with everything else.
    id: 'panel.right.tree',
    label: 'Toggle file tree',
    group: 'Panels',
    defaultChord: null,
    icon: PanelRightOpen,
    palette: true,
    run: () => {
      const sessionId = useSessionsStore.getState().activeSessionId
      if (!sessionId) return
      const store = useWorkspaceStore.getState()
      store.setTreeOpen(sessionId, !workspaceFor(store, sessionId).treeOpen)
    }
  },
  {
    id: 'panel.bottom',
    label: 'Toggle terminal',
    group: 'Panels',
    defaultChord: 'mod+j',
    icon: SquareTerminal,
    palette: true,
    run: () => ui().toggleBottomPanel()
  },
  {
    id: 'panel.summary',
    label: 'Toggle summary',
    group: 'Panels',
    defaultChord: 'mod+shift+s',
    icon: TextQuote,
    palette: true,
    run: () => ui().toggleSummary()
  },
  {
    id: 'panel.canvas',
    label: 'Switch between Chats and Flows',
    group: 'Panels',
    defaultChord: 'mod+shift+w',
    icon: Workflow,
    palette: true,
    run: () => {
      const { isCanvasOpen, openCanvas, closeCanvas } = useWorkflowStore.getState()
      if (isCanvasOpen) closeCanvas()
      else openCanvas()
    }
  },

  {
    id: 'flow.run',
    label: 'Run this flow',
    group: 'Panels',
    defaultChord: 'mod+enter',
    icon: Play,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-run'))
  },
  {
    id: 'flow.addNode',
    label: 'Add a node to this flow',
    group: 'Panels',
    // A bare letter is safe: `isEditableTarget` stops chords firing in a field,
    // and the canvas is where your hands are when you want one.
    defaultChord: 'shift+n',
    icon: Plus,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-add-node'))
  },
  {
    id: 'flow.panel.details',
    label: 'Flow details',
    group: 'Panels',
    defaultChord: 'mod+1',
    icon: Info,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-details'))
  },
  {
    id: 'flow.panel.inputs',
    label: 'Flow inputs',
    group: 'Panels',
    // mod+1..6, in toolbar order. These were unbound, which meant their
    // tooltips showed no keycap at all and read as though the shortcut had been
    // forgotten. The digits were entirely free.
    defaultChord: 'mod+2',
    icon: SlidersHorizontal,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-inputs'))
  },
  {
    id: 'flow.panel.vars',
    label: 'Flow runtime variables',
    group: 'Panels',
    // Unbound by default: discoverable in the palette and rebindable, without
    // spending five chords on panels most people open by clicking.
    defaultChord: 'mod+3',
    icon: Braces,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-vars'))
  },
  {
    id: 'flow.panel.history',
    label: 'Flow execution history',
    group: 'Panels',
    // Unbound by default: discoverable in the palette and rebindable, without
    // spending five chords on panels most people open by clicking.
    defaultChord: 'mod+4',
    icon: History,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-history'))
  },
  {
    id: 'flow.panel.metrics',
    label: 'Flow execution metrics',
    group: 'Panels',
    // Unbound by default: discoverable in the palette and rebindable, without
    // spending five chords on panels most people open by clicking.
    defaultChord: 'mod+5',
    icon: ChartNoAxesColumn,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-metrics'))
  },
  {
    id: 'flow.panel.triggers',
    label: 'Flow triggers',
    group: 'Panels',
    // Unbound by default: discoverable in the palette and rebindable, without
    // spending five chords on panels most people open by clicking.
    defaultChord: 'mod+6',
    icon: Zap,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-triggers'))
  },
  {
    id: 'flow.arrange',
    label: 'Arrange nodes top to bottom',
    group: 'Panels',
    defaultChord: null,
    icon: LayoutGrid,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-arrange'))
  },
  {
    id: 'flow.stop',
    label: 'Stop the running flow',
    group: 'Panels',
    // No chord by default: Escape belongs to whatever dialog is open, and
    // stopping a run is one click away in the header.
    defaultChord: null,
    icon: Square,
    palette: true,
    run: () => window.dispatchEvent(new Event('nyra:flow-stop'))
  },

  // ---- View --------------------------------------------------------------
  {
    id: 'chat.planMode',
    label: 'Toggle plan mode',
    group: 'View',
    defaultChord: 'mod+shift+p',
    icon: Target,
    palette: true,
    run: () => {
      // The chat you are looking at, not every chat at once.
      const { activeSessionId, sessions, setSessionSettings } = useSessionsStore.getState()
      const defaults = useSettingsStore.getState()
      if (!activeSessionId) {
        defaults.updateSettings({ planMode: !defaults.planMode })
        return
      }
      const session = sessions.find((s) => s.id === activeSessionId)
      setSessionSettings(activeSessionId, {
        planMode: !(session?.planMode ?? defaults.planMode)
      })
    }
  },
  {
    id: 'view.zoomIn',
    label: 'Zoom in',
    group: 'View',
    defaultChord: 'mod+=',
    icon: Maximize2,
    run: () => zoomBy(1)
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom out',
    group: 'View',
    defaultChord: 'mod+-',
    icon: Minimize2,
    run: () => zoomBy(-1)
  },
  {
    id: 'view.zoomReset',
    label: 'Actual size',
    group: 'View',
    defaultChord: 'mod+0',
    run: () => useSettingsStore.getState().updateSettings({ zoom: 1 })
  },

  // ---- Composer ----------------------------------------------------------
  // Owned by ChatInput: each needs the caret and the current draft. Here so the
  // Settings table is a complete reference and conflicts are visible.
  { id: 'composer.send', label: 'Send message', group: 'Composer', defaultChord: 'enter', readOnly: true },
  { id: 'composer.newline', label: 'New line / next list item', group: 'Composer', defaultChord: 'shift+enter', readOnly: true },
  { id: 'composer.bold', label: 'Bold', group: 'Composer', defaultChord: 'mod+b', readOnly: true },
  { id: 'composer.italic', label: 'Italic', group: 'Composer', defaultChord: 'mod+i', readOnly: true },
  { id: 'composer.code', label: 'Inline code', group: 'Composer', defaultChord: 'mod+e', readOnly: true },
  { id: 'composer.link', label: 'Insert link', group: 'Composer', defaultChord: 'mod+u', readOnly: true },
  { id: 'composer.heading', label: 'Heading 1–6', group: 'Composer', defaultChord: 'alt+1', readOnly: true },
  { id: 'composer.stash', label: 'Stash / restore draft', group: 'Composer', defaultChord: 'ctrl+s', readOnly: true }
]

/** Deferred so the registry does not import the zoom module at load time. */
function zoomBy(direction: 1 | -1): void {
  void import('../lib/zoom').then(({ nextZoom }) => {
    const { zoom, updateSettings } = useSettingsStore.getState()
    updateSettings({ zoom: nextZoom(zoom, direction) })
  })
}

export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

/**
 * Chords the OS takes before the webview sees them. Binding one is allowed —
 * it just will not fire — so this drives a warning, not a refusal.
 */
export const RESERVED: { chord: Chord; label: string }[] = [
  { chord: 'mod+q', label: 'Quit' },
  { chord: 'mod+w', label: 'Close window' },
  { chord: 'mod+m', label: 'Minimise' },
  { chord: 'mod+h', label: 'Hide' },
  { chord: 'mod+x', label: 'Cut' },
  { chord: 'mod+c', label: 'Copy' },
  { chord: 'mod+v', label: 'Paste' },
  { chord: 'mod+a', label: 'Select all' },
  { chord: 'mod+z', label: 'Undo' }
]
