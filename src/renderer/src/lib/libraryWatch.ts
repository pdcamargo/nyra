/**
 * Keeping the skill, command and plugin lists in step with the disk.
 *
 * The lists re-read on window events — `nyra:skills-changed` and the rest —
 * which used to fire only when Nyra wrote something itself. Rust now watches
 * the folders those lists come from (`library_watch.rs`) and says which moved;
 * this tells it what to watch, and turns what it says into the same events, so
 * a skill installed from any terminal shows up the way one made in Nyra does.
 */
import { configDirOf, useWorkspacesStore } from '../store/workspaces'
import { projectsInWorkspace, useSessionsStore } from '../store/sessions'
import type { LibraryKind } from './tauri-api'

/** The window event each list already listens for. */
export const LIBRARY_EVENTS: Record<LibraryKind, string> = {
  skills: 'nyra:skills-changed',
  commands: 'nyra:commands-changed',
  agents: 'nyra:agents-changed',
  plugins: 'nyra:plugins-changed'
}

export function announceLibraryChange(kinds: LibraryKind[]): void {
  for (const kind of kinds) window.dispatchEvent(new Event(LIBRARY_EVENTS[kind]))
}

/** What to watch: the active workspace's config dir and its projects. */
function roots(): { configDir: string | null; projects: string[] } {
  const workspaceId = useWorkspacesStore.getState().activeId
  const projects = projectsInWorkspace(useSessionsStore.getState().projects, workspaceId)
    .map((p) => p.path)
    .filter(Boolean)
    .sort()
  return { configDir: configDirOf(workspaceId), projects }
}

/** Start watching, and re-aim the watch whenever the workspace or its projects change. */
export function installLibraryWatch(): () => void {
  let last = ''
  const sync = (): void => {
    const next = roots()
    const key = JSON.stringify(next)
    if (key === last) return
    last = key
    void window.api.library.watch(next.configDir, next.projects).catch(() => {})
  }
  sync()
  const stopWorkspaces = useWorkspacesStore.subscribe(sync)
  const stopSessions = useSessionsStore.subscribe(sync)
  const stopEvents = window.api.library.onChanged(({ kinds }) => announceLibraryChange(kinds))
  return () => {
    stopWorkspaces()
    stopSessions()
    stopEvents()
  }
}
