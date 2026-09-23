/**
 * Where the repository a chat works in actually starts.
 *
 * Git reports a changed file's path relative to the *top* of the repo — always,
 * whether or not the command ran in a subdirectory. The chat's cwd is not
 * necessarily that top: a chat opened in `Developer/mv-ui` has a repo above it,
 * and resolving `src/a.ts` against the cwd names a file that is not there. That
 * is the bug this exists to close.
 *
 * `git worktree list` answers it for both cases at once, and it is the only
 * answer that handles a linked worktree: the main worktree is listed first, but
 * a chat in a worktree is working in the worktree, so the match is the longest
 * listed path that contains the cwd rather than the first line.
 */
const roots = new Map<string, Promise<string>>()

export function repoRootFor(cwd: string): Promise<string> {
  if (!cwd) return Promise.resolve(cwd)
  const cached = roots.get(cwd)
  if (cached) return cached
  const pending = (async (): Promise<string> => {
    try {
      const trees = await window.api.git.worktreeList(cwd)
      const containing = trees
        .map((t) => t.path.replace(/\/$/, ''))
        .filter((path) => path && (cwd === path || cwd.startsWith(`${path}/`)))
        .sort((a, b) => b.length - a.length)
      return containing[0] ?? cwd.replace(/\/$/, '')
    } catch {
      // Not a repo, or a git that would not answer: the cwd is the best root
      // there is, and it is exactly right for the chat that is the repo root.
      return cwd.replace(/\/$/, '')
    }
  })()
  roots.set(cwd, pending)
  return pending
}

/** A git-reported path, as a file this app can open. */
export async function absoluteInRepo(cwd: string, gitPath: string): Promise<string> {
  if (gitPath.startsWith('/')) return gitPath
  if (!cwd) return gitPath
  const root = await repoRootFor(cwd)
  return `${root}/${gitPath.replace(/^\.\//, '')}`
}
