import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createIdbStorage } from './idbStorage'
import { useRunningStore } from './running'
import { useSettingsStore } from './settings'
import { useBrowserStore } from './browser'
import { useWorkspaceStore } from './workspace'
import { backfillProjects, nameForPath } from './projects-migration'
import { homedir } from '../lib/homedir'
import { useTerminalsStore } from './terminals'
import { useResourceDockStore } from './resourceDock'
import type { ChangeBlock } from '../lib/changeBlocks'
import type { PullRequest } from '../lib/pullRequests'

type PersistedState = { sessions: Session[]; projects: Project[]; activeSessionId: string | null }

export type ImageAttachment = { path: string; mediaType: string; dataUrl: string }

export type FileAttachment = {
  id: string
  name: string
  path: string
  size: number
  /** `binary` is anything with no text extractor — a video, a font, a db.
   *  It travels as a path and is never read into memory. */
  category: 'image' | 'document' | 'text' | 'binary'
  extractedText?: string
  dataUrl?: string // only for images (preview)
}

export type TextMessage = {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  timestamp?: number
  images?: ImageAttachment[]
  files?: FileAttachment[]
  /** A `nyra-changes` block this reply carried. Stored with the message rather
   *  than re-queried, so scrolling back shows what changed *then* — see
   *  `changeBlocks.ts` for why that matters. */
  changes?: ChangeBlock
}

export type ToolCallMessage = {
  id: string
  role: 'tool_call'
  tool_id: string
  tool_name: string
  input: Record<string, unknown>
  result?: string
  denied?: boolean
  originalContent?: string | null
  timestamp?: number
}

export type Message = TextMessage | ToolCallMessage

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  taskId: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  createdByToolId: string
}

export type SessionUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type Agent = {
  toolId: string
  name: string
  subagentType: string
  status: AgentStatus
  startedAt: number
  durationMs?: number
  totalTokens?: number
  /** The latest line from the CLI — what it is doing, not what it was asked. */
  activity?: string
  /** Which model it actually ran on, off its own `message.model`. */
  model?: string
  /** Its transcript on disk, so a tab opened later still has something to show. */
  outputFile?: string
}

export type McpServerInfo = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending'
  tools: string[]
  command?: string
  args?: string[]
  url?: string
  scope?: 'global' | 'project'
}

export type QueuedMessage = {
  text: string
  images?: ImageAttachment[]
  files?: FileAttachment[]
}

/** Shared so `queueOf` never hands back a fresh array for an empty queue. */
const NO_QUEUE: QueuedMessage[] = []

/**
 * A session's queue, tolerating the single `queuedMessage` this used to be so a
 * message queued before the upgrade still gets sent rather than stranded.
 *
 * Returns a stable reference when empty. A zustand selector calling this on
 * every render would otherwise see a new array each time and never settle.
 */
export function queueOf(session: { queuedMessages?: QueuedMessage[]; queuedMessage?: QueuedMessage | null }): QueuedMessage[] {
  if (session.queuedMessages) return session.queuedMessages
  if (session.queuedMessage) return [session.queuedMessage]
  return NO_QUEUE
}

export type WorktreeInfo = {
  name: string
  branch: string
  path: string
  /** Managed worktrees belong to one chat and are auto-pruned; permanent ones are
   *  created from the project menu, shared by several chats, and never pruned. */
  permanent?: boolean
}

/** A Worktree choice made in the composer but not yet materialised on disk. */
export type PendingWorktree = {
  branch: string
  baseRef: string
  seed: boolean
}

/**
 * A folder you work in. Chats hang off one of these; a chat with no project is a
 * Recent, spawned in the home directory.
 *
 * `path` is the main checkout, never a worktree — a chat's worktree lives on the
 * chat, so a worktree chat still groups under the project it came from.
 */
export type Project = {
  id: string
  name: string
  path: string
  collapsed?: boolean
  /** Manual position in the rail (lower = higher up). */
  order?: number
}

/**
 * A message id that cannot collide with the one minted a moment ago.
 *
 * Eighteen call sites used `Date.now().toString()`. Two messages added inside
 * the same millisecond — a denied edit and the plan card that follows it, say —
 * got the same id, which is the React key the virtualized transcript uses. Two
 * rows with one key means measurements land on the wrong index, and the
 * transcript draws items on top of each other at the wrong offsets.
 */
let messageSeq = 0
export function newMessageId(): string {
  messageSeq = (messageSeq + 1) % 1_000_000
  return `${Date.now().toString(36)}-${messageSeq.toString(36)}`
}

export type Session = {
  id: string
  claudeSessionId: string | null
  title: string
  cwd: string
  createdAt: number
  messages: Message[]
  tasks: Task[]
  agents: Agent[]
  /** PRs this chat opened. Persisted, unlike the ports in the process registry:
   *  a PR outlives the turn, the app and the branch it came from, so a chat
   *  reopened next week still says what it shipped. */
  pullRequests?: PullRequest[]
  branch?: string
  isGitRepo?: boolean
  worktree?: WorktreeInfo | null
  usage: SessionUsage
  mcpServers?: McpServerInfo[]
  /** What this chat's CLI process reported running on, against what was asked
   *  for. A chat holds one long-lived process and resolves `--model` once, at
   *  spawn — so two chats open side by side can be on different models, and
   *  were on the day the account default moved from Opus 5 to Opus 5.5. The
   *  request is kept with the answer so a model changed mid-chat stops this
   *  describing the process still running under the old one. */
  resolvedModel?: { requested: string; id: string }
  /** Messages typed while a turn was running, sent in order as it frees up. */
  queuedMessages?: QueuedMessage[]
  /** @deprecated Superseded by `queuedMessages`; still read so a persisted one drains. */
  queuedMessage?: QueuedMessage | null
  autoCompacted?: boolean
  pendingAutoCompact?: boolean
  forkOf?: { sessionId: string; messageId: string; title: string }
  /** The title was chosen deliberately — renamed by hand, or derived for a fork
   *  — so the one Claude generates must not take it away again. */
  titleManual?: boolean
  favorite?: boolean
  /** Manual sort position within Pinned (lower = higher up). Decoupled from recency. */
  favoriteOrder?: number
  /**
   * When this chat was put away, or unset while it is still in the rail.
   *
   * Archiving is not deleting: the transcript stays and the chat simply leaves
   * Pinned, Projects and Recents for the Archived page. What it does stop is
   * the work — its Claude process, its background shells and its browser — so
   * the one thing it cannot keep is a running conversation's worktree, which is
   * snapshotted and removed first. `worktreeSnapshotted` then says whether
   * unarchiving has work of its own to bring back.
   */
  archivedAt?: number | null
  /** Owning project, or null/undefined for a Recents chat. */
  projectId?: string | null
  /** Worktree asked for in the composer, created when the first message is sent.
   *  Deferring it means a chat you never used leaves nothing behind. */
  pendingWorktree?: PendingWorktree | null
  /** Set when a managed worktree was pruned but its work was snapshotted. */
  worktreeSnapshotted?: boolean
  /** Messages that arrived while you were looking at a different chat. Cleared
   *  when you open this one — a chat you are reading has nothing unread in it. */
  unread?: number
  /** Turns this conversation has completed, counted on the CLI's `result`.
   *
   *  Not derivable from the transcript: one turn emits an `assistant_text` event
   *  per prose block, so counting assistant messages counts paragraphs. The
   *  recap needs the real number, and only the stream knows it. */
  turns?: number
  /** The window you missed, snapshotted when you open a chat that ran without
   *  you — `unread` is cleared on that same open, so the recap cannot be derived
   *  from it afterwards. Null once the recap is dismissed, or once you leave
   *  the chat again. `ms` is how long it worked without you; a window pinned
   *  before it was recorded has none. */
  away?: { since: number; turnsAtLeave: number; ms?: number } | null
  /** `turns` as of the last time you looked away from this chat. */
  turnsSeen?: number
  /** When you last stopped seeing this chat — switched to another, or the
   *  window lost focus while it was on screen. Unset while you are looking at
   *  it, and for one never opened. */
  leftAt?: number
  /** A question Claude asked that nobody has answered yet, so the chat list can
   *  say so without walking every message of every session on each render. */
  needsAnswer?: boolean
  /** The plan being carried out, so the composer can say what and for how long.
   *  Set when a plan is approved, cleared when the work stops. */
  executing?: { title: string; startedAt: number } | null
  /** Approving a plan with "auto-accept edits" — this conversation only.
   *  Deliberately not a global setting: the CLI's version lasts the session,
   *  and a permission you granted for one plan should not quietly follow you
   *  into every other project. */
  autoAcceptEdits?: boolean
  /** Per-chat overrides of the spawn settings.
   *
   *  Undefined means "use the default from Settings". These were global, so
   *  turning plan mode on in one conversation turned it on in every other one —
   *  including chats already running, which is not a setting, it is a surprise.
   *  Settings now holds the default a new chat starts with; these hold what this
   *  conversation is actually doing. */
  planMode?: boolean
  model?: string
  effort?: '' | 'low' | 'medium' | 'high' | 'max'
  /** Which panels this conversation has open, and how wide the right one is.
   *
   *  Per chat because the answer genuinely differs per chat: one is a browsing
   *  session with the workspace panel open, the next is a question you want the
   *  full width for. Undefined means "whatever you last used", so a new chat
   *  inherits rather than starting from a fixed default. */
  panels?: { right?: boolean; summary?: boolean; rightWidth?: number }
}

export type PendingAction = { type: 'send' | 'insert'; text: string }

type SessionsStore = {
  sessions: Session[]
  projects: Project[]
  activeSessionId: string | null
  /** The window is minimised or another app has focus, so even the active
   *  chat is not being watched. Not persisted: a launch starts in front. */
  windowAway: boolean
  pendingAction: PendingAction | null
  createSession: (cwd: string, projectId?: string | null) => string
  createProject: (path: string, name?: string) => string
  renameProject: (projectId: string, name: string) => void
  setProjectPath: (projectId: string, path: string) => void
  removeProject: (projectId: string) => void
  setProjectCollapsed: (projectId: string, collapsed: boolean) => void
  reorderProjects: (orderedIds: string[]) => void
  setSessionProject: (sessionId: string, projectId: string | null) => void
  setActiveSession: (id: string) => void
  /** The window lost focus (alt-tab, minimise) or got it back. Counted towards
   *  the recap's time away exactly like switching to another chat. */
  setWindowAway: (away: boolean) => void
  addMessage: (sessionId: string, message: Message) => void
  updateToolResult: (sessionId: string, toolId: string, content: string) => void
  updateToolInput: (sessionId: string, toolId: string, input: Record<string, unknown>) => void
  markToolDenied: (sessionId: string, toolId: string) => void
  setAutoAcceptEdits: (sessionId: string, value: boolean) => void
  /** Override a spawn setting for one conversation. */
  setSessionSettings: (
    sessionId: string,
    partial: Partial<Pick<Session, 'planMode' | 'model' | 'effort'>>
  ) => void
  setSessionPanels: (sessionId: string, partial: NonNullable<Session['panels']>) => void
  /** Record what `system/init` said this chat's process actually resolved to. */
  noteResolvedModel: (sessionId: string, requested: string, id: string) => void
  setExecuting: (sessionId: string, executing: { title: string; startedAt: number } | null) => void
  setNeedsAnswer: (sessionId: string, value: boolean) => void
  /** One completed turn. Also what the recap counts the away window in. */
  noteTurn: (sessionId: string) => void
  /** Put the recap away. It does not come back for the same window. */
  dismissAway: (sessionId: string) => void
  updateClaudeSessionId: (sessionId: string, claudeSessionId: string | null) => void
  updateSessionCwd: (sessionId: string, cwd: string) => void
  clearMessages: (sessionId: string) => void
  restartSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void
  applyAiTitle: (sessionId: string, title: string) => void
  toggleFavorite: (sessionId: string) => void
  reorderFavorites: (orderedIds: string[]) => void
  /**
   * Put a chat in the Archived page, or bring it back.
   *
   * Only the flag: stopping the process and retiring the worktree happen in
   * `lib/archive.ts`, which has to await a snapshot before it can say the chat
   * is safely away. Archiving also unpins — Pinned is a shelf you work from.
   */
  setArchivedAt: (sessionId: string, at: number | null) => void
  deleteSession: (sessionId: string) => void
  addTask: (sessionId: string, task: Task) => void
  updateTask: (sessionId: string, taskId: string, updates: Partial<Task>) => void
  setTasks: (sessionId: string, tasks: Task[]) => void
  setTaskId: (sessionId: string, toolId: string, realTaskId: string) => void
  removeTask: (sessionId: string, taskId: string) => void
  addUsage: (sessionId: string, delta: SessionUsage) => void
  addAgent: (sessionId: string, agent: Agent) => void
  updateAgent: (sessionId: string, toolId: string, updates: Partial<Agent>) => void
  addPullRequest: (sessionId: string, pr: PullRequest) => void
  updatePullRequest: (sessionId: string, url: string, updates: Partial<PullRequest>) => void
  setGitInfo: (sessionId: string, info: { isGitRepo: boolean; branch?: string }) => void
  setWorktree: (sessionId: string, worktree: WorktreeInfo | null) => void
  setPendingWorktree: (sessionId: string, pending: PendingWorktree | null) => void
  setWorktreeSnapshotted: (sessionId: string, value: boolean) => void
  setMcpServers: (sessionId: string, servers: McpServerInfo[]) => void
  enqueueMessage: (sessionId: string, msg: QueuedMessage) => void
  /** Takes the next queued message off the front, or null if the queue is empty. */
  dequeueMessage: (sessionId: string) => QueuedMessage | null
  removeQueuedMessage: (sessionId: string, index: number) => void
  clearQueue: (sessionId: string) => void
  forkSession: (sourceSessionId: string, upToMessageId?: string) => string
  truncateAtMessage: (sessionId: string, messageId: string) => void
  setAutoCompacted: (sessionId: string, value: boolean) => void
  setPendingAutoCompact: (sessionId: string, value: boolean) => void
  setPendingAction: (action: PendingAction) => void
  clearPendingAction: () => void
}

/** The threshold from Settings, in ms, or null when the recap is switched off. */
function awayThresholdMs(): number | null {
  const { awayRecap, awayRecapMinutes } = useSettingsStore.getState()
  if (!awayRecap) return null
  return Math.max(1, awayRecapMinutes) * 60 * 1000
}

/** Stop seeing a chat. Remembers how many turns you had actually seen, so the
 *  recap can say what ran after you stopped watching rather than counting the
 *  whole conversation. */
function leave(s: Session): Session {
  return { ...s, turnsSeen: s.turns ?? 0, leftAt: Date.now() }
}

/** See a chat again, and open the away window if it worked without you for long
 *  enough to be worth one.
 *
 *  What is measured is the work you missed, not the time you were gone: the
 *  clock runs from when you left until the turn finished, or until now if it
 *  is still going. A chat that wrapped up a few seconds after you switched away
 *  has nothing to recap however long you stay away — its last message is right
 *  there at the bottom. */
function cameBack(s: Session): Session {
  const seen = { ...s, unread: 0, leftAt: undefined }
  if (!s.unread) return s.leftAt === undefined ? s : seen
  const threshold = awayThresholdMs()
  // `unread` is about to be cleared, so the window it describes has to be
  // pinned down now or it is gone: the first message you have not seen is
  // `unread` from the end.
  const first = s.messages[s.messages.length - s.unread]
  const since = first?.timestamp ?? 0
  const running = useRunningStore.getState().running[s.id] === true
  const until = running ? Date.now() : (s.messages[s.messages.length - 1]?.timestamp ?? since)
  const ms = Math.max(0, until - (s.leftAt ?? since))
  if (threshold === null || ms < threshold) return seen
  return { ...seen, away: { since, turnsAtLeave: s.turnsSeen ?? 0, ms } }
}

export const useSessionsStore = create<SessionsStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      projects: [],
      activeSessionId: null,
      windowAway: false,
      pendingAction: null,

      createSession: (cwd: string, projectId: string | null = null) => {
        const id = crypto.randomUUID()
        const session: Session = {
          id,
          claudeSessionId: null,
          title: 'New session',
          cwd,
          projectId,
          createdAt: Date.now(),
          messages: [],
          tasks: [],
          agents: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
        }
        set((state) => ({ sessions: [session, ...state.sessions], activeSessionId: id }))
        return id
      },

      createProject: (path: string, name?: string) => {
        // Adding a folder that is already a project selects it rather than
        // producing a second row pointing at the same checkout.
        const existing = get().projects.find((p) => p.path === path)
        if (existing) return existing.id
        const id = crypto.randomUUID()
        set((state) => ({
          projects: [
            ...state.projects,
            {
              id,
              name: name?.trim() || nameForPath(path, state.projects.map((p) => p.name)),
              path,
              order: state.projects.length
            }
          ]
        }))
        return id
      },

      renameProject: (projectId: string, name: string) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, name: name.trim() || p.name } : p
          )
        }))
      },

      setProjectPath: (projectId: string, path: string) => {
        set((state) => ({
          projects: state.projects.map((p) => (p.id === projectId ? { ...p, path } : p)),
          // Chats running in the old location keep their own cwd; only ones that
          // tracked the project root follow it.
          sessions: state.sessions.map((s) => {
            if (s.projectId !== projectId || s.worktree) return s
            const project = state.projects.find((p) => p.id === projectId)
            return project && s.cwd === project.path ? { ...s, cwd: path } : s
          })
        }))
      },

      removeProject: (projectId: string) => {
        // The project's shells go with it; nothing else can reach them afterwards.
        for (const id of useTerminalsStore.getState().dropProject(projectId)) {
          try { window.api.terminal.kill(id) } catch { /* ignore */ }
        }
        // Chats are never destroyed with the project — they fall back to Recents,
        // so removing a folder from the rail can't silently take history with it.
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== projectId),
          sessions: state.sessions.map((s) =>
            s.projectId === projectId ? { ...s, projectId: null } : s
          )
        }))
      },

      setProjectCollapsed: (projectId: string, collapsed: boolean) => {
        set((state) => ({
          projects: state.projects.map((p) => (p.id === projectId ? { ...p, collapsed } : p))
        }))
      },

      reorderProjects: (orderedIds: string[]) => {
        const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
        set((state) => ({
          projects: state.projects.map((p) =>
            orderMap.has(p.id) ? { ...p, order: orderMap.get(p.id) } : p
          )
        }))
      },

      setSessionProject: (sessionId: string, projectId: string | null) => {
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, projectId } : s))
        }))
      },

      setActiveSession: (id: string) => {
        set((state) => ({
          activeSessionId: id,
          sessions: state.sessions.map((s) => {
            // Already out of sight with the window, so it left then, not now.
            // Leaving also puts away a recap you had on screen: it was read, and
            // the next time back is judged on its own.
            if (s.id === state.activeSessionId && s.id !== id) {
              return state.windowAway ? { ...s, away: null } : { ...leave(s), away: null }
            }
            return s.id === id && s.id !== state.activeSessionId ? cameBack(s) : s
          })
        }))
      },

      setWindowAway: (away: boolean) => {
        set((state) => {
          if (state.windowAway === away) return state
          return {
            windowAway: away,
            // Only the chat on screen changes: every other one is already out
            // of sight, and keeps the time it left at. A minute in another chat
            // and a minute minimised are two minutes away from the first.
            sessions: state.sessions.map((s) =>
              s.id !== state.activeSessionId ? s : away ? leave(s) : cameBack(s)
            )
          }
        })
      },

      noteTurn: (sessionId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, turns: (s.turns ?? 0) + 1 } : s
          )
        }))
      },

      dismissAway: (sessionId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, away: null, turnsSeen: s.turns ?? 0 } : s
          )
        }))
      },

      addMessage: (sessionId: string, message: Message) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            const stamped = message.timestamp ? message : { ...message, timestamp: Date.now() }
            // The one choke point where uniqueness can be guaranteed, whatever a
            // caller passed. The transcript is virtualized and keys on this id;
            // a duplicate makes React reuse the wrong row and the measured
            // heights land on the wrong index, which draws messages on top of
            // each other.
            const unique = s.messages.some((m) => m.id === stamped.id)
              ? { ...stamped, id: newMessageId() }
              : stamped
            const messages = [...s.messages, unique]
            const title =
              s.title === 'New session' && unique.role === 'user'
                ? (unique as TextMessage).text.slice(0, 40)
                : s.title
            // Your own messages are not news, and neither is anything in the chat
            // you are looking at — it is on screen as it arrives. The active chat
            // behind a minimised window is not being looked at.
            const onScreen = state.activeSessionId === sessionId && !state.windowAway
            const unread = unique.role === 'user' || onScreen ? s.unread : (s.unread ?? 0) + 1
            return { ...s, messages, title, unread }
          })
        }))
      },

      updateToolResult: (sessionId: string, toolId: string, content: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.role === 'tool_call' && (m as ToolCallMessage).tool_id === toolId
                  ? { ...m, result: content }
                  : m
              )
            }
          })
        }))
      },

      /**
       * Rewrite a tool call's input where it already sits.
       *
       * A plan is edited as often as it is written whole, and every edit arrives
       * as a fresh tool call. Appending one card per edit left a column of
       * near-identical plans; this keeps the first and refreshes its text.
       */
      updateToolInput: (sessionId: string, toolId: string, input: Record<string, unknown>) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.role === 'tool_call' && (m as ToolCallMessage).tool_id === toolId
                  ? { ...m, input }
                  : m
              )
            }
          })
        }))
      },

      /** For a tool call the user turned down after the fact, like a plan. */
      markToolDenied: (sessionId: string, toolId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.role === 'tool_call' && (m as ToolCallMessage).tool_id === toolId
                  ? { ...m, denied: true }
                  : m
              )
            }
          })
        }))
      },

      setNeedsAnswer: (sessionId, value) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, needsAnswer: value } : s
          )
        }))
      },

      setExecuting: (sessionId, executing) => {
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, executing } : s))
        }))
      },

      setAutoAcceptEdits: (sessionId: string, value: boolean) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, autoAcceptEdits: value } : s
          )
        }))
      },

      setSessionSettings: (sessionId, partial) => {
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...partial } : s))
        }))
      },

      noteResolvedModel: (sessionId, requested, id) => {
        // Checked before `set`, because rebuilding the array re-renders every
        // chat row and this says the same thing every turn of a long chat.
        const current = get().sessions.find((s) => s.id === sessionId)
        if (!current) return
        const at = current.resolvedModel
        if (at && at.requested === requested && at.id === id) return
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, resolvedModel: { requested, id } } : s
          )
        }))
      },

      setSessionPanels: (sessionId, partial) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, panels: { ...s.panels, ...partial } } : s
          )
        }))
      },

      updateClaudeSessionId: (sessionId: string, claudeSessionId: string | null) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, claudeSessionId } : s
          )
        }))
      },

      updateSessionCwd: (sessionId: string, cwd: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, cwd } : s
          )
        }))
      },

      clearMessages: (sessionId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, messages: [], tasks: [], agents: [], usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, title: 'New session', titleManual: false, autoCompacted: false, pendingAutoCompact: false } : s
          )
        }))
      },

      restartSession: (sessionId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, claudeSessionId: null, autoCompacted: false, pendingAutoCompact: false } : s
          )
        }))
      },

      renameSession: (sessionId: string, title: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, title: title.trim() || s.title, titleManual: true } : s
          )
        }))
      },

      /**
       * The title Claude gave the conversation.
       *
       * A new chat is named after the first thing you typed into it, cut off
       * mid-word at forty characters. The CLI writes a real title into the
       * session transcript a few seconds later, and the Rust side reports it
       * here — so the placeholder only has to hold for one turn.
       *
       * It keeps up with Claude's own later revisions, and stops the moment you
       * rename the chat yourself: a name you typed is never overwritten.
       */
      applyAiTitle: (sessionId: string, title: string) => {
        const next = title.trim().slice(0, 80)
        if (!next) return
        // Checked before `set`, because rebuilding the array re-renders every
        // chat row — and a title Claude has not changed arrives on every turn.
        const current = get().sessions.find((s) => s.id === sessionId)
        if (!current || current.titleManual || current.title === next) return
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: next } : s))
        }))
      },

      toggleFavorite: (sessionId: string) => {
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return state
          const turningOn = !target.favorite
          // New favorites append to the bottom of the manual order, preserving existing arrangement.
          const maxOrder = state.sessions.reduce(
            (m, s) => (s.favorite ? Math.max(m, s.favoriteOrder ?? 0) : m),
            -1
          )
          return {
            sessions: state.sessions.map((s) =>
              s.id === sessionId
                ? {
                    ...s,
                    favorite: turningOn,
                    favoriteOrder: turningOn ? maxOrder + 1 : s.favoriteOrder
                  }
                : s
            )
          }
        })
      },

      reorderFavorites: (orderedIds: string[]) => {
        set((state) => {
          const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
          return {
            sessions: state.sessions.map((s) =>
              orderMap.has(s.id) ? { ...s, favoriteOrder: orderMap.get(s.id) } : s
            )
          }
        })
      },

      setArchivedAt: (sessionId: string, at: number | null) => {
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return state
          if ((target.archivedAt ?? null) === at) return state
          const sessions = state.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  archivedAt: at,
                  // Putting a chat away unpins it: Pinned is the shelf you work
                  // from, and a chat you just set aside is not on it.
                  ...(at ? { favorite: false } : {})
                }
              : s
          )
          // An archived chat cannot stay on screen — the page it would be shown
          // on is the one you just left it out of. Fall back to the first chat
          // still in the rail, or to nothing at all.
          const activeSessionId =
            at && state.activeSessionId === sessionId
              ? (sessions.find((s) => !s.archivedAt)?.id ?? null)
              : state.activeSessionId
          return { sessions, activeSessionId }
        })
      },

      deleteSession: (sessionId: string) => {
        // Tear down the long-lived Claude PTY for this session before forgetting it
        try { window.api.claude.dispose(sessionId) } catch { /* ignore */ }
        // Drop any in-flight flag too, or a session deleted mid-turn leaves a
        // spinner behind on a row that no longer exists.
        useRunningStore.getState().forget(sessionId)
        // And the chat's browser. A context costs real memory, so a deleted
        // chat must not keep one alive with nothing left to show it in.
        try { window.api.browser.closeChat(sessionId) } catch { /* ignore */ }
        useBrowserStore.getState().forget(sessionId)
        // And its side-panel tabs, which outlive the browser and would otherwise
        // be restored forever for a chat that is gone.
        useWorkspaceStore.getState().forget(sessionId)
        // And the /mcp or /status view it had open above the composer: there is
        // no chat left for one to belong to.
        useResourceDockStore.getState().forget(sessionId)
        // Take the chat's managed worktree with it, snapshotting first — a
        // permanent one is shared with other chats and stays put. Fire-and-forget
        // so deleting a chat never blocks on git.
        const doomed = get().sessions.find((s) => s.id === sessionId)
        if (doomed?.worktreeSnapshotted) {
          void window.api.git.snapshotDiscard(sessionId).catch(() => {})
        }
        if (doomed?.worktree && !doomed.worktree.permanent) {
          const { path, branch } = doomed.worktree
          try {
            void window.api.git
              .worktreeSnapshot(path, branch, sessionId)
              .then(() => window.api.git.worktreeRemove(path, path))
          } catch { /* ignore */ }
        }
        set((state) => {
          const sessions = state.sessions.filter((s) => s.id !== sessionId)
          const activeSessionId =
            state.activeSessionId === sessionId
              ? (sessions[0]?.id ?? null)
              : state.activeSessionId
          return { sessions, activeSessionId }
        })
      },

      addTask: (sessionId: string, task: Task) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, tasks: [...(s.tasks ?? []), task] } : s
          )
        }))
      },

      setTasks: (sessionId: string, tasks: Task[]) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, tasks } : s
          )
        }))
      },

      updateTask: (sessionId: string, taskId: string, updates: Partial<Task>) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              tasks: (s.tasks ?? []).map((t) =>
                t.taskId === taskId ? { ...t, ...updates } : t
              )
            }
          })
        }))
      },

      setTaskId: (sessionId: string, toolId: string, realTaskId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              tasks: (s.tasks ?? []).map((t) =>
                t.createdByToolId === toolId ? { ...t, taskId: realTaskId } : t
              )
            }
          })
        }))
      },

      removeTask: (sessionId: string, taskId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return { ...s, tasks: (s.tasks ?? []).filter((t) => t.taskId !== taskId) }
          })
        }))
      },

      addUsage: (sessionId: string, delta: SessionUsage) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            const u = s.usage
            return {
              ...s,
              usage: {
                inputTokens: u.inputTokens + delta.inputTokens,
                outputTokens: u.outputTokens + delta.outputTokens,
                cacheCreationTokens: u.cacheCreationTokens + delta.cacheCreationTokens,
                cacheReadTokens: u.cacheReadTokens + delta.cacheReadTokens
              }
            }
          })
        }))
      },

      /**
       * Record a PR this chat opened.
       *
       * Deduped on URL rather than appended, because the same PR arrives twice
       * routinely: `gh pr create` on a branch that already has one answers with
       * that PR's URL, so a retried turn reports it again. The second sighting
       * patches the first — `state` and `title` land later, from `gh pr view` —
       * and `createdAt` stays at the first, which is when this chat made it.
       */
      addPullRequest: (sessionId: string, pr: PullRequest) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            const existing = s.pullRequests ?? []
            const at = existing.findIndex((p) => p.url === pr.url)
            if (at === -1) return { ...s, pullRequests: [...existing, pr] }
            const merged = existing.slice()
            merged[at] = { ...merged[at], ...pr, createdAt: merged[at].createdAt }
            return { ...s, pullRequests: merged }
          })
        }))
      },

      updatePullRequest: (sessionId: string, url: string, updates: Partial<PullRequest>) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              pullRequests: (s.pullRequests ?? []).map((p) =>
                p.url === url ? { ...p, ...updates } : p
              )
            }
          })
        }))
      },

      addAgent: (sessionId: string, agent: Agent) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, agents: [...(s.agents ?? []), agent] } : s
          )
        }))
      },

      updateAgent: (sessionId: string, toolId: string, updates: Partial<Agent>) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              agents: (s.agents ?? []).map((a) =>
                a.toolId === toolId ? { ...a, ...updates } : a
              )
            }
          })
        }))
      },

      setGitInfo: (sessionId: string, info: { isGitRepo: boolean; branch?: string }) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, isGitRepo: info.isGitRepo, branch: info.branch } : s
          )
        }))
      },

      setWorktree: (sessionId: string, worktree: WorktreeInfo | null) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, worktree, ...(worktree ? { branch: worktree.branch } : {}) } : s
          )
        }))
      },

      setPendingWorktree: (sessionId: string, pending: PendingWorktree | null) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, pendingWorktree: pending } : s
          )
        }))
      },

      setWorktreeSnapshotted: (sessionId: string, value: boolean) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, worktreeSnapshotted: value } : s
          )
        }))
      },

      setMcpServers: (sessionId: string, servers: McpServerInfo[]) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, mcpServers: servers } : s
          )
        }))
      },

      enqueueMessage: (sessionId: string, msg: QueuedMessage) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, queuedMessages: [...queueOf(s), msg], queuedMessage: null }
              : s
          )
        }))
      },

      dequeueMessage: (sessionId: string) => {
        let next: QueuedMessage | null = null
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            const queue = queueOf(s)
            if (queue.length === 0) return { ...s, queuedMessages: [], queuedMessage: null }
            next = queue[0]
            return { ...s, queuedMessages: queue.slice(1), queuedMessage: null }
          })
        }))
        return next
      },

      removeQueuedMessage: (sessionId: string, index: number) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  queuedMessages: queueOf(s).filter((_, i) => i !== index),
                  queuedMessage: null
                }
              : s
          )
        }))
      },

      clearQueue: (sessionId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, queuedMessages: [], queuedMessage: null } : s
          )
        }))
      },

      forkSession: (sourceSessionId: string, upToMessageId?: string) => {
        let newId = ''
        set((state) => {
          const source = state.sessions.find((s) => s.id === sourceSessionId)
          if (!source) return state

          const cutIndex = upToMessageId
            ? source.messages.findIndex((m) => m.id === upToMessageId)
            : source.messages.length
          const sliceEnd = cutIndex === -1 ? source.messages.length : cutIndex

          const messages = source.messages.slice(0, sliceEnd).map((m) => ({
            ...m,
            id: crypto.randomUUID()
          }))

          const lastMsgId = messages.length > 0 ? source.messages[sliceEnd - 1]?.id ?? '' : ''

          newId = crypto.randomUUID()
          const forked: Session = {
            id: newId,
            claudeSessionId: null,
            title: `${source.title.slice(0, 30)} – fork`,
            // Ours, not a placeholder: the suffix is the only thing on screen
            // that says this chat is a fork, so Claude's title must not eat it.
            titleManual: true,
            cwd: source.cwd,
            // A fork belongs to the same project as its source. Without this it
            // would drop into Recents and look lost.
            projectId: source.projectId ?? null,
            createdAt: Date.now(),
            messages,
            tasks: [],
            agents: [],
            branch: source.branch,
            isGitRepo: source.isGitRepo,
            worktree: null,
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            mcpServers: source.mcpServers ? [...source.mcpServers] : undefined,
            forkOf: { sessionId: sourceSessionId, messageId: lastMsgId, title: source.title }
          }
          return {
            sessions: [forked, ...state.sessions],
            activeSessionId: newId
          }
        })
        return newId
      },

      truncateAtMessage: (sessionId: string, messageId: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            const idx = s.messages.findIndex((m) => m.id === messageId)
            if (idx === -1) return s
            return {
              ...s,
              messages: s.messages.slice(0, idx),
              claudeSessionId: null,
              tasks: [],
              agents: [],
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
            }
          })
        }))
      },

      setAutoCompacted: (sessionId: string, value: boolean) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, autoCompacted: value } : s
          )
        }))
      },

      setPendingAutoCompact: (sessionId: string, value: boolean) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, pendingAutoCompact: value } : s
          )
        }))
      },

      setPendingAction: (action: PendingAction) => {
        set({ pendingAction: action })
      },

      clearPendingAction: () => {
        set({ pendingAction: null })
      }
    }),
    {
      name: 'nyra-sessions',
      // Async IndexedDB backend with coalesced writes — avoids localStorage's
      // synchronous writes and ~5–10 MB quota (which silently dropped sessions).
      storage: createIdbStorage<PersistedState>(),
      partialize: (state) => ({
        sessions: state.sessions,
        projects: state.projects,
        activeSessionId: state.activeSessionId
      }),
      skipHydration: true,
      merge: (persisted, current) => {
        const stored = persisted as Partial<SessionsStore> | undefined
        const normalized = (stored?.sessions ?? current.sessions).map((s) => ({
          ...s,
          tasks: s.tasks ?? [],
          agents: s.agents ?? [],
          usage: s.usage ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
        }))
        // Pre-projects records have a cwd and no projectId. Give them one here so
        // nothing lands in Recents just because it predates the feature.
        // Worktree sessions can't be resolved synchronously — see
        // attachWorktreeSessions, which finishes the job after hydration.
        const { sessions, projects } = backfillProjects(normalized, stored?.projects ?? [])
        return { ...current, ...stored, sessions, projects }
      },
    }
  )
)

// ---- selectors ----
//
// Every consumer used to hand-roll `sessions.find(...)?.cwd ?? localStorage'cwd'`,
// which is how a single mutable global ended up deciding where chats ran. These
// are the one place that question gets answered. Components that want a *chat's*
// directory call `cwdForSession`; components that want a *project's* (skills,
// memory, hooks, terminals) call `activeProjectCwd`.

export function findSession(state: SessionsStore, sessionId: string | null | undefined): Session | null {
  if (!sessionId) return null
  return state.sessions.find((s) => s.id === sessionId) ?? null
}

export function activeSession(state: SessionsStore): Session | null {
  return findSession(state, state.activeSessionId)
}

export function findProject(state: SessionsStore, projectId: string | null | undefined): Project | null {
  if (!projectId) return null
  return state.projects.find((p) => p.id === projectId) ?? null
}

export function projectForSession(state: SessionsStore, sessionId: string | null | undefined): Project | null {
  return findProject(state, findSession(state, sessionId)?.projectId)
}

export function activeProject(state: SessionsStore): Project | null {
  return projectForSession(state, state.activeSessionId)
}

/** Where a chat runs. Empty string means "not known yet" — callers fall back to `~`. */
export function cwdForSession(state: SessionsStore, sessionId: string | null | undefined): string {
  const session = findSession(state, sessionId)
  if (session?.cwd) return session.cwd
  return projectForSession(state, sessionId)?.path ?? ''
}

export function activeCwd(state: SessionsStore): string {
  return cwdForSession(state, state.activeSessionId)
}

/**
 * The project root for the active chat.
 *
 * Differs from `activeCwd` for a worktree chat: the chat runs in the worktree,
 * but its skills, memory and terminals belong to the project.
 */
export function activeProjectCwd(state: SessionsStore): string {
  return activeProject(state)?.path ?? activeCwd(state)
}

/**
 * Projects in rail order.
 *
 * Takes the array, not the store: it allocates, so passing it straight to
 * `useSessionsStore` would hand back a new reference on every render and loop
 * forever. Subscribe to `state.projects` and memoise this over it.
 */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function sessionsForProject(state: SessionsStore, projectId: string): Session[] {
  return state.sessions.filter((s) => s.projectId === projectId)
}

/** Chats with no project — the Recents section. */
export function orphanSessions(state: SessionsStore): Session[] {
  const known = new Set(state.projects.map((p) => p.id))
  return state.sessions.filter((s) => !s.projectId || !known.has(s.projectId))
}

/** True when a chat has been put away — see `Session.archivedAt`. */
export function isArchived(session: Session): boolean {
  return !!session.archivedAt
}

/**
 * The chats the rail shows: everything but the ones that were archived.
 *
 * Takes the array rather than the store, like `sortProjects`, because it
 * allocates — a selector handing back a new array on every render never
 * settles under zustand's `Object.is` check.
 */
export function liveSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => !s.archivedAt)
}

/** The Archived page's list, most recently archived first. */
export function archivedSessions(sessions: Session[]): Session[] {
  return sessions.filter(isArchived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/**
 * Start a chat in whatever context the user is already in.
 *
 * ⌘N, a slash command typed with nothing open, the first message into an empty
 * app — all of them used to read the `localStorage['cwd']` global. They now
 * inherit the active chat's project and run at its root, or land in Recents under
 * the home directory when there is no project to inherit.
 */
export function createSiblingSession(): string {
  const state = useSessionsStore.getState()
  const project = activeProject(state)
  if (project) return state.createSession(project.path, project.id)
  return state.createSession(homedir(), null)
}

/** Add a folder as a project and open a chat in it. The "open a folder" gesture. */
export function openFolderAsProject(path: string): string {
  const store = useSessionsStore.getState()
  const projectId = store.createProject(path)
  return store.createSession(path, projectId)
}
