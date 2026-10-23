import React from 'react'
import { CircleCheck, CirclePause, CircleX, Loader2, OctagonX, Workflow } from 'lucide-react'
import type { ToolCallMessage } from '../../store/sessions'
import type { FlowRun } from '../../store/flowRuns'
import { runHeadline } from '../../lib/flowRuns'
import { openFlowRunInPanel } from '../../lib/openFile'
import { DockButton } from '../QuestionDock'
import { useFlowRun } from './hooks'

/** The run's state as one mark, for the card, the summary and the tab. */
export function RunMark({ run, className = 'size-3.5' }: { run: FlowRun | null; className?: string }): React.JSX.Element {
  switch (run?.status) {
    case 'done':
      return <CircleCheck className={`${className} shrink-0 text-success`} />
    case 'failed':
      return <CircleX className={`${className} shrink-0 text-danger`} />
    case 'aborted':
      return <OctagonX className={`${className} shrink-0 text-muted-foreground`} />
    case 'paused':
      return <CirclePause className={`${className} shrink-0 text-info`} />
    case 'running':
      return <Loader2 className={`${className} shrink-0 animate-spin text-info`} />
    default:
      return <Workflow className={`${className} shrink-0 text-info`} />
  }
}

/**
 * A flow run, where the chat started it.
 *
 * A card rather than a line: it is the thing you come back to — where the run
 * is, and the way into it — and it changes as the run does, so it reads its
 * state live rather than off the message.
 */
export default function FlowRunCard({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const executionId = typeof message.input.executionId === 'string' ? message.input.executionId : null
  const name = typeof message.input.workflowName === 'string' ? message.input.workflowName : 'Flow'
  const run = useFlowRun(executionId)

  return (
    <div className="my-1 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <RunMark run={run} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-c-sm font-medium text-foreground">{run?.workflowName ?? name}</p>
        <p className="truncate text-c-xs text-muted-foreground">
          {run ? runHeadline(run) : 'This run ended when Nyra was closed'}
        </p>
      </div>
      {executionId && run && (
        <DockButton onClick={() => openFlowRunInPanel(executionId)}>Show run</DockButton>
      )}
    </div>
  )
}
