import type React from 'react'
import {
  ClipboardCopy,
  Eraser,
  FolderPlus,
  Globe,
  LogIn,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  Plus,
  Receipt,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Target,
  TextQuote,
  Workflow
} from 'lucide-react'
import type { Chord } from '../lib/keys'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useWorkflowStore } from '../store/workflow'
import { createSiblingSession, openFolderAsProject, useSessionsStore } from '../store/sessions'

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
  | 'panel.bottom'
  | 'panel.summary'
  | 'panel.canvas'
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
    label: 'Toggle browser',
    group: 'Panels',
    defaultChord: 'mod+shift+b',
    icon: Globe,
    palette: true,
    run: () => ui().toggleRightPanel()
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
    label: 'Toggle workflow canvas',
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
