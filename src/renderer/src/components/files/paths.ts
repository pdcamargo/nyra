/** Path arithmetic for the tree. Pure, and separate from the components, because
 *  every one of these is a one-liner that is easy to get subtly wrong. */

/** Join a root and a repo-relative path. `''` means the root itself. */
export function joinPath(root: string, relative: string): string {
  if (!relative) return root
  return `${root.replace(/\/$/, '')}/${relative}`
}

/** The path relative to the tree's root, for a breadcrumb or an @-mention. */
export function relativeTo(root: string, absolute: string): string {
  const base = root.replace(/\/$/, '')
  if (absolute === base) return ''
  return absolute.startsWith(`${base}/`) ? absolute.slice(base.length + 1) : absolute
}

/**
 * The folders between the root and a file, outermost first — the ones the tree
 * has to open to show it. Empty for a file directly under the root, and for one
 * outside it, which this tree cannot reach.
 */
export function ancestorsWithin(root: string, absolute: string): string[] {
  const base = root.replace(/\/$/, '')
  if (!absolute.startsWith(`${base}/`)) return []
  const segments = absolute.slice(base.length + 1).split('/').filter(Boolean)
  const dirs: string[] = []
  let acc = base
  for (const segment of segments.slice(0, -1)) {
    acc = `${acc}/${segment}`
    dirs.push(acc)
  }
  return dirs
}

export function dirnameOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

export function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export type Crumb = { label: string; path: string; isRoot: boolean }

/**
 * The breadcrumb for a file, rooted at the chat's directory.
 *
 * The root crumb is the chat's folder rather than `/`: everything above it is
 * not somewhere this tree can go, so offering it would be a dead end.
 */
export function breadcrumbs(root: string, absolute: string): Crumb[] {
  const base = root.replace(/\/$/, '')
  const rootCrumb: Crumb = { label: basenameOf(base) || '/', path: base, isRoot: true }
  const rest = relativeTo(base, absolute)
  if (!rest || rest === absolute) return [rootCrumb]

  let acc = base
  return [
    rootCrumb,
    ...rest.split('/').filter(Boolean).map((segment) => {
      acc = `${acc}/${segment}`
      return { label: segment, path: acc, isRoot: false }
    })
  ]
}
