import { create } from 'zustand'

export type TerminalTab = { id: string; title: string }

/** Rendered when a chat has no project — terminals still need somewhere to live. */
export const NO_PROJECT = '__no_project__'

type PanelState = { tabs: TerminalTab[]; activeTabId: string | null }

const EMPTY: PanelState = { tabs: [], activeTabId: null }

/**
 * Terminal tabs, one set per project.
 *
 * They used to be `useState` inside `BottomPanel`, which meant two things: they
 * were bound to whichever chat was active, and — because `App` unmounts the panel
 * when it closes — every tab died on ⌘J. Keying by project fixes the first and
 * lifting the state out fixes the second.
 *
 * Not persisted: a PTY does not survive a reload, so restoring tab rows would
 * show terminals with nothing behind them.
 */
interface TerminalsState {
  byProject: Record<string, PanelState>
  createTerminal: (projectId: string) => string
  closeTerminal: (projectId: string, id: string) => void
  setActiveTab: (projectId: string, id: string | null) => void
  setTabs: (projectId: string, tabs: TerminalTab[]) => void
  /** Kill every terminal of a project and forget it. Returns the ids to kill. */
  dropProject: (projectId: string) => string[]
}

let counter = 0

/** Namespaced so a project's terminals can never be confused with another's. */
export function terminalId(projectId: string): string {
  counter += 1
  return `term:${projectId}:${Date.now().toString(36)}-${counter}`
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  byProject: {},

  createTerminal: (projectId) => {
    const id = terminalId(projectId)
    set((state) => {
      const panel = state.byProject[projectId] ?? EMPTY
      return {
        byProject: {
          ...state.byProject,
          [projectId]: {
            tabs: [...panel.tabs, { id, title: `Terminal ${panel.tabs.length + 1}` }],
            activeTabId: id
          }
        }
      }
    })
    return id
  },

  closeTerminal: (projectId, id) => {
    set((state) => {
      const panel = state.byProject[projectId] ?? EMPTY
      const tabs = panel.tabs.filter((t) => t.id !== id)
      const activeTabId =
        panel.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : panel.activeTabId
      return { byProject: { ...state.byProject, [projectId]: { tabs, activeTabId } } }
    })
  },

  setActiveTab: (projectId, id) => {
    set((state) => {
      const panel = state.byProject[projectId] ?? EMPTY
      return { byProject: { ...state.byProject, [projectId]: { ...panel, activeTabId: id } } }
    })
  },

  setTabs: (projectId, tabs) => {
    set((state) => {
      const panel = state.byProject[projectId] ?? EMPTY
      return { byProject: { ...state.byProject, [projectId]: { ...panel, tabs } } }
    })
  },

  dropProject: (projectId) => {
    const ids = (get().byProject[projectId] ?? EMPTY).tabs.map((t) => t.id)
    set((state) => {
      const byProject = { ...state.byProject }
      delete byProject[projectId]
      return { byProject }
    })
    return ids
  }
}))

export function panelFor(state: TerminalsState, projectId: string): PanelState {
  return state.byProject[projectId] ?? EMPTY
}
