import type React from 'react'
import {
  Archive,
  Bot,
  Braces,
  Brain,
  ChartNoAxesColumn,
  ClipboardCopy,
  Eraser,
  FileDiff,
  FileSearch,
  FileText,
  FolderPlus,
  GitPullRequest,
  Globe,
  History,
  Info,
  LayoutGrid,
  LogIn,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  PanelRightOpen,
  Play,
  Plus,
  Receipt,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Slash,
  Sparkles,
  SlidersHorizontal,
  Smartphone,
  Square,
  SquareTerminal,
  Store,
  Sun,
  Target,
  TextQuote,
  Workflow,
  WrapText,
  Zap
} from 'lucide-react'
import type { Chord } from '../lib/keys'
import { sortPrs, type PullRequest } from '../lib/pullRequests'
import type { NewTabKind } from '../components/workspace/tabs'
import { useUiStore, type MainView } from '../store/ui'
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
  | 'session.pr.open'
  | 'project.add'
  | 'panel.left'
  | 'panel.right'
  | 'panel.right.browser'
  | 'browser.deviceMode'
  | 'panel.right.file'
  | 'file.quickOpen'
  | 'panel.right.changes'
  | 'panel.right.changes.refresh'
  | 'panel.right.subagents'
  | 'panel.right.tree'
  | 'file.wrap'
  | 'panel.bottom'
  | 'panel.summary'
  | 'panel.canvas'
  | 'view.chat'
  | 'view.skills'
  | 'view.commands'
  | 'view.memory'
  | 'view.plugins'
  | 'view.archived'
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
  | 'app.theme.light'
  | 'app.theme.dark'
  | 'app.theme.system'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'composer.bold'
  | 'composer.italic'
  | 'composer.code'
  | 'composer.link'
  | 'composer.heading'
  | 'composer.dictate'
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
  /**
   * Set the thing outright instead of flipping it.
   *
   * Every panel command is a toggle, which is right for a key — your hand knows
   * what it just did — and wrong for anything acting on an *intent*. "Open the
   * terminal" through `run` closes it half the time. Callers that mean open or
   * closed pass through here; the palette and the keyboard never touch it, so
   * this adds nothing to the UI.
   */
  setState?: (on: boolean) => void
  /** Reads the current value, for callers that have to report it. Defined on
   *  exactly the commands that define `setState`. */
  isOn?: () => boolean
  /**
   * False when running it right now would do nothing.
   *
   * Every `flow.*` command dispatches a window event that only `WorkflowCanvas`
   * hears, so with the Flows view closed they are silent no-ops that look like
   * successes. A keystroke can afford that; a caller that has to report what it
   * did cannot.
   */
  available?: () => boolean
  /**
   * `false` to keep this out of an agent's reach. Default is allow, so a new
   * command is reachable without anyone remembering to opt in — the denial is
   * the part that has to be deliberate.
   *
   * Two of these are self-destructive rather than merely rude: `session.abort`
   * cancels the agent's own turn, and `chat.planMode` is in the spawn
   * fingerprint, so flipping it kills and respawns the CLI child mid-reply.
   */
  agent?: false
  /** Why it is off-limits. Shown to whoever asked, instead of a bare refusal. */
  agentReason?: string
  run?: () => void
}

const ui = (): ReturnType<typeof useUiStore.getState> => useUiStore.getState()

/**
 * Put a tab in the side panel, opening the panel if it is shut.
 *
 * Deliberately `setRightPanelOpen` rather than the toggle: this is always "show
 * me this", and a toggle would close the panel half the time.
 */
async function openWorkspaceTab(kind: NewTabKind): Promise<void> {
  const sessionId = useSessionsStore.getState().activeSessionId
  if (!sessionId) return
  ui().setRightPanelOpen(true)
  if (kind === 'file') useWorkspaceStore.getState().openFileTab(sessionId)
  else await startBrowserTab(sessionId)
}

/** A `flow.*` command only lands if the canvas is mounted and holding a flow. */
function flowIsOpen(): boolean {
  const { isCanvasOpen, currentWorkflow } = useWorkflowStore.getState()
  return isCanvasOpen && currentWorkflow !== null
}

function hasSession(): boolean {
  return useSessionsStore.getState().activeSessionId !== null
}

/** The PR this chat opened most recently, if it opened one. */
function newestPr(): PullRequest | null {
  const { sessions, activeSessionId } = useSessionsStore.getState()
  const prs = sessions.find((s) => s.id === activeSessionId)?.pullRequests ?? []
  return prs.length === 0 ? null : sortPrs(prs)[0]
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
    agent: false,
    agentReason:
      'Opening a palette the user did not ask for steals their focus.',
    label: 'Command palette',
    group: 'General',
    defaultChord: 'mod+k',
    run: () => ui().openPalette('all')
  },
  {
    id: 'palette.history',
    agent: false,
    agentReason:
      'Opening a palette the user did not ask for steals their focus.',
    label: 'Past prompts',
    group: 'General',
    defaultChord: 'mod+r',
    allowInInput: true,
    run: () => ui().openPalette('history')
  },
  {
    id: 'search.inSession',
    agent: false,
    agentReason:
      'The find bar takes keyboard focus away from the composer.',
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
    agent: false,
    agentReason:
      'Authentication is the user\'s to start.',
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
    agent: false,
    agentReason:
      'Switches the user away from the conversation they are reading.',
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
    agent: false,
    agentReason:
      'Destroys the transcript, including the request that asked for it.',
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
    agent: false,
    agentReason:
      'Cancels the running turn — the agent would be stopping itself.',
    label: 'Stop the current turn',
    group: 'Session',
    defaultChord: 'escape',
    // Escape has to reach this from inside the composer, which is where you are
    // when you decide to stop it.
    allowInInput: true,
    run: () => void window.api.claude.abort(useSessionsStore.getState().activeSessionId ?? undefined)
  },
  {
    // Unbound by default. Most chats have no PR at all, so a chord would sit
    // dead most of the time — but the chip is in the composer and the summary,
    // both of which can be closed, and this is a thing you reach for often
    // enough to want a name for.
    //
    // Newest first: a chat with several PRs is working through them, and the
    // last one it opened is the one it is on.
    id: 'session.pr.open',
    agent: false,
    agentReason: 'Opens a window in the user’s own browser, over whatever they were reading.',
    label: 'Open pull request',
    group: 'Session',
    defaultChord: null,
    icon: GitPullRequest,
    palette: true,
    available: () => newestPr() !== null,
    run: () => {
      const pr = newestPr()
      if (pr) void window.api.system.openExternal(pr.url)
    }
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
    run: () => ui().toggleProjectsPanel(),
    setState: (on) => ui().setProjectsPanelOpen(on),
    isOn: () => ui().projectsPanelOpen
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
    run: () => ui().toggleRightPanel(),
    setState: (on) => ui().setRightPanelOpen(on),
    isOn: () => ui().rightPanelOpen
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
    // Go to a file, rather than make somewhere to put one. ⌘P is the chord every
    // editor spends on this, and it was going to a blank tab with an "Open file"
    // empty state — the picker answers the question that tab was asking.
    id: 'file.quickOpen',
    label: 'Go to file',
    group: 'Panels',
    defaultChord: 'mod+p',
    icon: FileSearch,
    palette: true,
    available: hasSession,
    run: () => ui().openQuickOpen()
  },
  {
    // ⌘⇧O rather than the ⌘P it used to hold. A blank file tab is still worth
    // reaching — it is where the tree lives — but it is the rarer of the two.
    id: 'panel.right.file',
    label: 'New file tab',
    group: 'Panels',
    defaultChord: 'mod+shift+o',
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
    available: hasSession,
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
    // The chord every editor spends on the file explorer. There is a button for
    // it too; the binding is what the tooltip has been missing.
    id: 'panel.right.tree',
    label: 'Toggle file tree',
    group: 'Panels',
    defaultChord: 'mod+shift+e',
    icon: PanelRightOpen,
    palette: true,
    available: hasSession,
    run: () => {
      const sessionId = useSessionsStore.getState().activeSessionId
      if (!sessionId) return
      const store = useWorkspaceStore.getState()
      store.setTreeOpen(sessionId, !workspaceFor(store, sessionId).treeOpen)
    },
    setState: (on) => {
      const sessionId = useSessionsStore.getState().activeSessionId
      if (!sessionId) return
      useWorkspaceStore.getState().setTreeOpen(sessionId, on)
    },
    isOn: () => {
      const store = useWorkspaceStore.getState()
      const sessionId = useSessionsStore.getState().activeSessionId
      return sessionId ? workspaceFor(store, sessionId).treeOpen : false
    }
  },
  {
    // Alt+Z, the chord editors spend on soft wrap. It sits in View rather than
    // Composer because it is not about what you are writing: it is about how a
    // document someone else wrote is drawn.
    id: 'file.wrap',
    label: 'Toggle line wrap',
    group: 'View',
    defaultChord: 'alt+z',
    icon: WrapText,
    palette: true,
    run: () =>
      useSettingsStore
        .getState()
        .updateSettings({ fileWrap: !useSettingsStore.getState().fileWrap }),
    setState: (on) => useSettingsStore.getState().updateSettings({ fileWrap: on }),
    isOn: () => useSettingsStore.getState().fileWrap
  },
  {
    id: 'panel.bottom',
    label: 'Toggle terminal',
    group: 'Panels',
    defaultChord: 'mod+j',
    icon: SquareTerminal,
    palette: true,
    run: () => ui().toggleBottomPanel(),
    setState: (on) => ui().setBottomPanelOpen(on),
    isOn: () => ui().bottomPanelOpen
  },
  {
    id: 'panel.summary',
    label: 'Toggle summary',
    group: 'Panels',
    defaultChord: 'mod+shift+s',
    icon: TextQuote,
    palette: true,
    run: () => ui().toggleSummary(),
    setState: (on) => ui().setSummaryOpen(on),
    isOn: () => ui().summaryOpen
  },
  // The main area's pages. They were tabs over the rail's own body until the
  // rail became a permanent chat list; each is a chord because picking one is
  // the sort of thing you do between turns, not once a session.
  ...(
    [
      // Not mod+digit: the flow inspector's six panels hold those, and a
      // chord that means one thing on the canvas and another off it is worse
      // than a longer chord.
      ['view.chat', 'Chat', 'mod+shift+1', MessageSquare],
      ['view.skills', 'Skills', 'mod+shift+2', Sparkles],
      ['view.commands', 'Commands', 'mod+shift+3', Slash],
      ['view.memory', 'Memory', 'mod+shift+4', Brain],
      ['view.plugins', 'Plugins', 'mod+shift+5', Store],
      ['view.archived', 'Archived', 'mod+shift+6', Archive]
    ] as const
  ).map(([id, label, defaultChord, icon]) => ({
    id,
    label: `Open ${label}`,
    group: 'Panels' as const,
    defaultChord,
    icon,
    palette: true,
    run: () => {
      // Flows replaces the same area, so opening a page has to close it or the
      // page is chosen and then not shown.
      useWorkflowStore.getState().closeCanvas()
      ui().setMainView(id.slice('view.'.length) as MainView)
    }
  })),
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
    },
    setState: (on) => {
      const { openCanvas, closeCanvas } = useWorkflowStore.getState()
      if (on) openCanvas()
      else closeCanvas()
    },
    isOn: () => useWorkflowStore.getState().isCanvasOpen
  },

  {
    id: 'flow.run',
    label: 'Run this flow',
    group: 'Panels',
    defaultChord: 'mod+enter',
    icon: Play,
    palette: true,
    available: flowIsOpen,
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
    available: flowIsOpen,
    run: () => window.dispatchEvent(new Event('nyra:flow-add-node'))
  },
  {
    id: 'flow.panel.details',
    label: 'Flow details',
    group: 'Panels',
    defaultChord: 'mod+1',
    icon: Info,
    palette: true,
    available: flowIsOpen,
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
    available: flowIsOpen,
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
    available: flowIsOpen,
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
    available: flowIsOpen,
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
    available: flowIsOpen,
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
    available: flowIsOpen,
    run: () => window.dispatchEvent(new Event('nyra:flow-panel-triggers'))
  },
  {
    id: 'flow.arrange',
    label: 'Arrange nodes top to bottom',
    group: 'Panels',
    defaultChord: null,
    icon: LayoutGrid,
    palette: true,
    available: flowIsOpen,
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
    available: flowIsOpen,
    run: () => window.dispatchEvent(new Event('nyra:flow-stop'))
  },

  // ---- View --------------------------------------------------------------
  {
    id: 'chat.planMode',
    agent: false,
    agentReason:
      'Plan mode is part of the spawn fingerprint, so changing it kills and respawns the running CLI child mid-reply.',
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
  // Theme had no command at all — it was reachable only through Settings →
  // Appearance. Three entries rather than one toggle because the preference is
  // tri-state, and "system" is the one people forget they can go back to.
  {
    id: 'app.theme.light',
    label: 'Light theme',
    group: 'View',
    defaultChord: null,
    icon: Sun,
    palette: true,
    run: () => useSettingsStore.getState().updateSettings({ theme: 'light' })
  },
  {
    id: 'app.theme.dark',
    label: 'Dark theme',
    group: 'View',
    defaultChord: null,
    icon: Moon,
    palette: true,
    run: () => useSettingsStore.getState().updateSettings({ theme: 'dark' })
  },
  {
    id: 'app.theme.system',
    label: 'Match system theme',
    group: 'View',
    defaultChord: null,
    icon: Monitor,
    palette: true,
    run: () => useSettingsStore.getState().updateSettings({ theme: 'system' })
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
  {
    id: 'composer.dictate',
    // The app MCP layer lets Claude run registry commands. Switching on the
    // user's microphone is not something it gets to decide.
    agent: false,
    agentReason: 'Claude does not turn on the microphone.',
    label: 'Dictate',
    group: 'Composer',
    // Unbound on purpose: discoverable in the palette and bindable in
    // Settings, without spending a chord on it up front.
    defaultChord: null,
    icon: Mic,
    palette: true,
    // The composer has focus when you reach for this.
    allowInInput: true,
    run: () => window.dispatchEvent(new Event('nyra:dictate-toggle'))
  },
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

// ---------------------------------------------------------------------------
// Running one by name
// ---------------------------------------------------------------------------
//
// Until now the registry was a lookup table with two hard-wired callers — the
// keyboard and the palette — both reaching straight for `command.run()`. Naming
// the dispatch is what lets anything else drive the app without a third copy of
// the rules about what is runnable.

export type CommandOutcome =
  | { ok: true; id: CommandId; label: string; state?: boolean }
  | { ok: false; id: string; error: string }

/** Commands something other than a person may run, with their current state. */
export type CommandInfo = {
  id: CommandId
  label: string
  group: CommandGroup
  /** Present only on the ones that can be set rather than flipped. */
  state?: boolean
  available: boolean
}

function isRunnable(c: Command): boolean {
  return !c.readOnly && typeof c.run === 'function'
}

/**
 * What an agent is allowed to see. Anything inert is left out rather than
 * listed and refused — a catalogue you cannot act on is noise — but a command
 * that is merely *unavailable right now* stays, with `available: false`, because
 * the fix is usually one other command away.
 */
export function agentCommands(): CommandInfo[] {
  return COMMANDS.filter((c) => isRunnable(c) && c.agent !== false).map((c) => ({
    id: c.id,
    label: c.label,
    group: c.group,
    ...(c.isOn ? { state: c.isOn() } : {}),
    available: c.available?.() ?? true
  }))
}

/**
 * Near misses for an id nobody has.
 *
 * Scored over the label as well as the id, because the plausible wrong guess is
 * plausible *because* it uses the word on screen: "panel.terminal" shares
 * nothing with `panel.bottom` but everything with its label, "Toggle terminal".
 */
function suggest(id: string): string {
  const words = id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length) return ''
  const scored = COMMANDS.filter(isRunnable)
    .map((c) => {
      const haystack = `${c.id} ${c.label}`.toLowerCase()
      return { id: c.id, score: words.filter((w) => haystack.includes(w)).length }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  return scored.length ? ` Did you mean: ${scored.map((c) => c.id).join(', ')}?` : ''
}

/**
 * Run a command by id.
 *
 * `on` is an intent rather than a flip: pass it and a command that knows how to
 * be set outright is set, so "open the terminal" cannot close it. Pass nothing
 * and it behaves exactly as the key does.
 *
 * `agent` gates the denylist. The keyboard and the palette pass `false` — a
 * person pressing the key is always allowed, and the whole point of the denials
 * is that they apply to callers that are not one.
 */
export function runCommand(
  id: string,
  opts: { on?: boolean; agent?: boolean } = {}
): CommandOutcome {
  const command = COMMANDS_BY_ID.get(id as CommandId)
  if (!command) {
    return { ok: false, id, error: `Unknown command '${id}'.${suggest(id)}` }
  }
  if (!isRunnable(command)) {
    return {
      ok: false,
      id,
      error: `'${id}' is registered for reference only — it is owned by the surface that implements it and cannot be run from here.`
    }
  }
  if (opts.agent && command.agent === false) {
    return { ok: false, id, error: command.agentReason ?? `'${id}' is not available to an agent.` }
  }
  if (command.available?.() === false) {
    return {
      ok: false,
      id,
      error: id.startsWith('flow.')
        ? `'${id}' needs the Flows view open with a flow loaded. Run 'panel.canvas' and open a flow first.`
        : `'${id}' is not available right now.`
    }
  }

  if (opts.on !== undefined && command.setState) command.setState(opts.on)
  else command.run!()

  return {
    ok: true,
    id: command.id,
    label: command.label,
    ...(command.isOn ? { state: command.isOn() } : {})
  }
}

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
