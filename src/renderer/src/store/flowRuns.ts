import { create } from 'zustand'
import type {
  FlowRunSnapshot,
  FlowRunSummary,
  FlowRunWait,
  WorkflowExecutionRecord,
  WorkflowNodeRunState
} from '../../../shared/workflow-types'

export type FlowRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'aborted'

/**
 * A run as the app follows it, whoever started it.
 *
 * The canvas has its own `execution`, which is one run of the flow on screen.
 * This is every run, keyed by id, because a run belongs to a chat now and two
 * chats can each have one going while the canvas shows a third.
 */
export type FlowRun = FlowRunSummary & {
  status: FlowRunStatus
  nodeStates: Record<string, WorkflowNodeRunState>
  vars: Record<string, string>
  /** What paused steps are waiting on. Normally none or one. */
  waits: FlowRunWait[]
  finishedAt?: number
  error?: string
  /** Continue was pressed on a step whose output Claude writes, and Claude has
   *  been asked for it. Cleared when the step is answered. */
  handingOver?: boolean
}

type FlowRunsState = {
  runs: Record<string, FlowRun>
  /** Chats whose finished runs have been read off disk. */
  historyLoaded: Record<string, true>
  start: (run: FlowRunSummary) => void
  hydrate: (snapshots: FlowRunSnapshot[]) => void
  link: (executionId: string, chatId: string) => void
  node: (executionId: string, nodeId: string, patch: Partial<WorkflowNodeRunState>) => void
  setVar: (executionId: string, name: string, value: string) => void
  wait: (executionId: string, wait: FlowRunWait) => void
  /** A paused step was answered, by anyone. */
  resume: (executionId: string, nodeId: string) => void
  setHandingOver: (executionId: string, value: boolean) => void
  finish: (executionId: string, status: Exclude<FlowRunStatus, 'running' | 'paused'>, record?: WorkflowExecutionRecord, error?: string) => void
  /** Finished runs of one chat, read from their records, for after a restart. */
  addHistory: (chatId: string, runs: FlowRun[]) => void
}

function patchRun(state: FlowRunsState, id: string, change: (run: FlowRun) => FlowRun): Partial<FlowRunsState> | FlowRunsState {
  const run = state.runs[id]
  if (!run) return state
  return { runs: { ...state.runs, [id]: change(run) } }
}

export const useFlowRunsStore = create<FlowRunsState>()((set) => ({
  runs: {},
  historyLoaded: {},

  start: (run) =>
    set((s) => ({
      runs: {
        ...s.runs,
        [run.executionId]: { ...run, status: 'running', nodeStates: {}, vars: {}, waits: [] }
      }
    })),

  hydrate: (snapshots) =>
    set((s) => {
      const runs = { ...s.runs }
      for (const snap of snapshots) {
        runs[snap.executionId] = {
          ...snap,
          status: snap.waits.length > 0 ? 'paused' : snap.status === 'aborted' ? 'aborted' : 'running'
        }
      }
      return { runs }
    }),

  link: (id, chatId) => set((s) => patchRun(s, id, (run) => ({ ...run, chatId }))),

  node: (id, nodeId, patch) =>
    set((s) =>
      patchRun(s, id, (run) => ({
        ...run,
        nodeStates: {
          ...run.nodeStates,
          [nodeId]: { ...(run.nodeStates[nodeId] ?? { nodeId, status: 'idle' }), ...patch }
        }
      }))
    ),

  setVar: (id, name, value) =>
    set((s) => patchRun(s, id, (run) => ({ ...run, vars: { ...run.vars, [name]: value } }))),

  wait: (id, wait) =>
    set((s) =>
      patchRun(s, id, (run) => ({
        ...run,
        status: 'paused',
        waits: [...run.waits.filter((w) => w.nodeId !== wait.nodeId), wait],
        nodeStates: {
          ...run.nodeStates,
          [wait.nodeId]: { ...(run.nodeStates[wait.nodeId] ?? { nodeId: wait.nodeId }), status: 'awaiting_review' }
        }
      }))
    ),

  resume: (id, nodeId) =>
    set((s) =>
      patchRun(s, id, (run) => {
        const waits = run.waits.filter((w) => w.nodeId !== nodeId)
        return {
          ...run,
          waits,
          handingOver: false,
          status: run.status === 'paused' && waits.length === 0 ? 'running' : run.status
        }
      })
    ),

  setHandingOver: (id, value) => set((s) => patchRun(s, id, (run) => ({ ...run, handingOver: value }))),

  finish: (id, status, record, error) =>
    set((s) =>
      patchRun(s, id, (run) => ({
        ...run,
        status,
        waits: [],
        handingOver: false,
        finishedAt: record?.finishedAt ?? Date.now(),
        // The record is the whole truth; the events only ever carried previews.
        nodeStates: record?.nodeStates ?? run.nodeStates,
        vars: record?.finalVars ?? run.vars,
        error: record?.error ?? error,
        chatId: record?.chatId ?? run.chatId
      }))
    ),

  addHistory: (chatId, runs) =>
    set((s) => {
      const merged = { ...s.runs }
      // A live run is newer than its record could be.
      for (const run of runs) if (!merged[run.executionId]) merged[run.executionId] = run
      return { runs: merged, historyLoaded: { ...s.historyLoaded, [chatId]: true } }
    })
}))

const NO_RUNS: FlowRun[] = []

/** A chat's runs, newest first. */
export function chatRuns(runs: Record<string, FlowRun>, chatId: string | null | undefined): FlowRun[] {
  if (!chatId) return NO_RUNS
  const mine = Object.values(runs).filter((r) => r.chatId === chatId)
  return mine.length === 0 ? NO_RUNS : mine.sort((a, b) => b.startedAt - a.startedAt)
}

/** The chat-step pause a chat is holding, if any of its runs has one. */
export function chatPause(runs: Record<string, FlowRun>, chatId: string | null | undefined): { run: FlowRun; wait: FlowRunWait } | null {
  for (const run of chatRuns(runs, chatId)) {
    const wait = run.waits.find((w) => w.kind === 'chat')
    if (wait) return { run, wait }
  }
  return null
}
