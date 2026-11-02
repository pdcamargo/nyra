/** Editing a project's linked folders. Every caller — Project settings, the
 *  Files tab's root menu — goes through these, so they agree on what a
 *  duplicate is and on keeping the list's order. */
import type { LinkedFolder } from '@shared/types'
import { useSessionsStore, type Project } from '../store/sessions'
import { isWithin, samePath } from './paths'

function projectById(projectId: string): Project | undefined {
  return useSessionsStore.getState().projects.find((p) => p.id === projectId)
}

/** Why `path` cannot be linked to the project, or null when it can. `except`
 *  is the folder being replaced, which may of course match itself. */
export function linkProblem(project: Project, path: string, except?: string): string | null {
  if (samePath(project.path, path)) return 'That is already the main folder.'
  if (isWithin(project.path, path)) return 'That folder is inside the main folder already.'
  const taken = (project.linkedFolders ?? []).some(
    (f) => samePath(f.path, path) && !(except && samePath(f.path, except))
  )
  return taken ? 'That folder is already linked.' : null
}

/** Link `path`, or — with `replacing` — put it where that folder was. */
export function saveLinkedFolder(projectId: string, path: string, note: string, replacing?: string): void {
  const project = projectById(projectId)
  if (!project) return
  const trimmed = note.trim()
  const next: LinkedFolder = trimmed ? { path, note: trimmed } : { path }
  const current = project.linkedFolders ?? []
  const at = replacing ? current.findIndex((f) => samePath(f.path, replacing)) : -1
  const folders = at >= 0 ? current.map((f, i) => (i === at ? next : f)) : [...current, next]
  useSessionsStore.getState().setProjectLinkedFolders(projectId, folders)
}

export function unlinkFolder(projectId: string, path: string): void {
  const project = projectById(projectId)
  if (!project) return
  useSessionsStore.getState().setProjectLinkedFolders(
    projectId,
    (project.linkedFolders ?? []).filter((f) => !samePath(f.path, path))
  )
}
