import { create } from 'zustand'

export type TerminalTab = {
  id: string
  title: string
  /** The workspace the shell was started under. Its environment — and so the
   *  account a `claude` typed in it uses — was fixed then, so after its project
   *  moves this is how the tab knows it is still on the old one. */
  workspaceId: string
}

/**
 * Where the terminals of chats without a project live: one bucket per
 * workspace. A single shared one would show a shell signed in to one account
 * after switching to another.
 */
export function noProjectBucket(workspaceId: string): string {
  return `__no_project__:${workspaceId}`
}

/** The bucket a chat's terminals belong to: its project's, else its workspace's. */
export function terminalBucket(projectId: string | null | undefined, workspaceId: string): string {
  return projectId ?? noProjectBucket(workspaceId)
}

type PanelState = { tabs: TerminalTab[]; activeTabId: string | null }

const EMPTY: PanelState = { tabs: [], activeTabId: null }

/**
 * Terminal tabs, one set per project — or per workspace, for chats without one.
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
  /** Keyed by project id, or by `noProjectBucket(workspaceId)`. */
  byProject: Record<string, PanelState>
  /** A new tab in `bucket`, started under `workspaceId`. */
  createTerminal: (bucket: string, workspaceId: string) => string
  closeTerminal: (bucket: string, id: string) => void
  setActiveTab: (bucket: string, id: string | null) => void
  setTabs: (bucket: string, tabs: TerminalTab[]) => void
  /** Kill every terminal of a project and forget it. Returns the ids to kill. */
  dropProject: (bucket: string) => string[]
  /**
   * Close every tab started under `workspaceId`, in whatever bucket — its
   * projects', its no-project one, and a moved project's older shells. For a
   * workspace being deleted: a shell left open would recreate its directory the
   * next time `claude` ran in it. Returns the ids to kill.
   */
  closeStartedUnder: (workspaceId: string) => string[]
}

let counter = 0

/** Namespaced so a project's terminals can never be confused with another's. */
export function terminalId(bucket: string): string {
  counter += 1
  return `term:${bucket}:${Date.now().toString(36)}-${counter}`
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  byProject: {},

  createTerminal: (bucket, workspaceId) => {
    const id = terminalId(bucket)
    set((state) => {
      const panel = state.byProject[bucket] ?? EMPTY
      return {
        byProject: {
          ...state.byProject,
          [bucket]: {
            tabs: [...panel.tabs, { id, title: `Terminal ${panel.tabs.length + 1}`, workspaceId }],
            activeTabId: id
          }
        }
      }
    })
    return id
  },

  closeTerminal: (bucket, id) => {
    set((state) => {
      const panel = state.byProject[bucket] ?? EMPTY
      const tabs = panel.tabs.filter((t) => t.id !== id)
      const activeTabId =
        panel.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : panel.activeTabId
      return { byProject: { ...state.byProject, [bucket]: { tabs, activeTabId } } }
    })
  },

  setActiveTab: (bucket, id) => {
    set((state) => {
      const panel = state.byProject[bucket] ?? EMPTY
      return { byProject: { ...state.byProject, [bucket]: { ...panel, activeTabId: id } } }
    })
  },

  setTabs: (bucket, tabs) => {
    set((state) => {
      const panel = state.byProject[bucket] ?? EMPTY
      return { byProject: { ...state.byProject, [bucket]: { ...panel, tabs } } }
    })
  },

  dropProject: (bucket) => {
    const ids = (get().byProject[bucket] ?? EMPTY).tabs.map((t) => t.id)
    set((state) => {
      const byProject = { ...state.byProject }
      delete byProject[bucket]
      return { byProject }
    })
    return ids
  },

  closeStartedUnder: (workspaceId) => {
    const closed: string[] = []
    const byProject: Record<string, PanelState> = {}
    for (const [bucket, panel] of Object.entries(get().byProject)) {
      const tabs = panel.tabs.filter((t) => {
        if (t.workspaceId !== workspaceId) return true
        closed.push(t.id)
        return false
      })
      if (bucket === noProjectBucket(workspaceId)) continue
      const activeTabId = tabs.some((t) => t.id === panel.activeTabId)
        ? panel.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null)
      byProject[bucket] = { tabs, activeTabId }
    }
    set({ byProject })
    return closed
  }
}))

export function panelFor(state: TerminalsState, bucket: string): PanelState {
  return state.byProject[bucket] ?? EMPTY
}
