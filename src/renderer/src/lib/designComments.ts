/**
 * Comments on designs, and the two ways of giving feedback from the canvas.
 *
 * A comment is pinned to an element, not a point. A right-click finds the node
 * under the cursor (its `data-node`), and the comment keeps that node's
 * resolved id, the authored address it came from (scope, id and file — what
 * Claude edits), and where inside the node's box the pin sits. The artboard
 * point is kept only as a fallback for when the element is later deleted.
 */
import type { Address, ResolvedArtboard, ResolvedNode } from '@nyra/design'
import { formatChord } from './keys'

/** A component instance the target sits inside: `PermissionRow "mic"`. */
export type InstanceStep = {
  component: string
  /** The instance's id where it was placed. */
  id: string
  /** Where it was placed — the caller's file, scope and id. */
  site: Address
}

export type Box = { x: number; y: number; width: number; height: number }

export type CommentAnchor = {
  /** `settings#mic/grant/label` — the node on screen. */
  resolvedId: string | null
  /** The authored node: where it is defined. */
  origin: Address | null
  /** Component instances it sits inside, outermost first. */
  inside: InstanceStep[]
  /** Where in the node's box the pin is, 0–1 each way. */
  offset: { x: number; y: number }
  /** Artboard pixels: the fallback when the node is gone. */
  point: { x: number; y: number }
  /** The node's box, in artboard pixels, when the comment was made. */
  bounds: Box | null
  /** How the target reads to a person: "Grant access", "Title". */
  label: string
  type: string | null
  /** A text node's words. */
  text?: string
}

/** A round on a comment: Claude's note when it acts, or the user writing back. */
export type CommentReply = { id: string; by: 'claude' | 'you'; text: string; at: string }

export type DesignComment = {
  id: string
  /** The pin number, unique in its scope for good. */
  n: number
  text: string
  status: 'open' | 'resolved'
  createdAt: string
  /** Absolute path of the design file. */
  file: string
  /** Path inside the system, for a system file. */
  rel?: string
  artboardId: string
  artboardName: string
  anchor: CommentAnchor
  /** Who closed it, and when. What they said is a reply. */
  resolution?: { by: string; at: string; note?: string }
  replies?: CommentReply[]
}

/**
 * Every reply, oldest first. A comment resolved before threads existed kept
 * its note on `resolution`; that note is the thread's first reply.
 */
export function threadOf(c: Pick<DesignComment, 'replies' | 'resolution'>): CommentReply[] {
  const replies = c.replies ?? []
  const note = c.resolution?.note?.trim()
  if (note && !replies.some((r) => r.text === note)) {
    return [{ id: 'r_note', by: c.resolution!.by === 'claude' ? 'claude' : 'you', text: note, at: c.resolution!.at }, ...replies]
  }
  return replies
}

/** What a right-click landed on, before it is described. */
export type Hit = {
  artboardId: string
  resolvedId: string | null
  offset: { x: number; y: number }
  point: { x: number; y: number }
  bounds: Box | null
}

/** The comment file a design's comments live in: its system's, or its own. */
export async function commentScope(path: string): Promise<string> {
  const member = await window.api.designSystem?.of(path)
  if (member) return `sys:${member.system.id}`
  const draft = (await window.api.design.list()).find((d) => d.path === path)
  if (draft) return `design:${draft.id}`
  return `path:${fnv(path)}`
}

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16)
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)

/**
 * The node under a right-click, read through the artboard's shadow root.
 *
 * `composedPath` crosses the shadow boundary, so its first `data-node` is the
 * innermost element drawn there. The host's layout width against its on-screen
 * width is the canvas zoom, which turns screen pixels back into artboard ones.
 */
export function hitTest(event: MouseEvent, host: HTMLElement, artboardId: string): Hit {
  const hostBox = host.getBoundingClientRect()
  const scale = host.offsetWidth > 0 ? hostBox.width / host.offsetWidth : 1
  const point = { x: (event.clientX - hostBox.left) / scale, y: (event.clientY - hostBox.top) / scale }
  const node = event
    .composedPath()
    .find((n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute('data-node'))
  if (!node) return { artboardId, resolvedId: null, offset: { x: 0.5, y: 0.5 }, point, bounds: null }
  const box = node.getBoundingClientRect()
  return {
    artboardId,
    resolvedId: node.getAttribute('data-node'),
    offset: {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height)
    },
    point,
    bounds: {
      x: (box.left - hostBox.left) / scale,
      y: (box.top - hostBox.top) / scale,
      width: box.width / scale,
      height: box.height / scale
    }
  }
}

/** The node with this resolved id, and every node above it, outermost first. */
export function findNode(root: ResolvedNode, id: string): ResolvedNode[] | null {
  if (root.id === id) return [root]
  if (root.type !== 'box') return null
  for (const c of root.children) {
    const hit = findNode(c, id)
    if (hit) return [root, ...hit]
  }
  return null
}

/** Every node, depth first. */
function* nodes(root: ResolvedNode): Generator<ResolvedNode> {
  yield root
  if (root.type === 'box') for (const c of root.children) yield* nodes(c)
}

const sameAddress = (a: Address, b: Address): boolean =>
  a.scope === b.scope && a.id === b.id && (a.file ?? '') === (b.file ?? '')

/**
 * Where a comment's node is now.
 *
 * By resolved id first. When an edit renamed or moved what is around it the id
 * changes, so the authored address is tried next — but only when it names one
 * node: a Button's label is in every Button, and guessing which would pin the
 * comment to the wrong one.
 */
export function relocate(artboard: ResolvedArtboard, anchor: CommentAnchor): string | null {
  if (anchor.resolvedId && findNode(artboard.root, anchor.resolvedId)) return anchor.resolvedId
  if (!anchor.origin) return null
  const matches: string[] = []
  for (const n of nodes(artboard.root)) if (sameAddress(n.origin, anchor.origin)) matches.push(n.id)
  return matches.length === 1 ? matches[0] : null
}

const words = (n: ResolvedNode): string | undefined => {
  if (n.type !== 'text') return undefined
  const v = (n as { value?: unknown }).value
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((r) => (typeof r === 'string' ? r : ((r as { text?: string }).text ?? ''))).join('')
  return undefined
}

const clip = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Describe what was clicked: the node, the instances it is inside, and a label
 * a person would use.
 *
 * An instance's root keeps the caller's address, so the scope changes between
 * an instance root and its children: that step is the boundary. Slotted
 * content goes back to the caller's scope, which closes the instances opened
 * since — it is authored where the caller is, not inside the Card it fills.
 */
export function describeTarget(
  artboard: ResolvedArtboard,
  resolvedId: string | null
): Pick<CommentAnchor, 'label' | 'type' | 'text' | 'origin' | 'inside'> {
  const chain = resolvedId ? findNode(artboard.root, resolvedId) : null
  if (!chain) return { label: artboard.name, type: null, origin: null, inside: [] }
  const node = chain[chain.length - 1]
  const inside: InstanceStep[] = []
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i - 1]
    const scope = chain[i].origin.scope
    if (scope === parent.origin.scope) continue
    if (scope === artboard.id) {
      inside.length = 0
      continue
    }
    const back = inside.findIndex((s) => s.component === scope)
    if (back >= 0) {
      inside.length = back + 1
      continue
    }
    inside.push({ component: scope, id: parent.origin.id, site: parent.origin })
  }
  // The first words inside a container name it better than its type does:
  // "Grant access" says which button, "box root" says nothing.
  const firstText = (n: ResolvedNode): string | undefined =>
    words(n) ?? (n.type === 'box' ? n.children.map(firstText).find((t) => t?.trim()) : undefined)
  const text = words(node)
  const label = clip((text ?? firstText(node) ?? '').trim()) || `${node.type} ${node.origin.id}`
  return { label, type: node.type, ...(text ? { text } : {}), origin: node.origin, inside }
}

/** The short tag over a highlighted element: `Button · grant`, `text · title`. */
export function targetTag(anchor: Pick<CommentAnchor, 'inside' | 'origin' | 'type'>): string {
  const last = anchor.inside.at(-1)
  if (last && anchor.origin?.scope === last.component) return `${last.component} · ${last.id}`
  return anchor.origin ? `${anchor.type ?? 'node'} · ${anchor.origin.id}` : 'artboard'
}

const where = (a: Address): string => `${a.file ? `${a.file} · ` : ''}${a.scope}#${a.id}`

/** What Claude receives with a comment: the element, where to edit it, the words. */
export function commentBody(
  c: Pick<DesignComment, 'id' | 'n' | 'text' | 'file' | 'rel' | 'artboardId' | 'artboardName' | 'anchor' | 'replies' | 'resolution'>,
  note?: string
): string {
  const a = c.anchor
  const site = a.inside.at(-1)?.site
  const chain = a.inside.map((s) => `${s.component} "${s.id}"`).join(' › ')
  const box = a.bounds
    ? `${Math.round(a.bounds.width)}×${Math.round(a.bounds.height)} at ${Math.round(a.bounds.x)},${Math.round(a.bounds.y)} · `
    : ''
  return [
    `<design_comment id="${c.id}" pin="${c.n}">`,
    `file:     ${c.rel ?? c.file} · artboard "${c.artboardId}" (${c.artboardName})`,
    a.resolvedId
      ? `node:     ${a.resolvedId}${a.type ? ` — a ${a.type}` : ''}${chain ? ` inside ${chain}` : ''}`
      : 'node:     none — a point on the artboard',
    ...(site ? [`edit at:  ${where(site)}`, `defined:  ${where(a.origin!)}`] : a.origin ? [`edit at:  ${where(a.origin)}`] : []),
    ...(a.text ? [`text:     "${clip(a.text, 80)}"`] : []),
    `where:    ${box}pinned at ${Math.round(a.offset.x * 100)}% × ${Math.round(a.offset.y * 100)}%`,
    `comment:  ${c.text}`,
    // Every round so far, so a reply is read against what was already tried.
    ...threadOf(c).map((r, i) => `${i === 0 ? 'thread:  ' : '         '} ${r.by === 'claude' ? 'claude' : 'user'}: ${r.text}`),
    ...(note ? [note] : []),
    '</design_comment>',
    `When you have acted on it, resolve it: nyra_design action:"resolve", id:"${c.id}", note:"<what you changed>".`
  ].join('\n')
}

/** What Claude receives with feedback on a whole artboard. */
export function feedbackBody(path: string, artboardId: string, artboardName: string): string {
  return `<design_feedback path="${path}" artboard="${artboardId}" name="${artboardName.replace(/"/g, "'")}">The feedback is about this whole artboard, not one element.</design_feedback>`
}

/** `just now`, `3 min ago`, `2 h ago`, then the date. */
export function since(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The keys the composer answers to, in this platform's spelling. */
export function composerKeys(): string {
  return `${formatChord('enter')} send · ${formatChord('shift+enter')} new line · ${formatChord('escape')} cancel`
}
