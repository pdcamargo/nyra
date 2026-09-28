/** Path arithmetic for the tree. Pure, and separate from the components, because
 *  every one of these is a one-liner that is easy to get subtly wrong. The
 *  per-OS rules underneath are `lib/paths`. */
import { basename, dirname, joinPath, relativeTo, segments, trimTrailingSep } from '../../lib/paths'

export { joinPath, relativeTo }

/**
 * The folders between the root and a file, outermost first — the ones the tree
 * has to open to show it. Empty for a file directly under the root, and for one
 * outside it, which this tree cannot reach.
 */
export function ancestorsWithin(root: string, absolute: string): string[] {
  const rest = relativeTo(root, absolute)
  if (!rest || rest === absolute) return []
  const dirs: string[] = []
  let acc = root
  for (const segment of segments(rest).slice(0, -1)) {
    acc = joinPath(acc, segment)
    dirs.push(acc)
  }
  return dirs
}

export function dirnameOf(path: string): string {
  return dirname(path)
}

export function basenameOf(path: string): string {
  return basename(path) || path
}

export type Crumb = { label: string; path: string; isRoot: boolean }

/**
 * The breadcrumb for a file, rooted at the chat's directory.
 *
 * The root crumb is the chat's folder rather than `/`: everything above it is
 * not somewhere this tree can go, so offering it would be a dead end.
 */
export function breadcrumbs(root: string, absolute: string): Crumb[] {
  const rootCrumb: Crumb = { label: basenameOf(root), path: trimTrailingSep(root), isRoot: true }
  const rest = relativeTo(root, absolute)
  if (!rest || rest === absolute) return [rootCrumb]

  let acc = rootCrumb.path
  return [
    rootCrumb,
    ...segments(rest).map((segment) => {
      acc = joinPath(acc, segment)
      return { label: segment, path: acc, isRoot: false }
    })
  ]
}
