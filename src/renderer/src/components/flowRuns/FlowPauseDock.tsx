import React, { useMemo, useState } from 'react'
import { Loader2, Workflow } from 'lucide-react'
import { chatPause, useFlowRunsStore } from '../../store/flowRuns'
import { continueChatStep, stopRun } from '../../lib/flowRunBridge'
import { DockButton } from '../QuestionDock'

/**
 * A flow waiting on this chat, as the top of the composer.
 *
 * Unlike a question it does not take the field: the pause exists for the
 * conversation, so what you type is a message. The bar is only the two things
 * the conversation cannot say by itself — carry on, or stop.
 */
export default function FlowPauseDock({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  // The map, not the pause: `chatPause` builds a new object on every call, and
  // a selector that never returns the same thing twice never lets React settle.
  const runs = useFlowRunsStore((s) => s.runs)
  const pause = useMemo(() => chatPause(runs, sessionId), [runs, sessionId])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!pause) return null
  const { run, wait } = pause

  const at = run.steps.findIndex((s) => s.id === wait.nodeId)
  const next = at >= 0 ? run.steps[at + 1]?.label : undefined
  const to = next ?? 'the rest of the run'
  const mode = wait.output ?? 'final'
  const note = run.handingOver
    ? 'Waiting for Claude to hand over the final version.'
    : mode === 'final'
      ? `Continue asks Claude for the final version and hands it to ${to}.`
      : mode === 'lastReply'
        ? `Continue hands Claude's last reply to ${to}.`
        : `Continue hands your last message to ${to}.`

  const onContinue = async (): Promise<void> => {
    setBusy(true)
    setProblem(await continueChatStep(run, wait))
    setBusy(false)
  }

  return (
    <div className="pb-2">
      <div className="flex items-center gap-2">
        {run.handingOver ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
        ) : (
          <Workflow className="size-3.5 shrink-0 text-info" />
        )}
        <span className="min-w-0 flex-1 truncate text-c-sm font-medium text-foreground">
          {run.workflowName} is waiting at {wait.label}
        </span>
        <DockButton onClick={() => stopRun(run)}>Stop run</DockButton>
        <DockButton solid disabled={busy || run.handingOver} onClick={() => void onContinue()}>
          Continue flow
        </DockButton>
      </div>
      <p className={`pt-1 text-c-xs ${problem ? 'text-danger' : 'text-muted-foreground'}`}>{problem ?? note}</p>
      <div className="mt-2 h-px bg-separator" />
    </div>
  )
}
