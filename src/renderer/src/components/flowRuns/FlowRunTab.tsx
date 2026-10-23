import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleMinus, CirclePause, CircleX, Loader2, PanelsTopLeft } from 'lucide-react'
import type { FlowRunPanelTab } from '../../store/panelTabs'
import type { FlowRun } from '../../store/flowRuns'
import type { FlowRunStep, WorkflowDefinition, WorkflowNodeRunState } from '../../../../shared/workflow-types'
import { formatDuration, runHeadline, stepsDone } from '../../lib/flowRuns'
import { continueChatStep, stopRun } from '../../lib/flowRunBridge'
import { useWorkflowStore } from '../../store/workflow'
import { useSessionsStore } from '../../store/sessions'
import { DockButton } from '../QuestionDock'
import { IconButton } from '../ui/icon-button'
import { RunMark } from './FlowRunCard'
import { useFlowRun } from './hooks'

function StepMark({ state }: { state: WorkflowNodeRunState | undefined }): React.JSX.Element {
  switch (state?.status) {
    case 'done':
      return <CircleCheck className="size-3.5 shrink-0 text-success" />
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
    case 'awaiting_review':
      return <CirclePause className="size-3.5 shrink-0 text-info" />
    case 'failed':
      return <CircleX className="size-3.5 shrink-0 text-danger" />
    case 'skipped':
      return <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />
    default:
      return <Circle className="size-3.5 shrink-0 text-border-strong" />
  }
}

const KIND: Partial<Record<FlowRunStep['type'], string>> = {
  prompt: 'prompt',
  script: 'script',
  condition: 'condition',
  loop: 'loop',
  humanReview: 'review',
  chat: 'chat step',
  subworkflow: 'flow',
  parallel: 'fan out',
  join: 'join'
}

function Step({ step, state, last }: { step: FlowRunStep; state: WorkflowNodeRunState | undefined; last: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const text = state?.error ?? state?.output ?? ''
  const took = state?.startedAt && state.finishedAt ? formatDuration(state.finishedAt - state.startedAt) : null
  const reached = !!state && state.status !== 'idle'
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <StepMark state={state} />
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <button
          type="button"
          disabled={!text}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left disabled:cursor-default"
        >
          <span className={`min-w-0 flex-1 truncate text-c-sm font-medium ${reached ? 'text-foreground' : 'text-muted-foreground'}`}>
            {step.label}
          </span>
          <span className="shrink-0 font-mono text-c-xs text-muted-foreground">
            {[KIND[step.type] ?? step.type, took].filter(Boolean).join(' · ')}
          </span>
          {text && (open ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />)}
        </button>
        {text &&
          (open ? (
            <pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-code p-2 font-mono text-c-xs text-foreground" data-theme-token="code">
              {text}
            </pre>
          ) : (
            <p className={`mt-0.5 line-clamp-2 text-c-xs ${state?.error ? 'text-danger' : 'text-muted-foreground'}`}>{text}</p>
          ))}
      </div>
    </li>
  )
}

/** The paused step, with what answers it. A chat step continues from its
 *  chat; a review is approved or rejected here, as on the canvas. */
function Waiting({ run }: { run: FlowRun }): React.JSX.Element | null {
  const wait = run.waits[0]
  const [problem, setProblem] = useState<string | null>(null)
  const activeChat = useSessionsStore((s) => s.activeSessionId)
  if (!wait) return null
  const chat = wait.kind === 'chat'
  const goToChat = (): void => {
    if (run.chatId) useSessionsStore.getState().setActiveSession(run.chatId)
  }
  const onChat = activeChat === run.chatId
  return (
    <div className="rounded-lg border border-info/40 bg-info/10 p-3">
      <p className="text-c-sm font-medium text-foreground">
        {chat ? `Waiting for you at ${wait.label}` : `${wait.label} is waiting for a review`}
      </p>
      {wait.message && !chat && <p className="mt-1 text-c-xs text-muted-foreground">{wait.message}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {chat ? (
          <>
            {!onChat && run.chatId && <DockButton onClick={goToChat}>Go to chat</DockButton>}
            <DockButton onClick={() => stopRun(run)}>Stop run</DockButton>
            <DockButton solid disabled={run.handingOver} onClick={() => void continueChatStep(run, wait).then(setProblem)}>
              Continue flow
            </DockButton>
          </>
        ) : (
          <>
            <DockButton onClick={() => void window.api.workflow.reviewResponse(run.executionId, wait.nodeId, false)}>Reject</DockButton>
            <DockButton solid onClick={() => void window.api.workflow.reviewResponse(run.executionId, wait.nodeId, true)}>
              Approve
            </DockButton>
          </>
        )}
      </div>
      {problem && <p className="mt-1.5 text-c-xs text-danger">{problem}</p>}
    </div>
  )
}

/** A flow run, in the chat's side panel: its steps as a list, not a canvas.
 *  Read-only — editing the flow is the canvas, one click away. */
export default function FlowRunTab({ tab }: { tab: FlowRunPanelTab }): React.JSX.Element {
  const run = useFlowRun(tab.executionId)
  if (!run) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-c-sm text-muted-foreground">
        This run ended when Nyra was closed, so there is nothing to show.
      </div>
    )
  }

  const live = run.status === 'running' || run.status === 'paused'
  const origin = run.chatId ? 'from a chat' : run.triggeredBy && run.triggeredBy !== 'manual' ? `by a ${run.triggeredBy} trigger` : 'from the canvas'
  const openCanvas = async (): Promise<void> => {
    const definition = (await window.api.workflow.load(run.workflowId)) as WorkflowDefinition | null
    if (!definition) return
    useWorkflowStore.getState().openCanvas()
    useWorkflowStore.getState().setCurrentWorkflow(definition)
  }
  const vars = Object.entries(run.vars)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <RunMark run={run} className="mt-0.5 size-4" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-c-md font-semibold text-foreground">{run.workflowName}</p>
            <p className="truncate text-c-xs text-muted-foreground">
              {runHeadline(run)} · started {origin}
              {live ? '' : ` · ${stepsDone(run)} of ${run.steps.length} steps`}
            </p>
          </div>
          <IconButton label="Open in the Flows view" onClick={() => void openCanvas()} className="text-muted-foreground">
            <PanelsTopLeft className="size-3.5" />
          </IconButton>
        </div>

        <Waiting run={run} />

        {run.status === 'failed' && run.error && (
          <p className="rounded-md bg-danger/10 p-2 text-c-xs text-danger">{run.error}</p>
        )}

        <ol>
          {run.steps.map((step, i) => (
            <Step key={step.id} step={step} state={run.nodeStates[step.id]} last={i === run.steps.length - 1} />
          ))}
        </ol>

        {vars.length > 0 && (
          <div className="rounded-md bg-muted/60 p-3">
            <p className="pb-1 text-c-xs font-medium uppercase tracking-wide text-muted-foreground">Variables</p>
            {vars.map(([k, v]) => (
              <p key={k} className="truncate font-mono text-c-xs text-foreground" title={v}>
                {k} <span className="text-muted-foreground">{v}</span>
              </p>
            ))}
          </div>
        )}

        {live && run.status === 'running' && (
          <div>
            <DockButton onClick={() => stopRun(run)}>Stop run</DockButton>
          </div>
        )}
      </div>
    </div>
  )
}
