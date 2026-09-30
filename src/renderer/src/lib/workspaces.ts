/**
 * Workspaces, where they meet the rest of the app.
 *
 * The workspaces store knows the list and which one is active; the sessions
 * store knows which project and chat belong where. What spans the two — which
 * chat to open on a switch, keeping the active workspace in step with the chat
 * on screen, telling Rust which account each project's flows run under — lives
 * here, so neither store has to import the other's behaviour.
 */
import {
  DEFAULT_WORKSPACE_ID,
  configDirOf,
  findWorkspace,
  useWorkspacesStore,
  type Workspace
} from '../store/workspaces'
import {
  activeSession,
  findProject,
  findSession,
  liveSessions,
  useSessionsStore,
  workspaceIdOf
} from '../store/sessions'
import { useAccountsStore } from '../store/accounts'
import type { ConfigDir } from './api-types'
import { homedir } from './homedir'
import { isWithin, relativeTo } from './paths'

/**
 * What the rail shows for a workspace with no picture: the first character of
 * each of its first two words. "Default" is D, "Media Valet" is MV.
 *
 * By grapheme, not by UTF-16 unit, so "🦊 Den" is 🦊D rather than half an
 * emoji, and a letter with a combining accent keeps it.
 */
export function initials(name: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => {
      const first = segmenter.segment(word)[Symbol.iterator]().next()
      return first.done ? '' : first.value.segment.toLocaleUpperCase()
    })
    .join('')
}

/**
 * The chat to open in `workspaceId`: the one it last had open, if that is still
 * there and still its own, else its most recent. `null` when it has none.
 */
export function chatToOpen(workspaceId: string): string | null {
  const state = useSessionsStore.getState()
  const mine = liveSessions(state.sessions).filter((s) => workspaceIdOf(state, s) === workspaceId)
  const remembered = useWorkspacesStore.getState().lastSessionById[workspaceId]
  if (remembered && mine.some((s) => s.id === remembered)) return remembered
  // Newest first: that is the order chats are made in and stored.
  return mine[0]?.id ?? null
}

/**
 * Make `id` the active workspace. Its projects and Recents replace the rail's,
 * and its last chat comes back. Chats running in the one you left keep running:
 * each is its own process, with its own account fixed when it started.
 */
export function switchWorkspace(id: string): void {
  const workspaces = useWorkspacesStore.getState()
  if (id === workspaces.activeId || !findWorkspace(id)) return
  workspaces.setActive(id)
  const sessions = useSessionsStore.getState()
  const next = chatToOpen(id)
  if (next) sessions.setActiveSession(next)
  else sessions.clearActiveSession()
  void useAccountsStore.getState().refresh(id)
}

/** The next or previous workspace in rail order, wrapping. */
export function cycleWorkspace(step: 1 | -1): void {
  const { workspaces, activeId } = useWorkspacesStore.getState()
  if (workspaces.length < 2) return
  const at = workspaces.findIndex((w) => w.id === activeId)
  switchWorkspace(workspaces[(at + step + workspaces.length) % workspaces.length].id)
}

/**
 * A new workspace: its config dir made in Rust, then added and switched to.
 * Signing its account in is the caller's next step — see `openLogin`.
 */
export async function createWorkspace(name: string, image?: string): Promise<Workspace> {
  const id = crypto.randomUUID()
  const result = await window.api.workspace.create(id)
  if (!result.configDir) throw new Error(result.error ?? 'Could not create the workspace.')
  const workspace: Workspace = { id, name: name.trim(), configDir: result.configDir, ...(image ? { image } : {}) }
  useWorkspacesStore.getState().add(workspace)
  switchWorkspace(id)
  return workspace
}

/**
 * Move a project — and so its chats, terminals and flows — to another workspace.
 *
 * Nothing running is interrupted. An idle chat respawns under the new account
 * on its next send (its config dir is part of the spawn fingerprint) and brings
 * its transcript along; a turn in flight finishes where it started.
 *
 * You stay where you are. If the chat on screen was in that project, another
 * chat of this workspace opens in its place rather than following it across.
 */
export function moveProjectToWorkspace(projectId: string, workspaceId: string): void {
  const sessions = useSessionsStore.getState()
  const project = findProject(sessions, projectId)
  if (!project || project.workspaceId === workspaceId || !findWorkspace(workspaceId)) return
  const here = useWorkspacesStore.getState().activeId
  const leaving = activeSession(sessions)?.projectId === projectId && workspaceId !== here
  sessions.moveProjectToWorkspace(projectId, workspaceId)
  if (!leaving) return
  const next = chatToOpen(here)
  if (next) useSessionsStore.getState().setActiveSession(next)
  else useSessionsStore.getState().clearActiveSession()
}

/** Open the sign-in window for one workspace's account. */
export function openLogin(workspaceId: string = useWorkspacesStore.getState().activeId): void {
  window.dispatchEvent(new CustomEvent('nyra:open-login', { detail: { workspaceId } }))
}

/**
 * `~/.claude`, or where a workspace keeps its own, said the same way — for
 * labels, not for paths. Written with `/` on every OS so it reads like
 * Default's beside it.
 */
export function claudeDirLabel(configDir: ConfigDir): string {
  if (!configDir) return '~/.claude'
  const home = homedir()
  if (!home || !isWithin(home, configDir)) return configDir
  return `~/${relativeTo(home, configDir).replace(/\\/g, '/')}`
}

// ---- keeping things in step ----

/** What Rust was last told, so an unchanged rail does not rewrite the file. */
let synced = new Map<string, ConfigDir>()
let syncTimer: ReturnType<typeof setTimeout> | null = null

/** Tell Rust which account each project's flows run under. See `workspaces.rs`. */
function syncProjectsSoon(): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    const projects: Record<string, ConfigDir> = {}
    for (const p of useSessionsStore.getState().projects) projects[p.id] = configDirOf(p.workspaceId)
    const removed = [...synced.keys()].filter((id) => !(id in projects))
    const changed =
      removed.length > 0 ||
      Object.entries(projects).some(([id, dir]) => !synced.has(id) || synced.get(id) !== dir)
    if (!changed) return
    synced = new Map(Object.entries(projects))
    void window.api.workspace.syncProjects(projects, removed).catch(() => {
      // Retried on the next change; a flow meanwhile runs under the last map.
      synced = new Map()
    })
  }, 250)
}

/**
 * Start everything that follows the stores. Once, after the sessions store has
 * hydrated — before that there is no telling which chat belongs where.
 *
 * - Opening a chat of another workspace (the palette, a fork, anything that
 *   sets the active chat) makes that workspace active, and every chat opened is
 *   remembered as its workspace's last.
 * - Rust hears about every project's workspace, for flows a trigger starts.
 * - The active workspace's account is asked who it is.
 */
export function installWorkspaceFollowers(): () => void {
  // A launch reopens the workspace you left. The chat restored with the
  // sessions store is normally one of its own; if not, the workspace wins.
  const state = useSessionsStore.getState()
  const current = activeSession(state)
  const active = useWorkspacesStore.getState().activeId
  if (current && workspaceIdOf(state, current) !== active) {
    const next = chatToOpen(active)
    if (next) state.setActiveSession(next)
    else state.clearActiveSession()
  }

  const offSessions = useSessionsStore.subscribe((now, before) => {
    if (now.activeSessionId && now.activeSessionId !== before.activeSessionId) {
      const session = findSession(now, now.activeSessionId)
      if (session) {
        const workspaceId = workspaceIdOf(now, session)
        const workspaces = useWorkspacesStore.getState()
        workspaces.rememberSession(workspaceId, session.id)
        if (workspaceId !== workspaces.activeId && findWorkspace(workspaceId)) {
          workspaces.setActive(workspaceId)
          void useAccountsStore.getState().refresh(workspaceId)
        }
      }
    }
    if (now.projects !== before.projects) syncProjectsSoon()
  })
  const offWorkspaces = useWorkspacesStore.subscribe((now, before) => {
    if (now.workspaces !== before.workspaces) syncProjectsSoon()
  })

  syncProjectsSoon()
  void useAccountsStore.getState().refresh(useWorkspacesStore.getState().activeId ?? DEFAULT_WORKSPACE_ID)

  return () => {
    offSessions()
    offWorkspaces()
    if (syncTimer) clearTimeout(syncTimer)
  }
}
