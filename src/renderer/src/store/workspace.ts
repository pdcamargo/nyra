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

/**
 * `provisional` marks the row made the instant somebody asked for a browser,
 * before the sidecar had a tab to name. A cold Chromium is several seconds of
 * nothing, and an empty strip during that reads as a button that did not work —
 * so the row goes up first and is replaced in place, at the same index and with
 * the same selection, once `tabCreate` answers.
 */
export type BrowserWorkspaceTab = { kind: 'browser'; tabId: string; provisional?: boolean }
/** `path` is absolute. The mtime poller keys on it, which is what lets a chat's
 *  cwd move under an open tab without the preview needing to care. `preview`
 *  marks the chat's one replaceable slot — the tab a single click in the tree
 *  lands in, drawn italic, and retargeted rather than stacked until a double
 *  click pins it. */
export type FileWorkspaceTab = { kind: 'file'; id: string; path: string | null; preview?: boolean }
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
/** A design on the canvas. `designId` is the index's id, not a path, so the tab
 *  survives the design being moved — which is the whole reason the index exists.
 *  Null means "show whichever is newest", which is what a freshly opened tab
 *  should do rather than nothing. */
export type DesignWorkspaceTab = {
  kind: 'design'
  id: string
  designId: string | null
  /** The artboard the canvas is framed on, when something asked for one. */
  artboardId: string | null
}
export type WorkspaceTab =
  | BrowserWorkspaceTab
  | FileWorkspaceTab
  | ChangesWorkspaceTab
  | PlanWorkspaceTab
  | SubagentsWorkspaceTab
  | DesignWorkspaceTab

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
/** The tab id behind a `browser:` key — the key is what the strip trades in, and
 *  a caller that has to hand a tab id back as an argument should not be slicing
 *  the prefix off by hand. */
export const browserTabIdFromKey = (key: string): string => key.slice('browser:'.length)
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

/** The id a provisional browser row wears until a real tab replaces it. Shaped
 *  like a sidecar id would be, but prefixed, because `browser.tabClose` must
 *  never be handed one. */
function nextProvisionalTabId(): string {
  return `pending-${nextFileTabId()}`
}

/**
 * Placeholders somebody closed while the browser was still waking.
 *
 * Closing the row is a cancel, and the tab being built for it should go with it
 * rather than appear from nowhere a second later. A row that left the strip for
 * any other reason is not a cancel, and only this remembers which is which.
 */
const cancelledBoots = new Set<string>()
const bootKey = (sessionId: string, tabId: string): string => `${sessionId}|${tabId}`

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
  // A provisional row is ours, not the sidecar's, so its absence from the list
  // is not an eviction — the one place a browser row outlives a broadcast.
  const survivors = ws.tabs.filter(
    (t) => t.kind !== 'browser' || t.provisional === true || live.has(t.tabId)
  )
  const known = new Set(
    survivors
      .filter(
        (t): t is BrowserWorkspaceTab => t.kind === 'browser' && t.provisional !== true
      )
      .map((t) => t.tabId)
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
        | FileWorkspaceTab
        | ChangesWorkspaceTab
        | PlanWorkspaceTab
        | SubagentsWorkspaceTab
        | DesignWorkspaceTab
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
      if (tab.kind === 'design') {
        const designId = (tab as Partial<DesignWorkspaceTab>).designId
        if (designId !== null && designId !== undefined && typeof designId !== 'string') return []
        const artboardId = (tab as Partial<DesignWorkspaceTab>).artboardId
        if (artboardId !== null && artboardId !== undefined && typeof artboardId !== 'string') return []
        seen.add(tab.id)
        return [
          { kind: 'design', id: tab.id, designId: designId ?? null, artboardId: artboardId ?? null }
        ]
      }
      if (tab.kind !== 'file') return []
      const path = (tab as Partial<FileWorkspaceTab>).path
      if (path !== null && path !== undefined && typeof path !== 'string') return []
      seen.add(tab.id)
      return [
        {
          kind: 'file',
          id: tab.id,
          path: path ?? null,
          preview: (tab as Partial<FileWorkspaceTab>).preview === true ? true : undefined
        }
      ]
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
  /** The chat's one replaceable file slot. Reuses the row already wearing the
   *  preview mark, retargeting it; makes one if this chat has none. Returns the
   *  row's key, which is stable across retargets. */
  openFilePreviewTab: (sessionId: string, path?: string | null) => string
  /** Keep a preview row open — a double click on the file or on its tab. */
  pinFileTab: (sessionId: string, fileTabId: string) => void
  /** The chat's changes row, reusing the one already in the strip. One per chat:
   *  two of them would be two views of the same repo fighting over a scope. */
  openChangesTab: (sessionId: string) => string
  /** The placeholder row for a browser nobody has started yet. Reuses the one
   *  this chat already has, so pressing "+" twice does not stack two. */
  openProvisionalBrowserTab: (sessionId: string) => string
  /** Swap a provisional row for the real tab. Returns the new key, or null if
   *  the placeholder is gone — the caller's cue that the tab was closed while
   *  the browser was still waking. */
  adoptBrowserTab: (sessionId: string, provisionalTabId: string, tabId: string) => string | null
  /** The design canvas. One per chat, like changes: opening a second design is
   *  still looking at designs, and the picker in the tab switches between them.
   *  Reachable from "+" — unlike changes, a design canvas is a workspace rather
   *  than something about this conversation. */
  openDesignTab: (sessionId: string, designId?: string | null, artboardId?: string | null) => string
  /** Which design the canvas is showing. Stored on the tab so a reload comes
   *  back to the same one. */
  setDesignTabDesign: (sessionId: string, tabId: string, designId: string | null) => void
  /** Frame the canvas on one artboard, or clear it to show everything. */
  setDesignTabArtboard: (sessionId: string, tabId: string, artboardId: string | null) => void
  /** The plan under review, reusing the row already in the strip and pointing it
   *  at `toolId`. One per chat: opening a second plan is still reviewing a plan,
   *  and two rows would just be two places to close. */
  openPlanTab: (sessionId: string, toolId: string) => string
  /** This chat's subagents, reusing the row already in the strip. `focus` is null
   *  for the list and a `Task` toolId for one agent's stream — the same action
   *  drives the summary row, the "See all" header and the back arrow. */
  openSubagentsTab: (sessionId: string, focus: string | null) => string
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

      openFilePreviewTab: (sessionId, path = null) => {
        const existing = (get().bySession[sessionId] ?? EMPTY_WORKSPACE).tabs.find(
          (t): t is FileWorkspaceTab => t.kind === 'file' && t.preview === true
        )
        if (existing) {
          const key = tabKey(existing)
          set((s) =>
            patch(s, sessionId, (ws) => ({
              ...ws,
              tabs: ws.tabs.map((t) =>
                t.kind === 'file' && t.id === existing.id ? { ...t, path } : t
              ),
              activeKey: key
            }))
          )
          return key
        }
        const tab: FileWorkspaceTab = { kind: 'file', id: nextFileTabId(), path, preview: true }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      pinFileTab: (sessionId, fileTabId) =>
        set((s) =>
          patch(s, sessionId, (ws) => {
            const current = ws.tabs.find((t) => t.kind === 'file' && t.id === fileTabId)
            if (!current || current.kind !== 'file' || current.preview !== true) return ws
            return {
              ...ws,
              tabs: ws.tabs.map((t) =>
                t.kind === 'file' && t.id === fileTabId ? { ...t, preview: undefined } : t
              )
            }
          })
        ),

      openProvisionalBrowserTab: (sessionId) => {
        const existing = (get().bySession[sessionId] ?? EMPTY_WORKSPACE).tabs.find(
          (t): t is BrowserWorkspaceTab => t.kind === 'browser' && t.provisional === true
        )
        if (existing) {
          const key = browserKey(existing.tabId)
          set((s) => patch(s, sessionId, (ws) => ({ ...ws, activeKey: key })))
          return key
        }
        const tab: BrowserWorkspaceTab = {
          kind: 'browser',
          tabId: nextProvisionalTabId(),
          provisional: true
        }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      adoptBrowserTab: (sessionId, provisionalTabId, tabId) => {
        const ws = get().bySession[sessionId] ?? EMPTY_WORKSPACE
        const key = browserKey(tabId)
        const provisionalKey = browserKey(provisionalTabId)
        const cancelled = cancelledBoots.delete(bootKey(sessionId, provisionalTabId))
        const at = ws.tabs.findIndex(
          (t) => t.kind === 'browser' && t.provisional === true && t.tabId === provisionalTabId
        )
        // The broadcast can beat the reply that created the tab, in which case
        // the real row is already in the strip and only the placeholder is left
        // to clear.
        const already = ws.tabs.some((t) => tabKey(t) === key)
        // Nothing to replace and nothing to clear: the row was closed while the
        // browser was waking, which is a cancel rather than an orphan.
        if (cancelled && at === -1 && !already) return null
        if (at === -1 && !already) {
          // Gone for some other reason — the chat's workspace was replaced, or a
          // list that predated this tab reconciled it away. The page exists, so
          // it gets a row; dropping it would leave a browser with no way back.
          set((s) =>
            patch(s, sessionId, (current) => ({
              ...current,
              tabs: [...current.tabs, { kind: 'browser', tabId } as WorkspaceTab],
              activeKey:
                current.activeKey === null || current.activeKey === provisionalKey
                  ? key
                  : current.activeKey
            }))
          )
          return key
        }
        set((s) =>
          patch(s, sessionId, (current) => ({
            ...current,
            tabs:
              at === -1 || already
                ? current.tabs.filter(
                    (t) => !(t.kind === 'browser' && t.provisional === true && t.tabId === provisionalTabId)
                  )
                : current.tabs.map((t, i) =>
                    // Replaced at its own index rather than appended: the row
                    // was up before the sidecar answered, and where it sits is
                    // where the person put it.
                    i === at ? ({ kind: 'browser', tabId } as WorkspaceTab) : t
                  ),
            // The selection follows the row that was selected, not the page
            // that arrived: switching tabs while Chromium wakes must not be
            // undone by the tab finishing.
            activeKey: current.activeKey === provisionalKey ? key : current.activeKey,
            pendingSelectKey:
              current.pendingSelectKey === provisionalKey ? null : current.pendingSelectKey
          }))
        )
        return key
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

      openDesignTab: (sessionId, designId = null, artboardId = null) => {
        const existing = (get().bySession[sessionId] ?? EMPTY_WORKSPACE).tabs.find(
          (t): t is DesignWorkspaceTab => t.kind === 'design'
        )
        if (existing) {
          const key = tabKey(existing)
          set((s) =>
            patch(s, sessionId, (ws) => ({
              ...ws,
              // An explicit id wins; opening the tab with none leaves it where
              // it was rather than resetting what someone was looking at.
              tabs: ws.tabs.map((t) =>
                t.kind === 'design' && designId !== null ? { ...t, designId, artboardId } : t
              ),
              activeKey: key
            }))
          )
          return key
        }
        const tab: DesignWorkspaceTab = {
          kind: 'design',
          id: nextFileTabId(),
          designId,
          artboardId
        }
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: [...ws.tabs, tab],
            activeKey: tabKey(tab)
          }))
        )
        return tabKey(tab)
      },

      setDesignTabDesign: (sessionId, tabId, designId) => {
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: ws.tabs.map((t) =>
              // Switching design clears the frame: an artboard id from one
              // document means nothing in another.
              t.kind === 'design' && t.id === tabId ? { ...t, designId, artboardId: null } : t
            )
          }))
        )
      },

      setDesignTabArtboard: (sessionId, tabId, artboardId) => {
        set((s) =>
          patch(s, sessionId, (ws) => ({
            ...ws,
            tabs: ws.tabs.map((t) =>
              t.kind === 'design' && t.id === tabId ? { ...t, artboardId } : t
            )
          }))
        )
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

      closeTab: (sessionId, key) =>
        set((s) =>
          patch(s, sessionId, (ws) => {
            const at = ws.tabs.findIndex((t) => tabKey(t) === key)
            if (at === -1) return ws
            const removed = ws.tabs[at]
            if (removed.kind === 'browser' && removed.provisional === true) {
              cancelledBoots.add(bootKey(sessionId, removed.tabId))
            }
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
          for (const key of [...cancelledBoots]) {
            if (key.startsWith(`${sessionId}|`)) cancelledBoots.delete(key)
          }
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
  // A provisional row names a tab that does not exist yet, so pointing the
  // miniature at it would ask the sidecar about a stranger.
  if (active?.kind === 'browser' && active.provisional !== true) return active.tabId
  const first = ws.tabs.find(
    (t): t is BrowserWorkspaceTab => t.kind === 'browser' && t.provisional !== true
  )
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
