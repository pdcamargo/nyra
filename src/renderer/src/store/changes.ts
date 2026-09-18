/**
 * What each chat's Changes tab is showing.
 *
 * A store rather than component state for two reasons. The list has to survive a
 * tab switch — refetching a 400-file changeset every time you look away is a
 * subprocess and a repaint for nothing. And line comments, when they land, are
 * per chat and have to outlive the tab they were written in; if the diff lives in
 * `useState` they will too, and they will die on the first click elsewhere.
 *
 * Deliberately not persisted. Everything here is derived from the repo, which
 * will have moved on by the time the app comes back, and a stale file list is
 * worse than an empty one.
 */
import { create } from 'zustand'
import type { ChangedFile } from '../lib/api-types'
import { useSettingsStore } from './settings'

/**
 * What a diff is measured against.
 *
 * A value rather than a boolean because a comment is meaningless without it — a
 * note on `git.rs:42` only means something against a stated base — and because
 * retrofitting the third case into a two-case flag would touch every layer.
 */
export type ChangeScope =
  /** Uncommitted work against HEAD. */
  | { kind: 'worktree' }
  /** Everything the branch has done since it diverged. */
  | { kind: 'branch'; base: string }
  /** What a `nyra-changes` card described, at the SHA it recorded. */
  | { kind: 'since'; base: string }

/** The `base` argument the git commands take. Null means HEAD. */
export function scopeBase(scope: ChangeScope): string | null {
  return scope.kind === 'worktree' ? null : scope.base
}

export function scopeLabel(scope: ChangeScope): string {
  if (scope.kind === 'worktree') return 'Working tree'
  return scope.kind === 'branch' ? `vs ${scope.base}` : `since ${scope.base}`
}

/** Where a line comment hangs. The one thing the read-only path must not throw
 *  away: without a stable anchor, comments are a rewrite rather than a feature. */
export type LineAnchor = {
  path: string
  side: 'old' | 'new'
  line: number
}

export function anchorKey(a: LineAnchor): string {
  return `${a.path}:${a.side}:${a.line}`
}

export type FileState = {
  /** The raw unified patch, once its row has been opened. */
  patch: string | null
  loading: boolean
  error: string | null
  expanded: boolean
}

export type ChatChanges = {
  scope: ChangeScope
  files: ChangedFile[]
  /** False when the scope's base ref is gone. Rendered as an explanation, never
   *  as an empty list — the mistake that makes a card promise a diff it cannot
   *  produce. */
  baseResolved: boolean
  loading: boolean
  /** Keyed by path. */
  byFile: Record<string, FileState>
  /** The row to scroll to and open once the list arrives, from a card click. */
  pendingFocus: string | null
  /** The row the accordion should scroll into view. Bumped rather than cleared
   *  by the reader, so picking the same file twice in the tree scrolls twice —
   *  a plain string would look like "no change" the second time and do nothing. */
  scrollTo: { path: string; nonce: number } | null
}

export const EMPTY_CHANGES: ChatChanges = {
  scope: { kind: 'worktree' },
  files: [],
  baseResolved: true,
  loading: false,
  byFile: {},
  pendingFocus: null,
  scrollTo: null
}

const EMPTY_FILE: FileState = { patch: null, loading: false, error: null, expanded: false }

/** Most-changed first, so a read-more cut hides trivia rather than an
 *  alphabetical tail. Ties fall back to path for a stable order. */
export function byChurn(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => {
    const churn = b.insertions + b.deletions - (a.insertions + a.deletions)
    return churn !== 0 ? churn : a.path.localeCompare(b.path)
  })
}

export function totals(files: ChangedFile[]): { insertions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      insertions: acc.insertions + f.insertions,
      deletions: acc.deletions + f.deletions
    }),
    { insertions: 0, deletions: 0 }
  )
}

type ChangesStore = {
  bySession: Record<string, ChatChanges>
  setScope: (sessionId: string, scope: ChangeScope) => void
  /** Re-read the file list for a chat's current scope. */
  refresh: (sessionId: string, cwd: string) => Promise<void>
  /** Open or close one file's row, reading its patch the first time. */
  toggleFile: (sessionId: string, cwd: string, path: string) => Promise<void>
  /** Open this file as soon as the list has it — a card row was clicked. */
  focusFile: (sessionId: string, path: string) => void
  /** Bring a row into view. Its own action because picking a file in the tree
   *  should scroll to it even when it is already open, which `toggleFile` would
   *  otherwise read as "collapse it". */
  revealFile: (sessionId: string, path: string) => void
  /** Drop every read patch, keeping the file list and what is open. Whitespace is
   *  applied by git when the patch is made, so toggling it makes every patch
   *  already in hand describe a different question. */
  invalidatePatches: (sessionId: string) => void
  forget: (sessionId: string) => void
}

const patch = (
  state: ChangesStore,
  sessionId: string,
  next: Partial<ChatChanges> | ((c: ChatChanges) => ChatChanges)
): Pick<ChangesStore, 'bySession'> => {
  const current = state.bySession[sessionId] ?? EMPTY_CHANGES
  const updated = typeof next === 'function' ? next(current) : { ...current, ...next }
  if (updated === current) return { bySession: state.bySession }
  return { bySession: { ...state.bySession, [sessionId]: updated } }
}

export const useChangesStore = create<ChangesStore>()((set, get) => ({
  bySession: {},

  setScope: (sessionId, scope) =>
    set((s) =>
      patch(s, sessionId, (c) =>
        // Switching scope invalidates every patch under it: the same path against
        // a different base is a different diff.
        ({ ...c, scope, files: [], byFile: {}, baseResolved: true })
      )
    ),

  focusFile: (sessionId, path) =>
    set((s) => patch(s, sessionId, { pendingFocus: path })),

  revealFile: (sessionId, path) =>
    set((s) =>
      patch(s, sessionId, (c) => ({
        ...c,
        scrollTo: { path, nonce: (c.scrollTo?.nonce ?? 0) + 1 }
      }))
    ),

  invalidatePatches: (sessionId) =>
    set((s) =>
      patch(s, sessionId, (c) => ({
        ...c,
        byFile: Object.fromEntries(
          Object.entries(c.byFile).map(([path, f]) => [
            path,
            { ...f, patch: null, error: null, loading: false }
          ])
        )
      }))
    ),

  refresh: async (sessionId, cwd) => {
    if (!cwd) return
    set((s) => patch(s, sessionId, { loading: true }))
    const scope = (get().bySession[sessionId] ?? EMPTY_CHANGES).scope
    try {
      const result = await window.api.git.diffFiles(cwd, scopeBase(scope))
      set((s) =>
        patch(s, sessionId, (c) => {
          // The scope moved while this was in flight; its answer is about a
          // question nobody is asking any more.
          if (c.scope !== scope) return c
          return {
            ...c,
            loading: false,
            baseResolved: result.baseResolved,
            files: byChurn(result.files)
          }
        })
      )
    } catch {
      set((s) => patch(s, sessionId, { loading: false, files: [], baseResolved: true }))
    }
  },

  toggleFile: async (sessionId, cwd, path) => {
    const current = get().bySession[sessionId] ?? EMPTY_CHANGES
    const file = current.byFile[path] ?? EMPTY_FILE

    if (file.expanded) {
      set((s) =>
        patch(s, sessionId, (c) => ({
          ...c,
          pendingFocus: c.pendingFocus === path ? null : c.pendingFocus,
          byFile: { ...c.byFile, [path]: { ...file, expanded: false } }
        }))
      )
      return
    }

    // Already read once — reopening is free, and the patch cannot have changed
    // under a scope that has not.
    if (file.patch !== null) {
      set((s) =>
        patch(s, sessionId, (c) => ({
          ...c,
          pendingFocus: c.pendingFocus === path ? null : c.pendingFocus,
          byFile: { ...c.byFile, [path]: { ...file, expanded: true } }
        }))
      )
      return
    }

    set((s) =>
      patch(s, sessionId, (c) => ({
        ...c,
        pendingFocus: c.pendingFocus === path ? null : c.pendingFocus,
        byFile: { ...c.byFile, [path]: { ...file, expanded: true, loading: true, error: null } }
      }))
    )

    const untracked = current.files.find((f) => f.path === path)?.untracked ?? false
    try {
      const result = await window.api.git.diffPatch(
        cwd,
        scopeBase(current.scope),
        path,
        untracked,
        useSettingsStore.getState().diffIgnoreWhitespace
      )
      set((s) =>
        patch(s, sessionId, (c) => ({
          ...c,
          byFile: {
            ...c.byFile,
            [path]: {
              ...(c.byFile[path] ?? EMPTY_FILE),
              loading: false,
              patch: result.patch,
              error: result.error ?? null
            }
          }
        }))
      )
    } catch (e) {
      set((s) =>
        patch(s, sessionId, (c) => ({
          ...c,
          byFile: {
            ...c.byFile,
            [path]: {
              ...(c.byFile[path] ?? EMPTY_FILE),
              loading: false,
              error: e instanceof Error ? e.message : 'Could not read the diff'
            }
          }
        }))
      )
    }
  },

  forget: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const bySession = { ...s.bySession }
      delete bySession[sessionId]
      return { bySession }
    })
}))

export function changesFor(state: ChangesStore, sessionId: string | null): ChatChanges {
  return (sessionId ? state.bySession[sessionId] : null) ?? EMPTY_CHANGES
}
