/**
 * The folders a chat can see: the one it runs in, then its project's linked
 * ones. The tree draws one root per entry, and quick-open and the @ popup
 * search each of them.
 */
import type { LinkedFolder } from '@shared/types'
import { basename, dirname, isWithin, samePath, segments } from './paths'

export type FolderRoot = {
  path: string
  /** What the UI calls it: the folder's name, or `parent/name` when two of
   *  a chat's folders share a name. */
  name: string
  /** The chat's own directory — where the agent was started. */
  main: boolean
  note?: string
}

const NO_LINKS: readonly LinkedFolder[] = []

/** `main` first, then each linked folder that is not `main` itself. */
export function folderRoots(main: string, linked: readonly LinkedFolder[] = NO_LINKS): FolderRoot[] {
  const roots: FolderRoot[] = []
  if (main) roots.push({ path: main, name: basename(main) || main, main: true })
  for (const folder of linked) {
    if (roots.some((r) => samePath(r.path, folder.path))) continue
    roots.push({ path: folder.path, name: basename(folder.path) || folder.path, main: false, note: folder.note })
  }
  // A name only has to tell a chat's own folders apart, so the parent comes in
  // only where two of them collide.
  // Counted before any is renamed, or the first rename hides the collision.
  const counts = new Map<string, number>()
  for (const root of roots) counts.set(root.name, (counts.get(root.name) ?? 0) + 1)
  return roots.map((root) => ((counts.get(root.name) ?? 0) > 1 ? { ...root, name: withParent(root.path) } : root))
}

function withParent(path: string): string {
  const parent = segments(dirname(path)).at(-1)
  return parent ? `${parent}/${basename(path)}` : path
}

/** The root a path sits under, the deepest one when roots nest. */
export function rootOf(roots: readonly FolderRoot[], path: string): FolderRoot | undefined {
  let best: FolderRoot | undefined
  for (const root of roots) {
    if (!isWithin(root.path, path)) continue
    if (!best || root.path.length > best.path.length) best = root
  }
  return best
}
