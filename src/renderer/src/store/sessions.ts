import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createIdbStorage } from './idbStorage'
import { useRunningStore } from './running'
import { useBrowserStore } from './browser'
import { backfillProjects, nameForPath } from './projects-migration'
import { homedir } from '../lib/homedir'
import { useTerminalsStore } from './terminals'

type PersistedState = { sessions: Session[]; projects: Project[]; activeSessionId: string | null }

export type ImageAttachment = { path: string; mediaType: string; dataUrl: string }

export type FileAttachment = {
  id: string
  name: string
  path: string
  size: number
  category: 'image' | 'document' | 'text'
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
}

export type McpServerInfo = {
  name: string
  status: 'connected' | 'failed' | 'pending'
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

export type Session = {
  id: string
  claudeSessionId: string | null
  title: string
  cwd: string
  createdAt: number
  messages: Message[]
  tasks: Task[]
  agents: Agent[]
  branch?: string
  isGitRepo?: boolean
  worktree?: WorktreeInfo | null
  usage: SessionUsage
  mcpServers?: McpServerInfo[]
  /** Messages typed while a turn was running, sent in order as it frees up. */
  queuedMessages?: QueuedMessage[]
  /** @deprecated Superseded by `queuedMessages`; still read so a persisted one drains. */
  queuedMessage?: QueuedMessage | null
  autoCompacted?: boolean
  pendingAutoCompact?: boolean
  forkOf?: { sessionId: string; messageId: string; title: string }
  favorite?: boolean
  /** Manual sort position within Pinned (lower = higher up). Decoupled from recency. */
  favoriteOrder?: number
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
}

export type PendingAction = { type: 'send' | 'insert'; text: string }

type SessionsStore = {
  sessions: Session[]
  projects: Project[]
  activeSessionId: string | null
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
  addMessage: (sessionId: string, message: Message) => void
  updateToolResult: (sessionId: string, toolId: string, content: string) => void
  markToolDenied: (sessionId: string, toolId: string) => void
  setAutoAcceptEdits: (sessionId: string, value: boolean) => void
  setExecuting: (sessionId: string, executing: { title: string; startedAt: number } | null) => void
  setNeedsAnswer: (sessionId: string, value: boolean) => void
  updateClaudeSessionId: (sessionId: string, claudeSessionId: string | null) => void
  updateSessionCwd: (sessionId: string, cwd: string) => void
  clearMessages: (sessionId: string) => void
  restartSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void
  toggleFavorite: (sessionId: string) => void
  reorderFavorites: (orderedIds: string[]) => void
  deleteSession: (sessionId: string) => void
  addTask: (sessionId: string, task: Task) => void
  updateTask: (sessionId: string, taskId: string, updates: Partial<Task>) => void
  setTasks: (sessionId: string, tasks: Task[]) => void
  setTaskId: (sessionId: string, toolId: string, realTaskId: string) => void
  removeTask: (sessionId: string, taskId: string) => void
  addUsage: (sessionId: string, delta: SessionUsage) => void
  addAgent: (sessionId: string, agent: Agent) => void
  updateAgent: (sessionId: string, toolId: string, updates: Partial<Agent>) => void
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

export const useSessionsStore = create<SessionsStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      projects: [],
      activeSessionId: null,
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
          sessions: state.sessions.map((s) => (s.id === id && s.unread ? { ...s, unread: 0 } : s))
        }))
      },

      addMessage: (sessionId: string, message: Message) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s
            const stamped = message.timestamp ? message : { ...message, timestamp: Date.now() }
            const messages = [...s.messages, stamped]
            const title =
              s.title === 'New session' && stamped.role === 'user'
                ? (stamped as TextMessage).text.slice(0, 40)
                : s.title
            // Your own messages are not news, and neither is anything in the chat
            // you are looking at — it is on screen as it arrives.
            const unread =
              stamped.role === 'user' || state.activeSessionId === sessionId
                ? s.unread
                : (s.unread ?? 0) + 1
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
            s.id === sessionId ? { ...s, messages: [], tasks: [], agents: [], usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, title: 'New session', autoCompacted: false, pendingAutoCompact: false } : s
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
            s.id === sessionId ? { ...s, title: title.trim() || s.title } : s
          )
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
        // Take the chat's managed worktree with it, snapshotting first — a
        // permanent one is shared with other chats and stays put. Fire-and-forget
        // so deleting a chat never blocks on git.
        const doomed = get().sessions.find((s) => s.id === sessionId)
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
