/**
 * Path arithmetic that holds on every OS. Pure, and the one place it lives.
 *
 * On macOS and Linux a path is `/`-separated and case-sensitive. On Windows it
 * is `C:\Users\me\repo` from Nyra and from Claude's file tools, `C:/Users/me`
 * from `git worktree list`, and `\\server\share` from a mapped drive — and all
 * three name the same files regardless of case. `path.split('/')` gets every
 * one of those wrong, which is why nothing outside this file should be writing
 * it for a filesystem path.
 *
 * The exception is a path git printed relative to the repo (`git status`,
 * `ls-files`, a diff header): git writes `/` on every OS, so splitting one of
 * those on `/` is already correct everywhere.
 */
import { toHostPath } from './environment'
import { platform } from './platform'

type Style = 'posix' | 'win32'

const style = (): Style => platform().pathStyle

const SEPARATORS: Record<Style, RegExp> = { posix: /\/+/, win32: /[\\/]+/ }

function isSep(ch: string | undefined, s: Style): boolean {
  return ch === '/' || (s === 'win32' && ch === '\\')
}

/** How much of `path` is its root — `/`, `C:\`, `\\server\share\` — or 0. */
function rootLength(path: string, s: Style): number {
  if (s === 'win32') {
    const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?/.exec(path)
    if (unc) return unc[0].length
    if (/^[a-zA-Z]:/.test(path)) return isSep(path[2], s) ? 3 : 2
  }
  return isSep(path[0], s) ? 1 : 0
}

function lastSep(path: string, s: Style): number {
  for (let i = path.length - 1; i >= 0; i--) if (isSep(path[i], s)) return i
  return -1
}

/** The form two paths are compared in: no trailing separator, and on Windows
 *  one separator and one case. Same length as the input up to that trim, so an
 *  index into it is an index into the original. */
function comparable(path: string, s: Style): string {
  const trimmed = trimTrailingSep(path)
  return s === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
}

export function isAbsolute(path: string): boolean {
  if (style() === 'win32') return /^[a-zA-Z]:[\\/]/.test(path) || isSep(path[0], 'win32')
  return path.startsWith('/')
}

/** The separator to extend `path` with: whichever it already uses. */
export function separatorOf(path: string): string {
  if (style() === 'posix') return '/'
  return path.includes('/') && !path.includes('\\') ? '/' : '\\'
}

/** `/a/b/` → `/a/b`, but `/` and `C:\` stay the roots they are. */
export function trimTrailingSep(path: string): string {
  const s = style()
  const root = rootLength(path, s)
  let end = path.length
  while (end > root && isSep(path[end - 1], s)) end--
  return path.slice(0, end)
}

/** The non-empty parts of a path, root marker dropped. */
export function segments(path: string): string[] {
  return path.split(SEPARATORS[style()]).filter(Boolean)
}

/** The last part — `a.ts` of `/repo/a.ts`, `src` of `/repo/src/` — or `''` for a root. */
export function basename(path: string): string {
  const s = style()
  const trimmed = trimTrailingSep(path)
  const root = rootLength(trimmed, s)
  const at = lastSep(trimmed, s)
  return at < root ? trimmed.slice(root) : trimmed.slice(at + 1)
}

/** Everything before the last part. A root's dirname is the root; a bare name's is `.`. */
export function dirname(path: string): string {
  const s = style()
  const trimmed = trimTrailingSep(path)
  const root = rootLength(trimmed, s)
  const at = lastSep(trimmed, s)
  if (at < root) return trimmed.slice(0, root) || '.'
  return trimTrailingSep(trimmed.slice(0, at)) || trimmed.slice(0, root)
}

/** `root` + `relative`, one separator between, in the separator `root` uses. */
export function joinPath(root: string, relative: string): string {
  if (!relative) return root
  const s = style()
  const sep = separatorOf(root)
  const rel = s === 'win32' ? relative.replace(/[\\/]+/g, sep) : relative
  const head = trimTrailingSep(root)
  return isSep(head[head.length - 1], s) ? `${head}${rel}` : `${head}${sep}${rel}`
}

export function samePath(a: string, b: string): boolean {
  const s = style()
  return comparable(a, s) === comparable(b, s)
}

/** Whether `path` is `root` itself or somewhere under it — not a sibling that
 *  merely shares the prefix, like `/repo-two` beside `/repo`. */
export function isWithin(root: string, path: string): boolean {
  return samePath(root, path) || underRoot(root, path) !== null
}

/** The index in `path` where the part under `root` starts, or null. */
function underRoot(root: string, path: string): number | null {
  const s = style()
  const r = comparable(root, s)
  const p = s === 'win32' ? path.replace(/\//g, '\\').toLowerCase() : path
  const sep = s === 'win32' ? '\\' : '/'
  const prefix = r.endsWith(sep) ? r : r + sep
  return p.startsWith(prefix) ? prefix.length : null
}

/** The path relative to `root`, `''` for the root itself, and `absolute`
 *  unchanged when it is not under `root` at all. */
export function relativeTo(root: string, absolute: string): string {
  if (samePath(root, absolute)) return ''
  const at = underRoot(root, absolute)
  return at === null ? absolute : absolute.slice(at)
}

/** The last `n` parts, joined — or the whole path when it has no more than that. */
export function tail(path: string, n: number): string {
  const parts = segments(path)
  return parts.length <= n ? path : parts.slice(-n).join(separatorOf(path))
}

/** {@link tail}, marked as cut when it was: `…/src/lib/a.ts`. */
export function shortenPath(path: string, n: number): string {
  const parts = segments(path)
  return parts.length <= n ? path : `…${separatorOf(path)}${parts.slice(-n).join(separatorOf(path))}`
}

/** A path Claude printed, against the directory its chat runs in — and named
 *  the way Nyra can open it, when the chat runs somewhere else (see
 *  `environment.ts`). */
export function resolvePath(filePath: string, cwd: string): string {
  const hosted = toHostPath(cwd, filePath)
  if (hosted !== filePath) return hosted
  if (isAbsolute(filePath)) return filePath
  const dotSlash = style() === 'win32' ? /^\.[\\/]/ : /^\.\//
  return joinPath(cwd, filePath.replace(dotSlash, ''))
}
