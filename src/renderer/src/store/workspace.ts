/**
 * The side panel's tab strip, per chat.
 *
 * The strip used to *be* the sidecar's browser tab list, which is why adding a
 * second kind of tab needed a store of its own. Browser tabs are owned by a
 * process we do not control: the sidecar broadcasts its whole list on every
 * navigation, the agent opens tabs unprompted, and an eviction empties it
 * without warning. A file tab has to live through all of that.
 *
 * So ownership is split. This store owns *order, presence and selection in the
 * strip*; `browser.ts` owns *whether a browser tab exists and what is on it*.
 * `reconcileTabs` is the seam, and it is a pure function because it is the only
 * part of this that is hard.
 *
 * Persisted, unlike `browser.ts` — a file tab is just a path, so nothing behind
 * it can be dead on the other side of a restart. Browser entries are dropped on
 * the way back in, since the Chromium they named is gone.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BrowserTab } from '../lib/api-types'
import { useBrowserStore } from './browser'

export type BrowserWorkspaceTab = { kind: 'browser'; tabId: string }
/** `path` is absolute. The mtime poller keys on it, which is what lets a chat's
 *  cwd move under an open tab without the preview needing to care. */
export type FileWorkspaceTab = { kind: 'file'; id: string; path: string | null }
/** The repo's changes. Never reachable from "+": `NEW_TAB_CHOICES` is a separate
 *  list from this union, so a kind absent from it simply cannot be created that
 *  way. It is opened from the Pinned Summary's Changes row, or from a card in the
 *  transcript. What it is *showing* lives in `changes.ts`; this is only the row
 *  in the strip. */
export type ChangesWorkspaceTab = { kind: 'changes'; id: string }
/** A plan under review. Like `changes`, never reachable from "+": it is opened by
 *  clicking a plan card and by nothing else, because a plan is read once. `toolId`
 *  says which plan; the text itself stays on the session message, so a revision
 *  mid-turn updates the open tab without anything here changing. */
export type PlanWorkspaceTab = { kind: 'plan'; id: string; toolId: string }
/** This chat's subagents. One tab with two modes rather than one tab per agent:
 *  a fan-out of five agents would otherwise bury every other tab in the strip.
 *  `focus` is null for the list and a `Task` toolId for that agent's stream; the
 *  back arrow just sets it to null. Like `changes` and `plan`, never reachable
 *  from "+" — it is about this conversation, not a blank workspace. */
export type SubagentsWorkspaceTab = { kind: 'subagents'; id: string; focus: string | null }
export type WorkspaceTab =
  | BrowserWorkspaceTab
  | FileWorkspaceTab
  | ChangesWorkspaceTab
  | PlanWorkspaceTab
  | SubagentsWorkspaceTab

export type ChatWorkspace = {
  /** The strip, in the order it is drawn. Ours, not the sidecar's. */
  tabs: WorkspaceTab[]
  activeKey: string | null
  /** A tab asked for before the strip knew it existed — `tabCreate` resolves and
   *  the broadcast that would add the row may not have landed yet. */
  pendingSelectKey: string | null
  /** Per chat rather than per tab: two file tabs showing the same tree that
   *  disagreed about whether it was open would read as a bug. */
  treeOpen: boolean
  /** null means TREE_DEFAULT_WIDTH — the width is a preference, not a fact, so
   *  "never dragged it" and "dragged it to the default" stay distinguishable. */
  treeWidth: number | null
  treeExpanded: string[]
}

export const EMPTY_WORKSPACE: ChatWorkspace = {
  tabs: [],
  activeKey: null,
  pendingSelectKey: null,
  treeOpen: true,
  treeWidth: null,
  treeExpanded: []
}

export const browserKey = (tabId: string): string => `browser:${tabId}`
export const fileKey = (id: string): string => `file:${id}`
export const changesKey = (id: string): string => `changes:${id}`
export const planKey = (id: string): string => `plan:${id}`
export const subagentsKey = (id: string): string => `subagents:${id}`

export function tabKey(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case 'browser':
      return browserKey(tab.tabId)
    case 'file':
      return fileKey(tab.id)
    case 'plan':
      return planKey(tab.id)
    case 'subagents':
      return subagentsKey(tab.id)
    default:
      return changesKey(tab.id)
  }
}

let counter = 0
function nextFileTabId(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter}`
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** The tab that should be selected once `tabs` is the strip. */
function nextActiveKey(ws: ChatWorkspace, tabs: WorkspaceTab[]): {
  activeKey: string | null
  pendingSelectKey: string | null
} {
  const keys = tabs.map(tabKey)

  // Something asked for a tab before it existed. Now it does.
  if (ws.pendingSelectKey && keys.includes(ws.pendingSelectKey)) {
    return { activeKey: ws.pendingSelectKey, pendingSelectKey: null }
  }
  // The selection still points at something real. This is the rule that stops
  // the agent opening a tab from stealing focus, and the rule that keeps a file
  // tab selected across an eviction that empties the browser half of the strip.
  if (ws.activeKey && keys.includes(ws.activeKey)) {
    return { activeKey: ws.activeKey, pendingSelectKey: ws.pendingSelectKey }
  }
  if (tabs.length === 0) return { activeKey: null, pendingSelectKey: ws.pendingSelectKey }

  // The selected tab went away. Take whatever now sits where it did, or the new
  // last tab if it was at the end — what every browser does. Falling back to
  // `tabs[0]` instead would throw you to the front of the strip.
  const wasAt = ws.activeKey ? ws.tabs.findIndex((t) => tabKey(t) === ws.activeKey) : -1
  if (wasAt !== -1) {
    return {
      activeKey: keys[wasAt] ?? keys[keys.length - 1] ?? null,
      pendingSelectKey: ws.pendingSelectKey
    }
  }
  return { activeKey: keys[0], pendingSelectKey: ws.pendingSelectKey }
}

/**
 * Fold the sidecar's current browser tab list into the strip.
 *
 * Browser entries it no longer lists are gone; ones it lists that we have no row
 * for are appended, in its order, at the end. Survivors never move: our order is
 * what the user arranged, and the sidecar's only decides where newcomers sit
 * relative to each other.
 *
 * File entries are not touched by any path through here.
 */
export function reconcileTabs(ws: ChatWorkspace, liveTabIds: string[]): ChatWorkspace {
  const live = new Set(liveTabIds)
  const survivors = ws.tabs.filter((t) => t.kind !== 'browser' || live.has(t.tabId))
  const known = new Set(
    survivors.filter((t): t is BrowserWorkspaceTab => t.kind === 'browser').map((t) => t.tabId)
  )
  const appended: WorkspaceTab[] = liveTabIds
    .filter((id) => !known.has(id))
    .map((tabId) => ({ kind: 'browser', tabId }))

  const tabs = appended.length ? [...survivors, ...appended] : survivors
  const { activeKey, pendingSelectKey } = nextActiveKey(ws, tabs)

  // The sidecar re-broadcasts on every navigation — several times per page, on a
  // 60 ms debounce. Returning the same object when it said nothing new is what
  // keeps that from re-rendering the strip each time.
  const sameTabs =
    tabs.length === ws.tabs.length && tabs.every((t, i) => tabKey(t) === tabKey(ws.tabs[i]))
  if (sameTabs && activeKey === ws.activeKey && pendingSelectKey === ws.pendingSelectKey) return ws

  return { ...ws, tabs, activeKey, pendingSelectKey }
}

// ---------------------------------------------------------------------------
// Rehydration
// ---------------------------------------------------------------------------

function sanitizeWorkspace(raw: unknown): ChatWorkspace | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ChatWorkspace>

  // File, changes, plan and subagents rows come back; browser rows do not, since
  // a restored one would name a page in a Chromium that does not exist any more.
  // A changes row is only an id — what it shows is re-read from the repo on
  // mount. A plan row is the file case rather than the browser one: the plan text
  // lives on a session message and those are persisted, so quitting mid-review
  // keeps your place. `PlanTab` still copes with the message being gone. A
  // subagents row keeps its `focus` because the roster is persisted and the
  // transcript is re-read off disk.
  //
  // This list is a whitelist, unlike `reconcileTabs`' filter — a kind that is not
  // handled here is silently dropped on the next restart.
  const seen = new Set<string>()
  const tabs: WorkspaceTab[] = (Array.isArray(r.tabs) ? r.tabs : []).flatMap(
    (t): WorkspaceTab[] => {
      if (!t || typeof t !== 'object') return []
      const tab = t as Partial<
        FileWorkspaceTab | ChangesWorkspaceTab | PlanWorkspaceTab | SubagentsWorkspaceTab
      >
      if (typeof tab.id !== 'string' || seen.has(tab.id)) return []
      if (tab.kind === 'changes') {
        seen.add(tab.id)
        return [{ kind: 'changes', id: tab.id }]
      }
      if (tab.kind === 'plan') {
        const toolId = (tab as Partial<PlanWorkspaceTab>).toolId
        if (typeof toolId !== 'string') return []
        seen.add(tab.id)
        return [{ kind: 'plan', id: tab.id, toolId }]
      }
      if (tab.kind === 'subagents') {
        const focus = (tab as Partial<SubagentsWorkspaceTab>).focus
        if (focus !== null && focus !== undefined && typeof focus !== 'string') return []
        seen.add(tab.id)
        return [{ kind: 'subagents', id: tab.id, focus: focus ?? null }]
      }
      if (tab.kind !== 'file') return []
      const path = (tab as Partial<FileWorkspaceTab>).path
      if (path !== null && path !== undefined && typeof path !== 'string') return []
      seen.add(tab.id)
      return [{ kind: 'file', id: tab.id, path: path ?? null }]
    }
  )

  const keys = tabs.map(tabKey)
  const activeKey =
    typeof r.activeKey === 'string' && keys.includes(r.activeKey)
      ? r.activeKey
      : (keys[0] ?? null)

  const treeWidth =
    typeof r.treeWidth === 'number' && Number.isFinite(r.treeWidth) ? r.treeWidth : null

  return {
    tabs,
    activeKey,
    // Never restored: it describes a request that was in flight when the app
    // closed, and nothing is going to answer it now.
    pendingSelectKey: null,
    treeOpen: typeof r.treeOpen === 'boolean' ? r.treeOpen : EMPTY_WORKSPACE.treeOpen,
    treeWidth,
    treeExpanded: Array.isArray(r.treeExpanded)
      ? r.treeExpanded.filter((d): d is string => typeof d === 'string')
      : []
  }
}

/**
 * Fold a persisted blob into something renderable.
 *
 * Exported for the same reason `mergePanelSizes` is: a corrupt blob must read as
 * an empty panel, never as a broken one.
 */
export function sanitizeWorkspaces(persisted: unknown): Record<string, ChatWorkspace> {
  if (!persisted || typeof persisted !== 'object') return {}
  const out: Record<string, ChatWorkspace> = {}
  for (const [sessionId, raw] of Object.entries(persisted as Record<string, unknown>)) {
    const ws = sanitizeWorkspace(raw)
    if (ws && !isForgettable(ws)) out[sessionId] = ws
  }
  return out
}

/** Nothing here a restart would miss. */
function isForgettable(ws: ChatWorkspace): boolean {
  return (
    ws.tabs.length === 0 &&
    ws.treeExpanded.length === 0 &&
    ws.treeWidth === null &&
    ws.treeOpen === EMPTY_WORKSPACE.treeOpen
  )
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type WorkspaceStore = {
  bySession: Record<string, ChatWorkspace>
  /** The sidecar's list for one chat, folded in. */
  reconcile: (sessionId: string, liveTabIds: string[]) => void
  /** Chromium went away under every chat at once. */
  reconcileAllEmpty: () => void
  /** Returns the new tab's key. */
  openFileTab: (sessionId: string, path?: string | null) => string
  /** The chat's changes row, reusing the one already in the strip. One per chat:
   *  two of them would be two views of the same repo fighting over a scope. */
  openChangesTab: (sessionId: string) => string
  /** The plan under review, reusing the row already in the strip and pointing it
   *  at `toolId`. One per chat: opening a second plan is still reviewing a plan,
   *  and two rows would just be two places to close. */
  openPlanTab: (sessionId: string, toolId: string) => string
  /** This chat's subagents, reusing the row already in the strip. `focus` is null
   *  for the list and a `Task` toolId for one agent's stream — the same action
   *  drives the summary row, the "See all" header and the back arrow. */
  openSubagentsTab: (sessionId: string, focus: string | null) => string
  setFilePath: (sessionId: string, fileTabId: string, path: string) => void
  /** Strip-local. Closing a *browser* tab is the sidecar's to report — removing
   *  the row here would let an in-flight broadcast re-append it at the far end. */
  closeTab: (sessionId: string, key: string) => void
  /** Move a tab so it sits immediately before `beforeKey`, or last when null. */
  moveTab: (sessionId: string, fromKey: string, beforeKey: string | null) => void
  /** An unknown key parks rather than dangling, so selecting a tab that is still
   *  being created works whichever way the race goes. */
  selectTab: (sessionId: string, key: string) => void
  setTreeOpen: (sessionId: string, open: boolean) => void
  setTreeWidth: (sessionId: string, px: number | null) => void
  toggleTreeDir: (sessionId: string, dirPath: string) => void
  forget: (sessionId: string) => void
  /** Drop what belongs to chats that no longer exist. Once, after hydration. */
  prune: (knownSessionIds: string[]) => void
}

const patch = (
  state: WorkspaceStore,
  sessionId: string,
  next: Partial<ChatWorkspace> | ((ws: ChatWorkspace) => ChatWorkspace)
): Pick<WorkspaceStore, 'bySession'> => {
  const current = state.bySession[sessionId] ?? EMPTY_WORKSPACE
  const updated = typeof next === 'function' ? next(current) : { ...current, ...next }
  if (updated === current) return { bySession: state.bySession }
  return { bySession: { ...state.bySession, [sessionId]: updated } }
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      bySession: {},

      reconcile: (sessionId, liveTabIds) =>
        set((s) => patch(s, sessionId, (ws) => reconcileTabs(ws, liveTabIds))),

      reconcileAllEmpty: () =>
        set((s) => ({
          bySession: Object.fromEntries(
            Object.entries(s.bySession).map(([id, ws]) => [id, reconcileTabs(ws, [])])
          )
        })),

      openFileTab: (sessionId, path = null) => {
        const tab: FileWorkspaceTab = { kind: 'file', id: nextFileTabId(), path }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      openChangesTab: (sessionId) => {
        const existing = (get().bySession[sessionId] ?? EMPTY_WORKSPACE).tabs.find(
          (t): t is ChangesWorkspaceTab => t.kind === 'changes'
        )
        if (existing) {
          const key = tabKey(existing)
          set((s) => patch(s, sessionId, (ws) => ({ ...ws, activeKey: key })))
          return key
        }
        const tab: ChangesWorkspaceTab = { kind: 'changes', id: nextFileTabId() }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      openPlanTab: (sessionId, toolId) => {
        const existing = (get().bySession[sessionId] ?? EMPTY_WORKSPACE).tabs.find(
          (t): t is PlanWorkspaceTab => t.kind === 'plan'
        )
        if (existing) {
          const key = tabKey(existing)
          set((s) =>
            patch(s, sessionId, (ws) => ({
              ...ws,
              // Retarget rather than stack: clicking a second plan card means
              // "show me this one instead", not "keep the old one around".
              tabs: ws.tabs.map((t) => (t.kind === 'plan' ? { ...t, toolId } : t)),
              activeKey: key
            }))
          )
          return key
        }
        const tab: PlanWorkspaceTab = { kind: 'plan', id: nextFileTabId(), toolId }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      openSubagentsTab: (sessionId, focus) => {
        const existing = (get().bySession[sessionId] ?? EMPTY_WORKSPACE).tabs.find(
          (t): t is SubagentsWorkspaceTab => t.kind === 'subagents'
        )
        if (existing) {
          const key = tabKey(existing)
          set((s) =>
            patch(s, sessionId, (ws) => ({
              ...ws,
              // Retarget rather than stack. The back arrow is this same call with
              // a null focus, so navigating inside the tab costs no extra row.
              tabs: ws.tabs.map((t) => (t.kind === 'subagents' ? { ...t, focus } : t)),
              activeKey: key
            }))
          )
          return key
        }
        const tab: SubagentsWorkspaceTab = { kind: 'subagents', id: nextFileTabId(), focus }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      setFilePath: (sessionId, fileTabId, path) =>
        set((s) =>
          patch(s, sessionId, (ws) => {
            const current = ws.tabs.find((t) => t.kind === 'file' && t.id === fileTabId)
            if (!current || (current.kind === 'file' && current.path === path)) return ws
            return {
              ...ws,
              tabs: ws.tabs.map((t) =>
                t.kind === 'file' && t.id === fileTabId ? { ...t, path } : t
              )
            }
          })
        ),

      closeTab: (sessionId, key) =>
        set((s) =>
          patch(s, sessionId, (ws) => {
            const at = ws.tabs.findIndex((t) => tabKey(t) === key)
            if (at === -1) return ws
            const tabs = ws.tabs.filter((_, i) => i !== at)
            if (ws.activeKey !== key) return { ...ws, tabs }
            const keys = tabs.map(tabKey)
            return { ...ws, tabs, activeKey: keys[at] ?? keys[keys.length - 1] ?? null }
          })
        ),

      moveTab: (sessionId, fromKey, beforeKey) =>
        set((s) =>
          patch(s, sessionId, (ws) => {
            const from = ws.tabs.findIndex((t) => tabKey(t) === fromKey)
            if (from === -1) return ws

            const tabs = [...ws.tabs]
            const [moved] = tabs.splice(from, 1)
            // Resolved *after* the removal, which is what keeps this free of the
            // off-by-one every reorder gets wrong when dragging rightward.
            const at = beforeKey === null ? tabs.length : tabs.findIndex((t) => tabKey(t) === beforeKey)
            if (at === -1 || at === from) return ws

            tabs.splice(at, 0, moved)
            return { ...ws, tabs }
          })
        ),

      selectTab: (sessionId, key) =>
        set((s) =>
          patch(s, sessionId, (ws) => {
            if (ws.tabs.some((t) => tabKey(t) === key)) {
              // Selecting what is already selected is a no-op, not a re-render —
              // the pip and the summary both call this on every click.
              if (ws.activeKey === key && ws.pendingSelectKey === null) return ws
              return { ...ws, activeKey: key, pendingSelectKey: null }
            }
            return ws.pendingSelectKey === key ? ws : { ...ws, pendingSelectKey: key }
          })
        ),

      setTreeOpen: (sessionId, treeOpen) =>
        set((s) => patch(s, sessionId, (ws) => (ws.treeOpen === treeOpen ? ws : { ...ws, treeOpen }))),
      setTreeWidth: (sessionId, treeWidth) =>
        set((s) =>
          patch(s, sessionId, (ws) => (ws.treeWidth === treeWidth ? ws : { ...ws, treeWidth }))
        ),

      toggleTreeDir: (sessionId, dirPath) =>
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            treeExpanded: ws.treeExpanded.includes(dirPath)
              ? ws.treeExpanded.filter((d) => d !== dirPath)
              : [...ws.treeExpanded, dirPath]
          }))
        ),

      forget: (sessionId) =>
        set((s) => {
          if (!(sessionId in s.bySession)) return s
          const bySession = { ...s.bySession }
          delete bySession[sessionId]
          return { bySession }
        }),

      prune: (knownSessionIds) =>
        set((s) => {
          const known = new Set(knownSessionIds)
          const entries = Object.entries(s.bySession).filter(([id]) => known.has(id))
          if (entries.length === Object.keys(s.bySession).length) return s
          return { bySession: Object.fromEntries(entries) }
        })
    }),
    {
      name: 'nyra-workspace',
      // Browser rows and the in-flight selection are dropped on the way out as
      // well as on the way in, so the blob never carries something we would only
      // have to throw away.
      partialize: (s) => ({
        bySession: Object.fromEntries(
          Object.entries(s.bySession)
            .map(([id, ws]) => [
              id,
              { ...ws, tabs: ws.tabs.filter((t) => t.kind !== 'browser'), pendingSelectKey: null }
            ])
            .filter(([, ws]) => !isForgettable(ws as ChatWorkspace))
        )
      }),
      merge: (persisted, current) => ({
        ...(current as WorkspaceStore),
        bySession: sanitizeWorkspaces((persisted as { bySession?: unknown } | undefined)?.bySession)
      })
    }
  )
)

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function workspaceFor(state: WorkspaceStore, sessionId: string | null): ChatWorkspace {
  return (sessionId ? state.bySession[sessionId] : null) ?? EMPTY_WORKSPACE
}

export function activeTab(ws: ChatWorkspace): WorkspaceTab | null {
  return ws.tabs.find((t) => tabKey(t) === ws.activeKey) ?? null
}

/**
 * Does this chat need a Chromium?
 *
 * The one question the boot gate asks. Mounting the panel used to be the whole
 * test, which would now mean opening it to read a file downloads a browser
 * engine and leaves a blank page in the strip.
 */
export function wantsBrowser(ws: ChatWorkspace): boolean {
  return ws.tabs.some((t) => t.kind === 'browser') || ws.pendingSelectKey?.startsWith('browser:') === true
}

/** Which browser tab the miniature should show, if any. */
export function activeBrowserTabId(ws: ChatWorkspace): string | null {
  const active = activeTab(ws)
  if (active?.kind === 'browser') return active.tabId
  const first = ws.tabs.find((t): t is BrowserWorkspaceTab => t.kind === 'browser')
  return first?.tabId ?? null
}

// ---------------------------------------------------------------------------
// The seam with browser.ts
// ---------------------------------------------------------------------------
//
// Two stores have to move together on a sidecar event, and the caller should not
// have to remember that. Imports go one way only — browser.ts never reaches back
// in here.

/** The sidecar's tab list for one chat. */
export function syncSidecarTabs(sessionId: string, tabs: BrowserTab[]): void {
  useBrowserStore.getState().setTabs(sessionId, tabs)
  useWorkspaceStore.getState().reconcile(
    sessionId,
    tabs.map((t) => t.tabId)
  )
}

/** Chromium went away under everyone. File tabs are unaffected. */
export function syncBrowserGone(): void {
  useBrowserStore.getState().browserGone()
  useWorkspaceStore.getState().reconcileAllEmpty()
}
