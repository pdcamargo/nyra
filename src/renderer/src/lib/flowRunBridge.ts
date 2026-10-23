/**
 * Where flow runs meet chats.
 *
 * The engine runs a flow and says what happens; this decides what a chat sees
 * of it. A run tied to a chat gets a card in that chat's transcript and a tab
 * in its side panel. A chat step pauses it there: Claude is handed the step,
 * and the composer carries the pause until it is continued. When the run ends
 * the chat is told, and Claude says how it went.
 *
 * Subscribed once, for the life of the window, rather than in `Chat`: `Chat`
 * unmounts while the Flows view is open, and a run that paused then must still
 * reach its chat.
 */
import type { FlowRunWait, WorkflowDefinition, WorkflowEvent } from '../../../shared/workflow-types'
import { useFlowRunsStore, type FlowRun } from '../store/flowRuns'
import { useSessionsStore, type ToolCallMessage } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { samePath } from './paths'
import { sendToChat } from './messageContext'
import { openFlowRunInPanel } from './openFile'
import { endNotice, handOverNotice, outputFromTranscript, pauseNotice, runContext } from './flowRuns'

/** The transcript card a run leaves in its chat. */
export const FLOW_RUN_TOOL = 'FlowRun'

/** Where each chat-step pause started, by `execution:node`, so a step that
 *  takes its output from the transcript only reads what came after it. */
const pauseMarks = new Map<string, string>()
const markKey = (executionId: string, nodeId: string): string => `${executionId}:${nodeId}`

function chatExists(chatId: string): boolean {
  return useSessionsStore.getState().sessions.some((s) => s.id === chatId)
}

/** The card, once per run per chat, and the run's tab in that chat's panel. */
function attachToChat(run: FlowRun, chatId: string): void {
  if (!chatExists(chatId)) return
  const store = useSessionsStore.getState()
  const session = store.sessions.find((s) => s.id === chatId)
  const toolId = `flow-${run.executionId}`
  if (!session?.messages.some((m) => m.role === 'tool_call' && (m as ToolCallMessage).tool_id === toolId)) {
    store.addMessage(chatId, {
      id: toolId,
      role: 'tool_call',
      tool_id: toolId,
      tool_name: FLOW_RUN_TOOL,
      input: { executionId: run.executionId, workflowId: run.workflowId, workflowName: run.workflowName },
      // A card, not a call in flight: nothing will ever answer it, and a turn
      // that ends with a result-less call marks it interrupted.
      result: ''
    })
  }
  openFlowRunInPanel(run.executionId, chatId)
}

/**
 * A chat for a run that has none — one a trigger started, or the canvas —
 * when it reaches a chat step. In the flow's project, or the one its folder
 * is, and without taking the screen: you are told by the sidebar, not moved.
 */
async function chatForRun(run: FlowRun, wait: FlowRunWait): Promise<string> {
  const sessions = useSessionsStore.getState()
  const wf = (await window.api.workflow.load(run.workflowId).catch(() => null)) as WorkflowDefinition | null
  const project =
    sessions.projects.find((p) => p.id === wf?.projectId) ??
    sessions.projects.find((p) => run.cwd && samePath(p.path, run.cwd))
  const previous = sessions.activeSessionId
  const chatId = sessions.createSession(project?.path ?? run.cwd, project?.id ?? null)
  // `createSession` selects the new chat; put the one you were in back.
  useSessionsStore.setState({ activeSessionId: previous })
  useSessionsStore.getState().renameSession(chatId, `${run.workflowName} · ${wait.label}`)
  return chatId
}

/** What a chat step hands on, given what this chat can do. */
export function effectiveOutput(wait: FlowRunWait): NonNullable<FlowRunWait['output']> {
  const mode = wait.output ?? 'final'
  // Handing over takes nyra_flow, and the chat only has it with the app tools.
  return mode === 'final' && !useSettingsStore.getState().appTools ? 'lastReply' : mode
}

async function pauseInChat(e: Extract<WorkflowEvent, { type: 'node:awaiting-chat' }>): Promise<void> {
  const store = useFlowRunsStore.getState()
  const wait: FlowRunWait = { ...e.wait, output: effectiveOutput(e.wait) }
  store.wait(e.executionId, wait)
  let run = useFlowRunsStore.getState().runs[e.executionId]
  if (!run) return

  let chatId = run.chatId ?? e.chatId
  if (!chatId || !chatExists(chatId)) {
    chatId = await chatForRun(run, wait)
    useFlowRunsStore.getState().link(e.executionId, chatId)
    run = useFlowRunsStore.getState().runs[e.executionId]
    attachToChat(run, chatId)
    void window.api.workflow.linkChat(e.executionId, chatId)
  }

  const messages = useSessionsStore.getState().sessions.find((s) => s.id === chatId)?.messages ?? []
  const last = messages[messages.length - 1]
  if (last) pauseMarks.set(markKey(e.executionId, wait.nodeId), last.id)

  sendToChat({
    sessionId: chatId,
    text: '',
    context: [runContext(`${run.workflowName} paused at ${wait.label}`, pauseNotice(run, wait), run.executionId)]
  })
  // After the send, which clears it: saying something answers whatever was
  // asked, and this is the chat being asked.
  useSessionsStore.getState().setNeedsAnswer(chatId, true)
}

function endInChat(run: FlowRun): void {
  if (!run.chatId || !chatExists(run.chatId)) return
  const chatId = run.chatId
  useSessionsStore.getState().setNeedsAnswer(chatId, false)
  // Stopping is something the user did; telling Claude to report it back to
  // them is a turn spent saying what they already know.
  if (run.status === 'aborted') return
  sendToChat({
    sessionId: chatId,
    text: '',
    context: [
      runContext(
        `${run.workflowName} ${run.status === 'done' ? 'finished' : 'failed'}`,
        endNotice(run),
        run.executionId
      )
    ]
  })
}

/** One engine event, applied. Exported for the tests. */
export function handleFlowEvent(e: WorkflowEvent): void {
  const store = useFlowRunsStore.getState()
  switch (e.type) {
    case 'execution:start':
      store.start(e.run)
      if (e.run.chatId) attachToChat(useFlowRunsStore.getState().runs[e.executionId], e.run.chatId)
      return
    case 'execution:linked': {
      const had = store.runs[e.executionId]?.chatId
      store.link(e.executionId, e.chatId)
      const run = useFlowRunsStore.getState().runs[e.executionId]
      if (run && !had) attachToChat(run, e.chatId)
      return
    }
    case 'node:start':
      store.node(e.executionId, e.nodeId, { status: 'running', startedAt: Date.now(), iteration: e.iteration })
      return
    case 'node:done': {
      const run = store.runs[e.executionId]
      if (run?.waits.some((w) => w.nodeId === e.nodeId)) {
        store.resume(e.executionId, e.nodeId)
        pauseMarks.delete(markKey(e.executionId, e.nodeId))
        if (run.chatId) useSessionsStore.getState().setNeedsAnswer(run.chatId, false)
      }
      store.node(e.executionId, e.nodeId, {
        status: 'done',
        output: e.output,
        finishedAt: Date.now(),
        iteration: e.iteration
      })
      return
    }
    case 'node:failed':
      store.node(e.executionId, e.nodeId, { status: 'failed', error: e.error, finishedAt: Date.now() })
      return
    case 'node:skipped':
      store.node(e.executionId, e.nodeId, { status: 'skipped' })
      return
    case 'node:awaiting-review':
      store.wait(e.executionId, {
        kind: 'review',
        nodeId: e.nodeId,
        label: e.request.label,
        message: e.request.message ?? null,
        input: e.request.prevOutput
      })
      return
    case 'node:awaiting-chat':
      void pauseInChat(e)
      return
    case 'variable:set':
      store.setVar(e.executionId, e.name, e.value)
      return
    case 'loop:iterate':
      store.node(e.executionId, e.nodeId, { iteration: e.iteration })
      return
    case 'execution:done':
    case 'execution:failed':
    case 'execution:aborted': {
      if (!store.runs[e.executionId]) return
      const status = e.type === 'execution:done' ? 'done' : e.type === 'execution:failed' ? 'failed' : 'aborted'
      store.finish(e.executionId, status, e.record, e.type === 'execution:failed' ? e.error : undefined)
      endInChat(useFlowRunsStore.getState().runs[e.executionId])
      return
    }
  }
}

/** Listen for as long as the window is open, starting from what is in flight. */
export function startFlowRunBridge(): () => void {
  void window.api.workflow
    .active()
    .then((snapshots) => useFlowRunsStore.getState().hydrate(snapshots))
    .catch(() => {})
  return window.api.workflow.onEvent((raw) => handleFlowEvent(raw as WorkflowEvent))
}

// ---- what the pause bar and the run tab do --------------------------------

/**
 * Carry a paused chat step on.
 *
 * A step whose output Claude writes asks Claude for it, and the run continues
 * when Claude calls back. One that takes it from the transcript continues now.
 * Returns why it could not, for the bar to say.
 */
export async function continueChatStep(run: FlowRun, wait: FlowRunWait): Promise<string | null> {
  const mode = wait.output ?? 'final'
  const chatId = run.chatId
  if (!chatId) return 'This run has no chat.'
  if (mode === 'final') {
    useFlowRunsStore.getState().setHandingOver(run.executionId, true)
    sendToChat({
      sessionId: chatId,
      text: '',
      context: [runContext(`Continue ${run.workflowName}`, handOverNotice(run, wait), run.executionId)]
    })
    return null
  }
  const messages = useSessionsStore.getState().sessions.find((s) => s.id === chatId)?.messages ?? []
  const output = outputFromTranscript(messages, mode, pauseMarks.get(markKey(run.executionId, wait.nodeId)))
  if (!output) return mode === 'user' ? 'Say something first: your last message is what carries on.' : 'Claude has not replied yet.'
  const { ok } = await window.api.workflow.reviewResponse(run.executionId, wait.nodeId, true, output)
  return ok ? null : 'The run is no longer waiting.'
}

export function stopRun(run: FlowRun): void {
  void window.api.workflow.abort(run.executionId)
}
