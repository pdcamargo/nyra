/**
 * The renderer's half of `nyra_chat`.
 *
 * Starting a chat: Rust asks once per call and waits up to ten minutes. This
 * puts the request in the asking chat's composer, and on a yes makes the chat
 * the way a flow run makes one — in the background, the screen left where it
 * was — and sends the prompt as its first message.
 *
 * Looking at chats: status only, never messages, by these rules —
 * - same workspace or nothing: another workspace is another Claude account,
 *   and is not even listed;
 * - a chat sees its own project's chats, and any chat it started;
 * - another project asks once, "In this chat" or "Always" (kept on the asking
 *   project, one direction only);
 * - a chat's last reply is readable by the chat that started it, and nobody else.
 */
import type { Effort } from '@shared/types'
import {
  useSessionsStore,
  workspaceIdOf,
  type Project,
  type Session,
  type TextMessage,
  type ToolCallMessage
} from '../store/sessions'
import {
  useChatRequestsStore,
  type ChatStartAnswer,
  type ChatStartRequest,
  type StatusAccessAnswer
} from '../store/chatRequests'
import { useRunningStore } from '../store/running'
import { useBackgroundAgentsStore } from '../store/backgroundAgents'
import { useProcessesStore } from '../store/processes'
import { usePendingPermissionsStore } from '../store/pendingPermissions'
import { usePlanApprovalStore } from '../store/planApprovals'
import { useSecretsStore } from '../store/secrets'
import { useDesktopStore } from '../store/desktop'
import { useLoopsStore } from '../store/loops'
import { useFlowRunsStore } from '../store/flowRuns'
import { minutes, waitingOn, wakesAt } from './backgroundWait'
import { shortToolName } from './sidebarStatus'
import { lastActivityOf } from './chatSort'
import { sendToChat } from './messageContext'
import { tabKey, usePanelTabsStore } from '../store/panelTabs'

/** The tool, as the transcript sees it. */
export const CHAT_TOOL = 'mcp__nyra-app__nyra_chat'

/** Rust gives up at 600s and 125s; drop each ask just before, so it never outlives the call. */
const START_LIFETIME_MS = 598_000
const PEEK_LIFETIME_MS = 118_000

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

type Refusal = { ok: false; error: string }
const refuse = (error: string): Refusal => ({ ok: false, error })

function sessionById(id: string): Session | undefined {
  return useSessionsStore.getState().sessions.find((s) => s.id === id)
}

/** A project, or the workspace's chats outside any, by `statusAccess` key. */
const keyOf = (session: Pick<Session, 'projectId'>): string => session.projectId ?? ''

function projectsIn(workspaceId: string): Project[] {
  return useSessionsStore.getState().projects.filter((p) => p.workspaceId === workspaceId)
}

function projectName(key: string): string {
  if (!key) return 'chats outside any project'
  return useSessionsStore.getState().projects.find((p) => p.id === key)?.name ?? 'another project'
}

/** A project in the asker's workspace by name, `''` for none asked. Undefined when nothing matches. */
function projectByName(workspaceId: string, name: string): Project | undefined {
  const wanted = name.trim().toLowerCase()
  return projectsIn(workspaceId).find((p) => p.name.toLowerCase() === wanted)
}

// ---------------------------------------------------------------------------
// Starting a chat
// ---------------------------------------------------------------------------

export function askChatStart(args: Record<string, unknown>): Promise<unknown> {
  const chatId = str(args.chatId)
  const asker = sessionById(chatId)
  if (!asker) return Promise.resolve(refuse('Only a chat in Nyra can start another one.'))
  const state = useSessionsStore.getState()
  const workspaceId = workspaceIdOf(state, asker)

  let projectId = asker.projectId ?? null
  const projectArg = str(args.project)
  if (projectArg) {
    const project = projectByName(workspaceId, projectArg)
    if (!project) {
      const names = projectsIn(workspaceId).map((p) => p.name)
      return Promise.resolve(
        refuse(
          `No project called "${projectArg}" in this workspace.${names.length ? ` There is ${names.join(', ')}.` : ''}`
        )
      )
    }
    projectId = project.id
  }

  const effort = (EFFORTS as readonly string[]).includes(str(args.effort)) ? (str(args.effort) as Effort) : ''
  const model = str(args.model)
  const planMode = args.planMode === true
  const requestId = `chat-${crypto.randomUUID()}`

  return new Promise((resolve) => {
    const timer = window.setTimeout(
      () => useChatRequestsStore.getState().settleStart(chatId, requestId, { outcome: 'withdrawn' }),
      START_LIFETIME_MS
    )
    useChatRequestsStore.getState().pushStart(chatId, {
      requestId,
      title: str(args.title),
      reason: str(args.reason),
      prompt: str(args.prompt),
      asked: { model, effort, planMode, projectId },
      model,
      effort,
      planMode,
      projectId,
      askedAt: Date.now(),
      resolve: (answer, request) => {
        window.clearTimeout(timer)
        closeRequestTab(chatId, requestId)
        resolve(startAnswer(chatId, request, answer))
      }
    })
  })
}

/** The prompt's tab goes with the request: there is nothing left to decide on it. */
function closeRequestTab(sessionId: string, requestId: string): void {
  const tabs = usePanelTabsStore.getState().bySession[sessionId]?.tabs ?? []
  const tab = tabs.find((t) => t.kind === 'chatRequest' && t.requestId === requestId)
  if (tab) usePanelTabsStore.getState().closeTab(sessionId, tabKey(tab))
}

export function answerChatStart(sessionId: string, requestId: string, answer: ChatStartAnswer): void {
  useChatRequestsStore.getState().settleStart(sessionId, requestId, answer)
}

/** The yes, no or note, as the tool result. A yes makes the chat here. */
function startAnswer(chatId: string, request: ChatStartRequest, answer: ChatStartAnswer): unknown {
  if (answer.outcome === 'withdrawn') return { ok: true, outcome: 'withdrawn' }
  if (answer.outcome === 'declined') {
    return { ok: true, outcome: 'declined', ...(answer.message ? { message: answer.message } : {}) }
  }
  const asker = sessionById(chatId)
  if (!asker) return { ok: true, outcome: 'withdrawn' }
  const id = startChat(asker, request, answer.open)
  const changed = (['model', 'effort', 'planMode', 'projectId'] as const).filter(
    (k) => request[k] !== request.asked[k]
  )
  return {
    ok: true,
    outcome: 'started',
    chat: id,
    title: request.title,
    project: request.projectId ? projectName(request.projectId) : null,
    model: request.model || 'default',
    effort: request.effort || 'default',
    planMode: request.planMode,
    ...(changed.length
      ? { changedByUser: changed.map((k) => (k === 'projectId' ? 'project' : k)) }
      : {})
  }
}

/** Make the chat and send it on its way. Returns its id. */
function startChat(asker: Session, request: ChatStartRequest, open: boolean): string {
  const store = useSessionsStore.getState()
  const project = request.projectId ? store.projects.find((p) => p.id === request.projectId) : undefined
  // A chat outside any project starts where its asker does.
  const cwd = project?.path ?? asker.cwd
  const previous = store.activeSessionId
  const id = store.createSession(cwd, project?.id ?? null)
  // `createSession` selects the new chat; put the one you were in back unless
  // you asked to go there.
  if (!open) useSessionsStore.setState({ activeSessionId: previous })
  const after = useSessionsStore.getState()
  after.renameSession(id, request.title)
  after.setSessionSettings(id, { model: request.model, effort: request.effort, planMode: request.planMode })
  const at = Date.now()
  after.setSpawnedBy(id, { sessionId: asker.id, title: asker.title, at }, workspaceIdOf(after, asker))

  sendToChat({
    sessionId: id,
    text: request.prompt,
    context: [
      {
        kind: 'spawned-by',
        label: `Started by Claude from “${asker.title}”`,
        // Nothing for Claude: the line is for you, and the prompt says what it needs.
        body: '',
        ref: { sessionId: asker.id }
      }
    ]
  })
  return id
}

// ---------------------------------------------------------------------------
// Seeing other chats
// ---------------------------------------------------------------------------

type Access = { ok: true } | Refusal

/** Whether `asker` may see `target`'s status, asking once for another project. */
async function access(asker: Session, target: Pick<Session, 'id' | 'projectId' | 'spawnedBy'>): Promise<Access> {
  if (target.id === asker.id || target.spawnedBy?.sessionId === asker.id) return { ok: true }
  return projectAccess(asker, keyOf(target))
}

async function projectAccess(asker: Session, key: string): Promise<Access> {
  if (key === keyOf(asker)) return { ok: true }
  const state = useSessionsStore.getState()
  const own = asker.projectId ? state.projects.find((p) => p.id === asker.projectId) : undefined
  if ((asker.statusGrants ?? []).includes(key)) return { ok: true }
  if (own?.statusAccess?.some((a) => a.projectId === key)) return { ok: true }

  const answer = await askStatusAccess(asker.id, key, !!own)
  if (answer === 'chat') {
    useSessionsStore.getState().grantStatusInChat(asker.id, key)
    return { ok: true }
  }
  if (answer === 'always' && own) {
    const current = useSessionsStore.getState().projects.find((p) => p.id === own.id)?.statusAccess ?? []
    useSessionsStore.getState().setProjectStatusAccess(own.id, [...current, { projectId: key, at: Date.now() }])
    return { ok: true }
  }
  return refuse(
    answer === 'no'
      ? `The user said no to showing you ${projectName(key)}. Don't ask again for it in this conversation.`
      : `Nobody answered whether you may see ${projectName(key)}.`
  )
}

function askStatusAccess(chatId: string, projectKey: string, canAlways: boolean): Promise<StatusAccessAnswer | 'dismissed'> {
  const key = `peek-${crypto.randomUUID()}`
  return new Promise((resolve) => {
    const timer = window.setTimeout(
      () => useChatRequestsStore.getState().settlePeek(chatId, key, 'dismissed'),
      PEEK_LIFETIME_MS
    )
    useChatRequestsStore.getState().pushPeek(chatId, {
      key,
      projectKey,
      projectName: projectName(projectKey),
      canAlways,
      resolve: (answer) => {
        window.clearTimeout(timer)
        resolve(answer)
      }
    })
  })
}

export function answerStatusAccess(sessionId: string, key: string, answer: StatusAccessAnswer): void {
  useChatRequestsStore.getState().settlePeek(sessionId, key, answer)
}

/** The asker and a chat it named, in the same workspace — or why not. */
function resolveTarget(args: Record<string, unknown>): { asker: Session; target: Session } | Refusal {
  const asker = sessionById(str(args.chatId))
  if (!asker) return refuse('Only a chat in Nyra can look at other chats.')
  const target = sessionById(str(args.chat))
  const state = useSessionsStore.getState()
  // Another workspace's chat reads exactly like one that does not exist.
  if (!target || workspaceIdOf(state, target) !== workspaceIdOf(state, asker)) {
    return refuse(`No chat ${str(args.chat)}. Use action:"list" for the ids.`)
  }
  return { asker, target }
}

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** What a running tool is doing, in a few words, for a status line. */
function toolDetail(call: ToolCallMessage): string {
  const input = call.input
  const what =
    str(input.description) || str(input.command) || str(input.file_path) || str(input.pattern) || str(input.url)
  return what ? `${shortToolName(call.tool_name)}: ${clip(what.split('\n')[0])}` : shortToolName(call.tool_name)
}

/** Why a chat is stopped on you, in words, or null. */
function waitingOnYou(id: string, session: Session): string | null {
  const permission = usePendingPermissionsStore.getState().bySession[id]
  if (permission) return `permission to use ${shortToolName(permission)}`
  if (Object.values(usePlanApprovalStore.getState().pending).includes(id)) return 'plan ready for approval'
  if (useSecretsStore.getState().bySession[id]?.length) return 'a secret'
  if (useDesktopStore.getState().bySession[id]?.asks.length) return 'access to another app'
  const asks = useChatRequestsStore.getState().bySession[id]
  if (asks?.starts.length) return 'approval to start a chat'
  if (asks?.peeks.length) return 'access to another project'
  if (session.needsAnswer) return 'an answer to a question'
  return null
}

/** One chat's state, as `list` and `status` report it. Never its messages. */
export function chatStatus(session: Session, asker: Session, now = Date.now()): Record<string, unknown> {
  const id = session.id
  const running = !!useRunningStore.getState().running[id]
  const startedAt = useRunningStore.getState().startedAt[id]
  const waiting = waitingOnYou(id, session)
  const background = waitingOn(
    useBackgroundAgentsStore.getState().bySession[id] ?? [],
    useProcessesStore.getState().bySession[id] ?? []
  )
  const subagents = session.agents
    .filter((a) => a.status === 'running')
    .map((a) => ({ name: a.name, ...(a.activity ? { doing: clip(a.activity) } : {}) }))
  const backgroundTasks = background
    .filter((t) => t.kind !== 'agent' || !subagents.length)
    .map((t) => ({ kind: t.kind === 'agent' ? 'subagent' : t.kind, what: clip(t.description) }))
  const wake = wakesAt(session, now)
  const loop = useLoopsStore.getState().loops.get(id)
  const flow = Object.values(useFlowRunsStore.getState().runs).find(
    (r) => r.chatId === id && (r.status === 'running' || r.status === 'paused')
  )

  let tool: string | undefined
  if (running) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m.role === 'user') break
      if (m.role === 'tool_call' && m.result === undefined) {
        tool = toolDetail(m)
        break
      }
    }
  }

  const state = waiting
    ? 'waiting on the user'
    : running
      ? 'running'
      : backgroundTasks.length || subagents.length || wake || flow
        ? 'idle, waiting on background work'
        : 'idle'
  const last = lastActivityOf(session, running)
  const project = session.projectId
    ? useSessionsStore.getState().projects.find((p) => p.id === session.projectId)?.name ?? null
    : null

  return {
    id,
    title: session.title,
    project,
    state,
    ...(waiting ? { waitingOn: waiting } : {}),
    ...(running && startedAt ? { runningFor: minutes(now - startedAt) } : {}),
    ...(!running ? { idleFor: minutes(now - last) } : {}),
    ...(tool ? { tool } : {}),
    ...(subagents.length ? { subagents } : {}),
    ...(backgroundTasks.length ? { background: backgroundTasks } : {}),
    ...(wake ? { wakesIn: minutes(wake - now), wakesAt: new Date(wake).toISOString() } : {}),
    ...(loop ? { loop: { every: minutes(loop.intervalMs), prompt: clip(loop.prompt) } } : {}),
    ...(flow ? { flow: { name: flow.workflowName, status: flow.status } } : {}),
    ...(session.spawnedBy?.sessionId === asker.id ? { startedByYou: true } : {}),
    ...(session.archivedAt ? { archived: true } : {})
  }
}

function visibleChats(asker: Session, key: string): Session[] {
  const state = useSessionsStore.getState()
  const workspaceId = workspaceIdOf(state, asker)
  return state.sessions.filter(
    (s) =>
      s.id !== asker.id &&
      !s.archivedAt &&
      // An empty chat is not a chat yet; the rail does not list it either.
      s.messages.length > 0 &&
      keyOf(s) === key &&
      workspaceIdOf(state, s) === workspaceId
  )
}

export async function listChats(args: Record<string, unknown>): Promise<unknown> {
  const asker = sessionById(str(args.chatId))
  if (!asker) return refuse('Only a chat in Nyra can look at other chats.')
  const workspaceId = workspaceIdOf(useSessionsStore.getState(), asker)
  let key = keyOf(asker)
  const name = str(args.project)
  if (name) {
    const project = projectByName(workspaceId, name)
    if (!project) return refuse(`No project called "${name}" in this workspace. action:"projects" lists them.`)
    key = project.id
  }
  // The chats it started are its to see wherever they are, without asking.
  const mine = useSessionsStore
    .getState()
    .sessions.filter((s) => s.spawnedBy?.sessionId === asker.id && keyOf(s) === key && !s.archivedAt)
  const allowed = await projectAccess(asker, key)
  const chats = allowed.ok ? visibleChats(asker, key) : mine
  if (!allowed.ok && mine.length === 0) return allowed
  const now = Date.now()
  return {
    ok: true,
    project: key ? projectName(key) : null,
    ...(!allowed.ok ? { note: 'Only the chats you started: the user did not open the rest of this project to you.' } : {}),
    chats: chats.map((s) => chatStatus(s, asker, now))
  }
}

export async function statusOfChat(args: Record<string, unknown>): Promise<unknown> {
  const found = resolveTarget(args)
  if ('ok' in found) return found
  const allowed = await access(found.asker, found.target)
  if (!allowed.ok) return allowed
  return { ok: true, ...chatStatus(found.target, found.asker) }
}

/**
 * The last reply of a chat this one started: its assistant text since the last
 * message of yours, which is what a turn's answer is. Status for anyone else.
 */
export function readChat(args: Record<string, unknown>): unknown {
  const found = resolveTarget(args)
  if ('ok' in found) return found
  const { asker, target } = found
  if (target.spawnedBy?.sessionId !== asker.id) {
    return refuse(
      'You can read the last reply only of a chat you started. For any other chat, action:"status" says what it is doing.'
    )
  }
  const texts: string[] = []
  for (let i = target.messages.length - 1; i >= 0; i--) {
    const m = target.messages[i]
    if (m.role === 'user') break
    if (m.role === 'assistant' && (m as TextMessage).text.trim()) texts.unshift((m as TextMessage).text.trim())
  }
  const status = chatStatus(target, asker)
  return {
    ok: true,
    chat: target.id,
    title: target.title,
    state: status.state,
    ...(status.state === 'running' ? { note: 'Still running: this is what it has said so far this turn.' } : {}),
    reply: texts.join('\n\n') || null
  }
}

export function listProjects(args: Record<string, unknown>): unknown {
  const asker = sessionById(str(args.chatId))
  if (!asker) return refuse('Only a chat in Nyra can look at other chats.')
  const state = useSessionsStore.getState()
  const workspaceId = workspaceIdOf(state, asker)
  const own = asker.projectId ? state.projects.find((p) => p.id === asker.projectId) : undefined
  const open = (key: string): boolean =>
    key === keyOf(asker) ||
    (asker.statusGrants ?? []).includes(key) ||
    !!own?.statusAccess?.some((a) => a.projectId === key)
  return {
    ok: true,
    projects: projectsIn(workspaceId).map((p) => ({
      name: p.name,
      ...(p.id === asker.projectId ? { thisChat: true } : {}),
      statusVisible: open(p.id)
    })),
    note: 'Starting a chat in any of these is up to the user each time. Seeing the status of one that is not visible asks them once.'
  }
}
