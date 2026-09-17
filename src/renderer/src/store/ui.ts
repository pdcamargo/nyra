import { create } from 'zustand'

export type RightPanelTab = 'agents' | 'context' | 'mcp' | 'memory'

type UiStore = {
  rightPanelTab: RightPanelTab
  pendingMemoryFilePath: string | null
  pendingInputPrefill: string | null
  bottomPanelOpen: boolean
  bottomPanelFocusNonce: number
  /** The projects rail. The title bar toggles it; Codex hides it the same way. */
  projectsPanelOpen: boolean
  /** The workspace panel — agents, context, MCP, memory. */
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
  toggleSummary: () => void
  toggleProjectsPanel: () => void
  setSettingsOpen: (open: boolean) => void
  openPalette: (mode?: 'all' | 'history') => void
  closePalette: () => void
}

export const useUiStore = create<UiStore>()((set, get) => ({
  rightPanelTab: 'agents',
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
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  toggleSummary: () => set((s) => ({ summaryOpen: !s.summaryOpen })),
  toggleProjectsPanel: () => set((s) => ({ projectsPanelOpen: !s.projectsPanelOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openPalette: (paletteMode = 'all') => set({ paletteOpen: true, paletteMode }),
  closePalette: () => set({ paletteOpen: false })
}))
