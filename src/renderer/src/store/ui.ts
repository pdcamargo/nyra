import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSessionsStore } from './sessions'

/** The left rail's tabs in Chat mode. In the store rather than in Sidebar,
 *  because opening a memory file from elsewhere has to be able to bring that tab
 *  forward. Flows used to be one of these; it is a view mode now, because a rail
 *  full of chat tabs is no use while you are looking at a graph. */
/**
 * What fills the main area.
 *
 * These used to be tabs over the rail's own body — picking Skills replaced the
 * chat list with a 256px-wide column of them. They are pages now: the rail
 * keeps the chats visible at all times and the choice changes what sits beside
 * it, which is what a person means by picking Skills.
 */
export type MainView = 'chat' | 'skills' | 'commands' | 'memory' | 'archived' | 'plugins'

/** Settings' left nav. Exported so anything that deep-links into a pane names a
 *  tab rather than firing a window event and hoping. */
export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'model'
  | 'permissions'
  | 'shortcuts'
  | 'mcp'
  | 'advanced'
  | 'about'

type UiStore = {
  mainView: MainView
  /** Project selected when opening Archived from a project menu. */
  archivedProjectId: string | null
  /** Set by the one check at launch. Null until it answers, and when it says no. */
  updateAvailable: string | null
  pendingMemoryFilePath: string | null
  pendingInputPrefill: string | null
  bottomPanelOpen: boolean
  bottomPanelFocusNonce: number
  /** The projects rail. The title bar toggles it; Codex hides it the same way. */
  projectsPanelOpen: boolean
  /** The right panel: a workspace whose strip holds browser tabs and file tabs
   *  side by side. It used to carry agents, context, MCP and memory tabs, with
   *  the browser fighting them for the same strip of window and a second
   *  title-bar button that could close it out from under you. Agents and context
   *  said what the summary already says, MCP is configuration, memory is a
   *  library and lives in the left rail. What is left is one panel behind one
   *  button, and what is *in* it is the tab strip's business. */
  rightPanelOpen: boolean
  /** The conversation's own environment. Spec calls it the Pinned Summary, but
   *  "pinned" now means something else in the sidebar, so it is just Summary.
   *  Both panels can be open at once; they answer different questions.
   *
   *  Open by default: it is the answer to "what is this chat doing", which is
   *  the question you have when you arrive at one. */
  summaryOpen: boolean
  /** Settings lives in the title bar now, so its open state cannot sit in Chat. */
  settingsOpen: boolean
  /** Which pane Settings opens on. Survives a close so reopening lands where you
   *  left off, which is what every settings window does. */
  settingsTab: SettingsTab
  /** The command palette. `mode` seeds the query so ⌃R lands straight in history. */
  paletteOpen: boolean
  paletteMode: 'all' | 'history'
  quickOpenOpen: boolean
  setMainView: (view: MainView) => void
  openArchived: (projectId?: string | null) => void
  setUpdateAvailable: (version: string | null) => void
  openMemoryFile: (filePath: string) => void
  consumePendingMemoryFile: () => void
  prefillInput: (text: string) => void
  consumeInputPrefill: () => string | null
  setBottomPanelOpen: (open: boolean) => void
  toggleBottomPanel: () => void
  focusProcessesTab: () => void
  toggleRightPanel: () => void
  /** Open or close it outright. Anything acting on "show me this" wants this
   *  rather than the toggle, which would close the panel half the time. */
  setRightPanelOpen: (open: boolean) => void
  toggleSummary: () => void
  /** Same bargain as `setRightPanelOpen`: an agent asked to *open* the summary
   *  must not close it because it happened to be open already. */
  setSummaryOpen: (open: boolean) => void
  toggleProjectsPanel: () => void
  setProjectsPanelOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /** Open Settings, optionally straight to a pane. Replaces the
   *  `nyra:open-permissions` window event and the modal it used to summon. */
  openSettings: (tab?: SettingsTab) => void
  setSettingsTab: (tab: SettingsTab) => void
  openPalette: (mode?: 'all' | 'history') => void
  closePalette: () => void
  openQuickOpen: () => void
  closeQuickOpen: () => void
}

/**
 * Record a panel change against the conversation it was made in.
 *
 * The store keeps the live value — everything reads it from here — and the
 * session keeps what that chat was last left at. A chat with nothing recorded
 * inherits whatever you last used, which is what makes opening a new one feel
 * like carrying on rather than starting over.
 */
function rememberPanels(partial: { right?: boolean; summary?: boolean; rightWidth?: number }): void {
  const { activeSessionId, setSessionPanels } = useSessionsStore.getState()
  if (activeSessionId) setSessionPanels(activeSessionId, partial)
}

/** Load a conversation's panel state, falling back to the current one. */
export function applySessionPanels(sessionId: string | null): void {
  const store = useUiStore.getState()
  if (!sessionId) return
  const panels = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.panels
  useUiStore.setState({
    rightPanelOpen: panels?.right ?? store.rightPanelOpen,
    summaryOpen: panels?.summary ?? store.summaryOpen
  })
  if (panels?.rightWidth) {
    // Imported lazily: panelSizes recomputes the layout on write, and pulling it
    // in at module scope would make ui.ts part of that cycle.
    void import('./panelSizes').then(({ usePanelSizesStore }) =>
      usePanelSizesStore.getState().setSize('rightPanelWidth', panels.rightWidth!)
    )
  }
}

export const useUiStore = create<UiStore>()(persist((set, get) => ({
  mainView: 'chat',
  archivedProjectId: null,
  updateAvailable: null,
  pendingMemoryFilePath: null,
  pendingInputPrefill: null,
  bottomPanelOpen: false,
  bottomPanelFocusNonce: 0,
  projectsPanelOpen: true,
  rightPanelOpen: true,
  summaryOpen: true,
  settingsOpen: false,
  settingsTab: 'general',
  paletteOpen: false,
  paletteMode: 'all',
  quickOpenOpen: false,
  setMainView: (mainView) => set({ mainView }),
  openArchived: (projectId = null) => set({ mainView: 'archived', archivedProjectId: projectId }),
  setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),
  openMemoryFile: (filePath) =>
    set({ mainView: 'memory', pendingMemoryFilePath: filePath, projectsPanelOpen: true }),
  consumePendingMemoryFile: () => set({ pendingMemoryFilePath: null }),
  prefillInput: (text) => set({ pendingInputPrefill: text }),
  consumeInputPrefill: () => {
    const value = get().pendingInputPrefill
    set({ pendingInputPrefill: null })
    return value
  },
  setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  focusProcessesTab: () =>
    set((s) => ({
      bottomPanelOpen: true,
      bottomPanelFocusNonce: s.bottomPanelFocusNonce + 1
    })),
  toggleRightPanel: () =>
    set((s) => {
      const rightPanelOpen = !s.rightPanelOpen
      rememberPanels({ right: rightPanelOpen })
      return { rightPanelOpen }
    }),
  setRightPanelOpen: (rightPanelOpen) =>
    set((s) => {
      if (s.rightPanelOpen === rightPanelOpen) return s
      rememberPanels({ right: rightPanelOpen })
      return { rightPanelOpen }
    }),
  toggleSummary: () =>
    set((s) => {
      const summaryOpen = !s.summaryOpen
      rememberPanels({ summary: summaryOpen })
      return { summaryOpen }
    }),
  setSummaryOpen: (summaryOpen) =>
    set((s) => {
      if (s.summaryOpen === summaryOpen) return s
      rememberPanels({ summary: summaryOpen })
      return { summaryOpen }
    }),
  toggleProjectsPanel: () => set((s) => ({ projectsPanelOpen: !s.projectsPanelOpen })),
  setProjectsPanelOpen: (projectsPanelOpen) => set({ projectsPanelOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (tab) => set(tab ? { settingsOpen: true, settingsTab: tab } : { settingsOpen: true }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  openPalette: (paletteMode = 'all') => set({ paletteOpen: true, paletteMode }),
  closePalette: () => set({ paletteOpen: false }),
  // Two pickers, one at a time: opening either from the other's input should
  // not leave both mounted, both trapping focus.
  openQuickOpen: () => set({ quickOpenOpen: true, paletteOpen: false }),
  closeQuickOpen: () => set({ quickOpenOpen: false })
}), {
  name: 'nyra-ui',
  // Only the panels. `paletteOpen`, `settingsOpen` and `pendingInputPrefill`
  // have no business surviving a restart, which is why this store was left
  // unpersisted entirely until the panel state needed to outlive a launch.
  partialize: (s) => ({
    rightPanelOpen: s.rightPanelOpen,
    summaryOpen: s.summaryOpen,
    projectsPanelOpen: s.projectsPanelOpen
  })
}))
