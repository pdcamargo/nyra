import { create } from 'zustand'

export type RightPanelTab = 'agents' | 'context' | 'mcp' | 'memory'

/** What the right panel is showing. The browser takes the whole panel rather
 *  than becoming a fifth tab: it has its own tab strip, and nesting one strip
 *  inside another reads as a mistake. */
export type RightPanelMode = 'workspace' | 'browser'

type UiStore = {
  rightPanelTab: RightPanelTab
  rightPanelMode: RightPanelMode
  pendingMemoryFilePath: string | null
  pendingInputPrefill: string | null
  bottomPanelOpen: boolean
  bottomPanelFocusNonce: number
  /** The projects rail. The title bar toggles it; Codex hides it the same way. */
  projectsPanelOpen: boolean
  /** The workspace panel — agents, context, MCP, memory — or the browser,
   *  depending on `rightPanelMode`. */
  rightPanelOpen: boolean
  /** The conversation's own environment. Spec calls it the Pinned Summary, but
   *  "pinned" now means something else in the sidebar, so it is just Summary.
   *  Both panels can be open at once; they answer different questions. */
  summaryOpen: boolean
  /** Settings lives in the title bar now, so its open state cannot sit in Chat. */
  settingsOpen: boolean
  /** The command palette. `mode` seeds the query so ⌃R lands straight in history. */
  paletteOpen: boolean
  paletteMode: 'all' | 'history'
  setRightPanelTab: (tab: RightPanelTab) => void
  openMemoryFile: (filePath: string) => void
  consumePendingMemoryFile: () => void
  prefillInput: (text: string) => void
  consumeInputPrefill: () => string | null
  setBottomPanelOpen: (open: boolean) => void
  toggleBottomPanel: () => void
  focusProcessesTab: () => void
  toggleRightPanel: () => void
  toggleBrowserPanel: () => void
  toggleSummary: () => void
  toggleProjectsPanel: () => void
  setSettingsOpen: (open: boolean) => void
  openPalette: (mode?: 'all' | 'history') => void
  closePalette: () => void
}

export const useUiStore = create<UiStore>()((set, get) => ({
  rightPanelTab: 'agents',
  rightPanelMode: 'workspace',
  pendingMemoryFilePath: null,
  pendingInputPrefill: null,
  bottomPanelOpen: false,
  bottomPanelFocusNonce: 0,
  projectsPanelOpen: true,
  rightPanelOpen: true,
  summaryOpen: false,
  settingsOpen: false,
  paletteOpen: false,
  paletteMode: 'all',
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  openMemoryFile: (filePath) =>
    set({ rightPanelTab: 'memory', pendingMemoryFilePath: filePath }),
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
  // Each title-bar button owns one surface, so "active" can mean "this is what
  // you are looking at". Pressing Workspace while the browser is up shows the
  // workspace rather than closing the panel out from under you.
  toggleRightPanel: () =>
    set((s) =>
      s.rightPanelOpen && s.rightPanelMode === 'browser'
        ? { rightPanelMode: 'workspace' }
        : { rightPanelOpen: !s.rightPanelOpen, rightPanelMode: 'workspace' }
    ),
  toggleBrowserPanel: () =>
    set((s) =>
      s.rightPanelOpen && s.rightPanelMode === 'browser'
        ? { rightPanelMode: 'workspace' }
        : { rightPanelOpen: true, rightPanelMode: 'browser' }
    ),
  toggleSummary: () => set((s) => ({ summaryOpen: !s.summaryOpen })),
  toggleProjectsPanel: () => set((s) => ({ projectsPanelOpen: !s.projectsPanelOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openPalette: (paletteMode = 'all') => set({ paletteOpen: true, paletteMode }),
  closePalette: () => set({ paletteOpen: false })
}))
