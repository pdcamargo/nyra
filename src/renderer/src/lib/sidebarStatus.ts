/**
 * What the sidebar says about a chat and a project at a glance.
 *
 * The rail used to say "busy" with a shimmer and "waiting" with one blue chip,
 * the same blue as unread. These are the rules behind the replacement: blue
 * means Claude is working, amber means it stopped on you, and the chip says
 * what it stopped on. Kept out of the component so the rules are testable
 * without rendering a rail.
 */
import type { Session } from '../store/sessions'
import { PROJECT_TINTS, type ProjectTint } from './project-appearance'

/** Why a chat is waiting on you. */
export type ChatWaitKind = 'permission' | 'plan' | 'question'

export type ChatWait = { kind: ChatWaitKind; label: string }

export type WaitContext = {
  /** Session ids with a plan waiting for approval, as the plan store keeps
   *  them: a plan that arrived with no chat is `undefined` in here. */
  planPending: ReadonlySet<string | undefined>
  /** Session id → the tool whose permission prompt is open. */
  permissions: Readonly<Record<string, string>>
}

/**
 * `mcp__nyra-browser__browser_click` is a server and a tool; the chip has room
 * for the tool.
 */
export function shortToolName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__')
  return parts[parts.length - 1] || tool
}

/**
 * The one thing a chat is waiting on, or null.
 *
 * A permission prompt outranks the rest: it is holding a turn open right now,
 * and nothing else moves until it is answered. A plan outranks a question
 * because it is the bigger decision, and a chat rarely has both.
 */
export function chatWait(session: Pick<Session, 'id' | 'needsAnswer'>, ctx: WaitContext): ChatWait | null {
  const tool = ctx.permissions[session.id]
  if (tool) return { kind: 'permission', label: `Allow ${shortToolName(tool)}` }
  if (ctx.planPending.has(session.id)) return { kind: 'plan', label: 'Plan' }
  if (session.needsAnswer) return { kind: 'question', label: 'Question' }
  return null
}

/** A project's chats, summed. Every count includes chats under Show more. */
export type ProjectRollup = {
  busy: number
  waiting: number
  /** Open and draft PRs: both are still waiting to land. */
  open: number
  merged: number
}

export function projectRollup(
  sessions: readonly Pick<Session, 'id' | 'needsAnswer' | 'pullRequests'>[],
  ctx: WaitContext & { busy: Readonly<Record<string, true>> }
): ProjectRollup {
  const out: ProjectRollup = { busy: 0, waiting: 0, open: 0, merged: 0 }
  // By URL: two chats can touch the same PR, and one PR counted twice reads
  // as two pieces of work.
  const seen = new Set<string>()
  for (const s of sessions) {
    if (ctx.busy[s.id]) out.busy++
    if (chatWait(s, ctx)) out.waiting++
    for (const pr of s.pullRequests ?? []) {
      if (seen.has(pr.url)) continue
      seen.add(pr.url)
      if (pr.state === 'open' || pr.state === 'draft') out.open++
      else if (pr.state === 'merged') out.merged++
    }
  }
  return out
}

export function isEmptyRollup(r: ProjectRollup): boolean {
  return r.busy === 0 && r.waiting === 0 && r.open === 0 && r.merged === 0
}

/** `2 running · 1 waiting on you · 1 open PR · 5 merged`, for the tooltip. */
export function describeRollup(r: ProjectRollup): string {
  const parts: string[] = []
  if (r.busy) parts.push(`${r.busy} running`)
  if (r.waiting) parts.push(`${r.waiting} waiting on you`)
  if (r.open) parts.push(`${r.open} open PR${r.open === 1 ? '' : 's'}`)
  if (r.merged) parts.push(`${r.merged} merged`)
  return parts.join(' · ')
}

/**
 * A colour for a project that was never given one, so the spine style can tell
 * two uncustomised projects apart. Hashed from the id rather than the name, so
 * renaming a project does not repaint it.
 */
export function autoTint(projectId: string): ProjectTint {
  let h = 0x811c9dc5
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return PROJECT_TINTS[(h >>> 0) % PROJECT_TINTS.length]
}

/** The letter on a project's tile when it has no icon. */
export function projectInitial(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u)
  return match ? match[0].toLocaleUpperCase() : '?'
}

/** `12s`, `4m 05s` under ten minutes, `14m`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
