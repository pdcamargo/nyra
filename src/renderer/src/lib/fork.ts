import { useSessionsStore, type ForkMode, type Message, type Session, type TextMessage } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { newPendingWorktree } from './worktrees'

/**
 * Where a fork is cut.
 *
 * - `latest`: the whole chat, continuing from its latest reply. `/fork`, the
 *   palette and the sidebar menu.
 * - `reply`: that reply and everything above it. The fork opens empty, for
 *   whatever you would have said next instead.
 * - `before`: everything above one of your messages, with that message put back
 *   in the composer — Edit, without giving up the original.
 */
export type ForkPoint =
  | { kind: 'latest' }
  | { kind: 'reply'; messageId: string }
  | { kind: 'before'; messageId: string }

/** The first message the fork leaves out, or undefined to keep everything. */
export function forkCut(messages: Message[], at: ForkPoint): string | undefined {
  if (at.kind === 'latest') return undefined
  if (at.kind === 'before') return at.messageId
  // A reply is followed by the rest of its turn and then your next message.
  // Cutting at that message keeps the turn whole, and it is where the anchor
  // Claude resumes from was recorded.
  const index = messages.findIndex((m) => m.id === at.messageId)
  if (index < 0) return undefined
  return messages.slice(index + 1).find((m) => m.role === 'user')?.id
}

/** What "Fork into local" is called for this chat. In a worktree, local is it. */
export function forkLocalLabel(session: Pick<Session, 'worktree'> | undefined): string {
  return session?.worktree ? 'Fork into this worktree' : 'Fork into local'
}

/** Whether a chat can fork into a worktree of its own. */
export function canForkIntoWorktree(session: Pick<Session, 'isGitRepo'> | undefined): boolean {
  return session?.isGitRepo === true
}

/**
 * Fork a chat and open the fork. Returns the new chat's id, or null when there
 * was nothing to fork.
 *
 * A worktree fork gets a pending worktree rather than a real one: it is created
 * on the first send, the way a new Worktree chat's is, so a fork nobody writes
 * in leaves nothing on disk. It branches from the source's own checkout and
 * carries its uncommitted work, so the files match what the history says.
 */
export function forkChat(sourceId: string, at: ForkPoint, mode: ForkMode): string | null {
  const store = useSessionsStore.getState()
  const source = store.sessions.find((s) => s.id === sourceId)
  if (!source || source.messages.length === 0) return null
  const worktree = mode === 'worktree' && canForkIntoWorktree(source)

  const newId = store.forkSession(sourceId, forkCut(source.messages, at), worktree ? 'worktree' : 'local')
  if (!newId) return null

  if (worktree) {
    store.setPendingWorktree(newId, { ...newPendingWorktree(), ...(source.cwd ? { from: source.cwd } : {}) })
  }

  // Forking is asking to read the fork, which another page would be in front of.
  useUiStore.getState().setMainView('chat')

  if (at.kind === 'before') {
    const message = source.messages.find((m) => m.id === at.messageId) as TextMessage | undefined
    if (message?.text) useUiStore.getState().prefillInput(message.text)
  }
  return newId
}

/** One "Forked from" or "Forked into" line, and the message it goes under. */
export type ForkMarkSpec = {
  after: string
  direction: 'from' | 'into'
  title: string
  /** The other chat, or null when it has been deleted. */
  to: string | null
  note?: string
}

/**
 * Every fork line a chat's transcript shows: where it came from, under its
 * copied history, and where it went, under each message a fork was cut after.
 * Titles are read live, so a fork Claude has since named shows that name.
 */
export function forkMarks(sessions: Session[], sessionId: string | null): ForkMarkSpec[] {
  if (!sessionId) return []
  const marks: ForkMarkSpec[] = []
  const self = sessions.find((s) => s.id === sessionId)
  const from = self?.forkOf
  if (from?.forkedAt) {
    const source = sessions.find((s) => s.id === from.sessionId)
    marks.push({
      after: from.forkedAt,
      direction: 'from',
      title: source?.title ?? from.title,
      to: source ? source.id : null,
      ...(from.mode === 'worktree' ? { note: 'new worktree' } : {})
    })
  }
  const forks = sessions
    .filter((s) => s.forkOf?.sessionId === sessionId && s.forkOf.messageId)
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const fork of forks) {
    marks.push({ after: fork.forkOf!.messageId, direction: 'into', title: fork.title, to: fork.id })
  }
  return marks
}

/**
 * A project's chats with each fork moved under the chat it came from.
 *
 * Takes the list already sorted and keeps that order at every level, so the
 * project's sort still decides where a family sits and how its forks are
 * ordered. A fork whose source is not in the list — archived, deleted, in
 * another project — is an ordinary row at the top level.
 */
export function nestForks<T extends Pick<Session, 'id' | 'forkOf'>>(sorted: T[]): { session: T; depth: number }[] {
  const ids = new Set(sorted.map((s) => s.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const s of sorted) {
    const parent = s.forkOf?.sessionId
    if (parent && parent !== s.id && ids.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), s])
    } else {
      roots.push(s)
    }
  }
  const out: { session: T; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (s: T, depth: number): void => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push({ session: s, depth })
    for (const child of children.get(s.id) ?? []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  // A cycle has no root to hang from; better a flat row than a missing chat.
  for (const s of sorted) visit(s, 0)
  return out
}
