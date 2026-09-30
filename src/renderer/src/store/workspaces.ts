import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ConfigDir } from '../lib/api-types'

/** The workspace that is Claude's own `~/.claude`. It always exists and is always first. */
export const DEFAULT_WORKSPACE_ID = 'default'

/**
 * One Claude account: its own login, settings, skills, plugins and transcripts,
 * kept apart from every other by `CLAUDE_CONFIG_DIR`.
 *
 * Projects and project-less chats belong to one. Every `claude` a chat,
 * terminal, flow or login starts runs under its workspace's `configDir`, fixed
 * for that process's life — so switching workspaces never touches anything
 * already running.
 */
export type Workspace = {
  id: string
  name: string
  /** A 128px square PNG data URL, made when the picture was picked. The source
   *  file is never kept: moving or deleting it must not blank the rail. */
  image?: string
  /** `CLAUDE_CONFIG_DIR`, from Rust. `null` for Default: nothing is set, which
   *  is exactly the `~/.claude` every build before workspaces used. */
  configDir: ConfigDir
}

const DEFAULT_WORKSPACE: Workspace = { id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null }

type WorkspacesState = {
  workspaces: Workspace[]
  activeId: string
  /** The chat each workspace last had open, so switching back lands on it. */
  lastSessionById: Record<string, string>
  add: (workspace: Workspace) => void
  update: (id: string, patch: Partial<Pick<Workspace, 'name' | 'image'>>) => void
  /** Drops the record. Default is refused. The directory, the account and the
   *  chats are `lib/workspaceDelete.ts`'s business, and happen before this. */
  remove: (id: string) => void
  /** The raw flag. `switchWorkspace` in `lib/workspaces.ts` is what the UI calls:
   *  it also brings the workspace's last chat back. */
  setActive: (id: string) => void
  rememberSession: (workspaceId: string, sessionId: string) => void
}

/**
 * Whatever was stored, made safe to render: Default present, first, and still
 * pointing at nothing; every other entry with an id, a name and a directory;
 * the active id one that exists.
 */
export function sanitizeWorkspaces(
  stored: Partial<Pick<WorkspacesState, 'workspaces' | 'activeId' | 'lastSessionById'>> | undefined
): Pick<WorkspacesState, 'workspaces' | 'activeId' | 'lastSessionById'> {
  const others = (stored?.workspaces ?? []).filter(
    (w): w is Workspace =>
      !!w &&
      typeof w.id === 'string' &&
      w.id !== DEFAULT_WORKSPACE_ID &&
      typeof w.name === 'string' &&
      w.name.trim() !== '' &&
      typeof w.configDir === 'string' &&
      w.configDir !== ''
  )
  const storedDefault = stored?.workspaces?.find((w) => w?.id === DEFAULT_WORKSPACE_ID)
  // Default may be renamed or given a picture; its directory is never anything but null.
  const defaultWorkspace: Workspace = {
    ...DEFAULT_WORKSPACE,
    ...(storedDefault?.name?.trim() ? { name: storedDefault.name } : {}),
    ...(storedDefault?.image ? { image: storedDefault.image } : {}),
    configDir: null
  }
  const workspaces = [defaultWorkspace, ...others]
  const activeId = workspaces.some((w) => w.id === stored?.activeId) ? stored!.activeId! : DEFAULT_WORKSPACE_ID
  return { workspaces, activeId, lastSessionById: { ...(stored?.lastSessionById ?? {}) } }
}

export const useWorkspacesStore = create<WorkspacesState>()(
  persist(
    (set) => ({
      workspaces: [DEFAULT_WORKSPACE],
      activeId: DEFAULT_WORKSPACE_ID,
      lastSessionById: {},

      add: (workspace) =>
        set((state) =>
          state.workspaces.some((w) => w.id === workspace.id)
            ? state
            : { workspaces: [...state.workspaces, workspace] }
        ),

      update: (id, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== id) return w
            const name = patch.name !== undefined ? patch.name.trim() || w.name : w.name
            const next: Workspace = { ...w, name }
            if ('image' in patch) {
              if (patch.image) next.image = patch.image
              else delete next.image
            }
            return next
          })
        })),

      remove: (id) =>
        set((state) => {
          if (id === DEFAULT_WORKSPACE_ID) return state
          const lastSessionById = { ...state.lastSessionById }
          delete lastSessionById[id]
          return {
            workspaces: state.workspaces.filter((w) => w.id !== id),
            activeId: state.activeId === id ? DEFAULT_WORKSPACE_ID : state.activeId,
            lastSessionById
          }
        }),

      setActive: (id) =>
        set((state) => (state.workspaces.some((w) => w.id === id) ? { activeId: id } : state)),

      rememberSession: (workspaceId, sessionId) =>
        set((state) =>
          state.lastSessionById[workspaceId] === sessionId
            ? state
            : { lastSessionById: { ...state.lastSessionById, [workspaceId]: sessionId } }
        )
    }),
    {
      name: 'nyra-workspaces',
      partialize: (s) => ({ workspaces: s.workspaces, activeId: s.activeId, lastSessionById: s.lastSessionById }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeWorkspaces(persisted as Partial<WorkspacesState> | undefined)
      })
    }
  )
)

// ---- selectors ----

export function findWorkspace(id: string | null | undefined): Workspace | null {
  if (!id) return null
  return useWorkspacesStore.getState().workspaces.find((w) => w.id === id) ?? null
}

/** A workspace's config dir. An id that no longer exists is Default: `null`. */
export function configDirOf(workspaceId: string | null | undefined): ConfigDir {
  return findWorkspace(workspaceId)?.configDir ?? null
}

export function activeWorkspaceId(): string {
  return useWorkspacesStore.getState().activeId
}

export function activeConfigDir(): ConfigDir {
  return configDirOf(activeWorkspaceId())
}

/** For components: the active workspace's config dir, re-rendering on a switch. */
export function useActiveConfigDir(): ConfigDir {
  return useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.configDir ?? null
  )
}

export function useActiveWorkspace(): Workspace {
  return useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.activeId) ?? s.workspaces[0]
  )
}
