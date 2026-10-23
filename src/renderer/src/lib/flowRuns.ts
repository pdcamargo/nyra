/**
 * Flow runs, as a chat sees them: one line saying where a run is, what Claude
 * is told when it pauses or ends, and how `/flow` names one.
 *
 * Pure, so the wording and the parsing are tested without an engine.
 */
import type {
  FlowRunStep,
  FlowRunWait,
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowNodeRunState
} from '../../../shared/workflow-types'
import type { FlowRun } from '../store/flowRuns'
import type { Message, MessageContext, TextMessage } from '../store/sessions'

/** Steps that ran to their end, for "2 of 4". */
export function stepsDone(run: Pick<FlowRun, 'steps' | 'nodeStates'>): number {
  return run.steps.filter((s) => {
    const status = run.nodeStates[s.id]?.status
    return status === 'done' || status === 'skipped'
  }).length
}

/** The step the run is on: the one waiting, else the latest to start. */
export function currentStep(run: Pick<FlowRun, 'steps' | 'nodeStates' | 'waits'>): FlowRunStep | null {
  const waiting = run.waits[0]
  if (waiting) return run.steps.find((s) => s.id === waiting.nodeId) ?? null
  let best: FlowRunStep | null = null
  let at = -1
  for (const step of run.steps) {
    const state = run.nodeStates[step.id]
    if (state?.status === 'running' && (state.startedAt ?? 0) >= at) {
      best = step
      at = state.startedAt ?? 0
    }
  }
  return best
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** The step that failed, for "Failed at Run tests". */
function failedStep(run: Pick<FlowRun, 'steps' | 'nodeStates'>): FlowRunStep | null {
  return run.steps.find((s) => run.nodeStates[s.id]?.status === 'failed') ?? null
}

/** One line: where the run is, or how it ended. */
export function runHeadline(run: FlowRun): string {
  const total = run.steps.length
  switch (run.status) {
    case 'paused': {
      const wait = run.waits[0]
      if (!wait) return 'Paused'
      return wait.kind === 'chat' ? `Waiting for you at ${wait.label}` : `Waiting for a review at ${wait.label}`
    }
    case 'running': {
      const step = currentStep(run)
      const progress = `${stepsDone(run)} of ${total}`
      return step ? `${step.label} · ${progress}` : `Starting · ${progress}`
    }
    case 'done':
      return `Done in ${formatDuration((run.finishedAt ?? Date.now()) - run.startedAt)}`
    case 'failed': {
      const step = failedStep(run)
      return step ? `Failed at ${step.label}` : 'Failed'
    }
    case 'aborted':
      return 'Stopped'
  }
}

/** The output the run ended on: its most recently finished step's. */
export function lastOutput(run: Pick<FlowRun, 'steps' | 'nodeStates'>): { step: FlowRunStep; output: string } | null {
  let best: { step: FlowRunStep; state: WorkflowNodeRunState } | null = null
  for (const step of run.steps) {
    const state = run.nodeStates[step.id]
    if (state?.status !== 'done' || !state.output) continue
    if (!best || (state.finishedAt ?? 0) >= (best.state.finishedAt ?? 0)) best = { step, state }
  }
  return best ? { step: best.step, output: best.state.output ?? '' } : null
}

const attr = (s: string): string => s.replace(/"/g, "'")

/**
 * What Claude reads when the run pauses in its chat.
 *
 * Says who decides when it carries on, because the default answer to "the
 * flow is waiting" is to carry it on at once — and the whole point of the step
 * is the conversation before that.
 */
export function pauseNotice(run: Pick<FlowRun, 'executionId' | 'workflowName'>, wait: FlowRunWait): string {
  const open = wait.message?.trim()
    ? `Open with this:\n${wait.message.trim()}`
    : 'Open by showing the user what the previous step produced, and ask what should change.'
  const handOff =
    wait.output === 'lastReply'
      ? 'When they press Continue flow, your last reply goes on as this step\'s output, so keep the current version in your latest reply.'
      : wait.output === 'user'
        ? 'When they press Continue flow, their last message goes on as this step\'s output.'
        : `When they say to carry on, call nyra_flow with action "continue", run "${run.executionId}" and output set to the final version in full: that is all the next step gets. If they want to stop instead, call it with approve false. Don't continue before they say so.`
  return [
    `<flow-run id="${run.executionId}" flow="${attr(run.workflowName)}" step="${attr(wait.label)}">`,
    `The flow paused at its chat step "${wait.label}" and is waiting on this conversation.`,
    open,
    '',
    'What the previous step handed it:',
    '<input>',
    wait.input.trim() || '(nothing)',
    '</input>',
    '',
    `Work it through with the user. ${handOff}`,
    '</flow-run>'
  ].join('\n')
}

/** What Claude reads when the user presses Continue on a step Claude hands over. */
export function handOverNotice(run: Pick<FlowRun, 'executionId' | 'workflowName'>, wait: FlowRunWait): string {
  return [
    `<flow-run id="${run.executionId}" flow="${attr(run.workflowName)}" step="${attr(wait.label)}">`,
    `The user pressed Continue flow. Call nyra_flow now with action "continue", run "${run.executionId}" and output set to the final version of this step's work, in full. Don't ask first.`,
    '</flow-run>'
  ].join('\n')
}

/** What Claude reads when the run ends. */
export function endNotice(run: FlowRun): string {
  const last = lastOutput(run)
  const how = run.status === 'failed' ? `failed${run.error ? `: ${run.error}` : ''}` : 'finished'
  return [
    `<flow-run id="${run.executionId}" flow="${attr(run.workflowName)}" status="${run.status}">`,
    `The flow run this chat started has ${how}.`,
    ...(last ? [`Its last step, "${last.step.label}", produced:`, '<output>', last.output.trim(), '</output>'] : []),
    'Tell the user in a line or two how it went.',
    '</flow-run>'
  ].join('\n')
}

/** The receipt a notice leaves in the transcript, and what Claude gets with it. */
export function runContext(label: string, body: string, executionId: string): MessageContext {
  return { kind: 'flow-run', label, body, ref: { executionId } }
}

/**
 * A chat step's output, when the step takes it from the transcript rather
 * than from Claude: the last reply, or the last thing the user said, since
 * the step paused. Null when there is none yet.
 */
export function outputFromTranscript(messages: readonly Message[], mode: 'lastReply' | 'user', sinceId?: string): string | null {
  const from = sinceId ? messages.findIndex((m) => m.id === sinceId) : -1
  const role = mode === 'lastReply' ? 'assistant' : 'user'
  for (let i = messages.length - 1; i > from; i--) {
    const m = messages[i]
    if (m.role !== role) continue
    const text = (m as TextMessage).text?.trim()
    if (text) return text
  }
  return null
}

/** A finished run, rebuilt from its record — after a restart, or for a run the
 *  app never saw start. */
export function runFromRecord(record: WorkflowExecutionRecord, wf: WorkflowDefinition | null): FlowRun {
  const steps: FlowRunStep[] = wf
    ? orderedSteps(wf)
    : Object.keys(record.nodeStates).map((id) => ({ id, label: id, type: 'prompt' }))
  return {
    executionId: record.id,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    chatId: record.chatId ?? null,
    cwd: record.cwd ?? '',
    inputValues: record.inputValues,
    triggeredBy: record.triggeredBy,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    steps,
    status: record.status,
    nodeStates: record.nodeStates,
    vars: record.finalVars,
    waits: [],
    error: record.error
  }
}

/** Steps top to bottom, the way the canvas lays them out — the engine's order. */
export function orderedSteps(wf: Pick<WorkflowDefinition, 'nodes'>): FlowRunStep[] {
  return [...wf.nodes]
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((n) => ({ id: n.id, label: n.label, type: n.data.type }))
}

// ---- /flow ---------------------------------------------------------------

export type FlowCommand =
  | { kind: 'run'; flow: WorkflowDefinition; inputs: Record<string, string>; missing: string[] }
  | { kind: 'unknown'; name: string }
  | { kind: 'empty' }

/** `/flow` and what follows it, or null when the text is something else. */
export function flowArgs(text: string): string | null {
  const m = /^\/flow(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}

/** `key=value` pairs, a value quoted when it has spaces. */
function pairs(rest: string): { named: Record<string, string>; loose: string[] } {
  const named: Record<string, string> = {}
  const loose: string[] = []
  const re = /([\w-]+)=("([^"]*)"|'([^']*)'|\S+)|"([^"]*)"|(\S+)/g
  for (const m of rest.matchAll(re)) {
    if (m[1]) named[m[1]] = m[3] ?? m[4] ?? m[2]
    else loose.push(m[5] ?? m[6])
  }
  return { named, loose }
}

/**
 * Which flow `/flow …` names, and with what.
 *
 * The longest name that the text starts with wins, so "PR Review" does not
 * shadow "PR Review Pipeline". With a single input, a value without a key is
 * that input's — `/flow Retrospective 2026-W43` reads as well as it types.
 */
export function parseFlowCommand(text: string, flows: readonly WorkflowDefinition[]): FlowCommand | null {
  const rest = flowArgs(text)
  if (rest === null) return null
  if (!rest) return { kind: 'empty' }
  const lower = rest.toLowerCase()
  const flow = [...flows]
    .filter((f) => {
      const name = f.name.trim().toLowerCase()
      return name && lower.startsWith(name) && (lower.length === name.length || /\s/.test(lower[name.length]))
    })
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (!flow) return { kind: 'unknown', name: rest.split(/\s+/)[0] }

  const declared = flow.inputs ?? []
  const { named, loose } = pairs(rest.slice(flow.name.trim().length))
  const inputs: Record<string, string> = {}
  for (const input of declared) {
    const given = named[input.key]
    if (given !== undefined) inputs[input.key] = given
    else if (input.defaultValue) inputs[input.key] = input.defaultValue
  }
  if (declared.length === 1 && loose.length > 0 && named[declared[0].key] === undefined) {
    inputs[declared[0].key] = loose.join(' ')
  }
  const missing = declared.filter((i) => !inputs[i.key]?.trim()).map((i) => i.key)
  return { kind: 'run', flow, inputs, missing }
}

/** What the `/flow` popup should match, or null when it should not be open:
 *  only while the name is still being typed. */
export function flowQuery(text: string, flows: readonly WorkflowDefinition[]): string | null {
  const rest = /^\/flow\s+([\s\S]*)$/i.exec(text)?.[1]
  if (rest === undefined) return null
  const lower = rest.toLowerCase()
  const named = flows.some((f) => {
    const name = f.name.trim().toLowerCase()
    return name && lower.startsWith(name + ' ')
  })
  return named ? null : rest.trim()
}
