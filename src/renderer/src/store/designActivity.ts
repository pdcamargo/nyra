import { create } from 'zustand'
import { artboardMarkup, hash, type ResolvedDocument, type Theme } from '@nyra/design'
import { DESIGN_EXTENSION } from '../lib/openFile'
import { designPathInCommand, designPathInText, hostDesignPath, sameDesign } from '../lib/designPaths'
import { useRunningStore } from './running'

export const DESIGN_TOOL = 'mcp__nyra-app__nyra_design'

/**
 * What a tool call says about a design, before it has run.
 *
 * Either a path (a file write, or a shell command that names one) or a design
 * name/id for `nyra_design`, which only the index can turn into a path. `null`
 * for everything that does not touch a design — which is nearly every call, so
 * this has to be cheap and certain rather than clever.
 */
export type DesignTarget = {
  path?: string
  design?: string
  artboard?: string
  /** A `create`: the name is new, so only the answer can say which file it is. */
  create?: true
}

export function designTarget(tool: string, input: Record<string, unknown>): DesignTarget | null {
  if (tool === DESIGN_TOOL) {
    const action = String(input.action ?? '')
    // `list` reads the index and changes nothing, so it is not activity.
    if (action === 'render') {
      const design = typeof input.design === 'string' ? input.design : undefined
      const artboard = typeof input.artboard === 'string' ? input.artboard : undefined
      return design ? { design, artboard } : null
    }
    if (action === 'create') return typeof input.name === 'string' ? { design: input.name, create: true } : null
    return null
  }
  const file = input.file_path ?? input.notebook_path
  if (typeof file === 'string') {
    return file.toLowerCase().endsWith(DESIGN_EXTENSION) ? { path: file } : null
  }
  // A design edited by a script rather than a Write. Only a command that names
  // the file counts — anything subtler would light the miniature up on noise.
  if (typeof input.command === 'string') {
    const found = designPathInCommand(input.command)
    return found ? { path: found } : null
  }
  return null
}

/** The design path a `nyra_design` result names, when it names one. */
export const pathInResult = designPathInText

/** A design this chat is working on. */
export type DesignTouch = {
  path: string
  /** When a tool last touched it — what "most recent wins" compares. */
  at: number
  /** Tool calls touching it that have not answered yet. */
  inFlight: string[]
  /** Touched during the turn that is still running. */
  hot: boolean
  /** An artboard the call named (`render artboard:"x"`), if any. */
  artboard: string | null
}

/**
 * What a design looks like now, and what moved since you last looked.
 *
 * Keyed by path, not by chat: two chats editing one file are editing one file.
 * `baseline` is the per-artboard hash at the moment you last looked — opening
 * the design, or it first appearing — so "changed" means changed since you
 * saw it, which is the only version of the question worth a badge.
 */
export type DesignWatch = {
  /** Null while the file does not exist yet, or does not compile. */
  doc: ResolvedDocument | null
  theme: Theme | null
  hashes: Record<string, string>
  baseline: Record<string, string>
  /** Newest first. */
  changed: { id: string; at: number }[]
}

type DesignActivityState = {
  bySession: Record<string, DesignTouch[]>
  watches: Record<string, DesignWatch>
  /** tool id -> the call's target, while the path is still being resolved. */
  pending: Record<string, { sessionId: string; target: DesignTarget }>
  touch: (sessionId: string, toolId: string, path: string, artboard?: string | null) => void
  settle: (sessionId: string, toolId: string) => void
  cool: (sessionId: string) => void
  observe: (path: string, doc: ResolvedDocument, theme: Theme) => void
  /** The file is not there. Remembered so that when it appears, all of it is new. */
  observeMissing: (path: string) => void
  /** You have seen it. Pass the version on screen when it may be newer or
   *  older than the watch's, so the baseline is what you actually saw. */
  acknowledge: (path: string, seen?: { doc: ResolvedDocument; theme: Theme }) => void
}

const EMPTY: DesignTouch[] = []

export function designHashes(doc: ResolvedDocument, theme: Theme): Record<string, string> {
  return Object.fromEntries(doc.artboards.map((a) => [a.id, hash(artboardMarkup(a, theme))]))
}

/** Which artboards differ from `baseline`, merged into what was already flagged. */
export function diffChanged(
  previous: { id: string; at: number }[],
  baseline: Record<string, string>,
  before: Record<string, string>,
  after: Record<string, string>,
  now: number
): { id: string; at: number }[] {
  const kept = previous.filter((c) => c.id in after && after[c.id] !== baseline[c.id])
  const fresh = Object.keys(after)
    .filter((id) => after[id] !== before[id] && after[id] !== baseline[id])
    .map((id) => ({ id, at: now }))
  const freshIds = new Set(fresh.map((c) => c.id))
  return [...fresh, ...kept.filter((c) => !freshIds.has(c.id))]
}

export const useDesignActivityStore = create<DesignActivityState>((set) => ({
  bySession: {},
  watches: {},
  pending: {},

  touch: (sessionId, toolId, raw, artboard = null) =>
    set((s) => {
      const list = s.bySession[sessionId] ?? EMPTY
      const existing = list.find((d) => sameDesign(d.path, raw))
      // The first spelling seen stays the key, so the watch and the row agree.
      const path = existing?.path ?? raw
      const next: DesignTouch = {
        path,
        at: Date.now(),
        inFlight: existing?.inFlight.includes(toolId) ? existing.inFlight : [...(existing?.inFlight ?? []), toolId],
        hot: true,
        artboard: artboard ?? existing?.artboard ?? null
      }
      return { bySession: { ...s.bySession, [sessionId]: [next, ...list.filter((d) => d !== existing)] } }
    }),

  settle: (sessionId, toolId) =>
    set((s) => {
      const list = s.bySession[sessionId]
      if (!list?.some((d) => d.inFlight.includes(toolId))) return s
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: list.map((d) =>
            d.inFlight.includes(toolId) ? { ...d, inFlight: d.inFlight.filter((t) => t !== toolId) } : d
          )
        }
      }
    }),

  cool: (sessionId) =>
    set((s) => {
      const list = s.bySession[sessionId]
      if (!list?.some((d) => d.hot || d.inFlight.length > 0)) return s
      return {
        bySession: { ...s.bySession, [sessionId]: list.map((d) => ({ ...d, hot: false, inFlight: [] })) }
      }
    }),

  observe: (path, doc, theme) =>
    set((s) => {
      const hashes = designHashes(doc, theme)
      const prev = s.watches[path]
      // The first sight of a design is the baseline. A design seen missing
      // first has an empty one, so everything in it arrives as changed.
      const baseline = prev ? prev.baseline : hashes
      const changed = diffChanged(prev?.changed ?? [], baseline, prev?.hashes ?? {}, hashes, Date.now())
      return { watches: { ...s.watches, [path]: { doc, theme, hashes, baseline, changed } } }
    }),

  observeMissing: (path) =>
    set((s) =>
      s.watches[path]
        ? s
        : { watches: { ...s.watches, [path]: { doc: null, theme: null, hashes: {}, baseline: {}, changed: [] } } }
    ),

  acknowledge: (asked, seen) =>
    set((s) => {
      const path = watchKey(s.watches, asked)
      const w = path ? s.watches[path] : undefined
      if (!path || !w) return s
      const baseline = seen ? designHashes(seen.doc, seen.theme) : w.hashes
      const changed = w.changed.filter((c) => w.hashes[c.id] !== baseline[c.id])
      return { watches: { ...s.watches, [path]: { ...w, baseline, changed } } }
    })
}))

/** The watch for a path however it is spelled — the index and a chat may differ. */
export function watchKey(watches: Record<string, unknown>, path: string): string | null {
  if (path in watches) return path
  return Object.keys(watches).find((k) => sameDesign(k, path)) ?? null
}

export const designsFor = (state: DesignActivityState, sessionId: string | null): DesignTouch[] =>
  (sessionId ? state.bySession[sessionId] : null) ?? EMPTY

/**
 * Is Claude working on this one right now?
 *
 * A call in flight says so outright. Between calls, only the design touched
 * most recently counts: a turn that moved from one design to another is no
 * longer editing the first, and calling every design in the turn "editing"
 * until it ends made the word mean nothing.
 */
export const isLive = (d: DesignTouch, running: boolean, newest: boolean): boolean =>
  d.inFlight.length > 0 || (running && d.hot && newest)

/**
 * A tool call as it streams past. Called from the chat's event handler, next
 * to the PR bookkeeping, for the same reason: this is the one place every call
 * goes through.
 */
export function noteDesignCall(
  sessionId: string,
  toolId: string,
  tool: string,
  input: Record<string, unknown>,
  cwd: string
): void {
  const target = designTarget(tool, input)
  if (!target) return
  const store = useDesignActivityStore.getState()
  if (target.path) {
    store.touch(sessionId, toolId, hostDesignPath(target.path, cwd), target.artboard)
    return
  }
  useDesignActivityStore.setState((s) => ({ pending: { ...s.pending, [toolId]: { sessionId, target } } }))
  // A create's name may already belong to an older design; looking it up would
  // light that one up instead. Its answer carries the path — see below.
  if (target.create) return
  // A render names a design, not a file. The index knows which file, newest
  // first, which is also how the tool itself resolves a reused name.
  const wanted = target.design?.toLowerCase()
  void window.api.design.list().then((known) => {
    const entry =
      known.find((d) => d.id === target.design) ?? known.find((d) => d.name.toLowerCase() === wanted)
    if (entry && useDesignActivityStore.getState().pending[toolId]) {
      useDesignActivityStore.getState().touch(sessionId, toolId, entry.path, target.artboard)
    }
  })
}

export function noteDesignResult(
  sessionId: string,
  toolId: string,
  content: string | undefined,
  cwd: string
): void {
  const store = useDesignActivityStore.getState()
  const pending = store.pending[toolId]
  if (pending) {
    // `create` names its path only in the answer.
    const path = pathInResult(content)
    const known = store.bySession[sessionId]?.some((d) => d.inFlight.includes(toolId))
    if (path && !known) store.touch(sessionId, toolId, hostDesignPath(path, cwd), pending.target.artboard)
    useDesignActivityStore.setState((s) => {
      const { [toolId]: _, ...rest } = s.pending
      return { pending: rest }
    })
  }
  useDesignActivityStore.getState().settle(sessionId, toolId)
}

// A turn ending is what turns "Claude is editing" into "Updated …": between a
// Write and the render that follows it nothing is in flight, and the badge
// flickering off for that half-second would be a lie.
useRunningStore.subscribe((state, prev) => {
  for (const id of Object.keys(prev.running)) {
    if (!state.running[id]) useDesignActivityStore.getState().cool(id)
  }
})
