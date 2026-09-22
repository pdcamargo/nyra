import React, { useMemo } from 'react'
import { ListChecks } from 'lucide-react'
import MarkdownRenderer from '../MarkdownRenderer'
import { splitPlan } from '../PlanCard'
import { usePlanApprovalStore } from '../../store/planApprovals'
import { useSessionsStore, type ToolCallMessage } from '../../store/sessions'
import { extractPlan } from '../../utils/permission'
import type { PlanWorkspaceTab } from '../../store/workspace'

/**
 * A plan, with room to read it.
 *
 * It used to open in place above the composer, capped at 45vh and squeezing the
 * transcript and the composer between its edges — which is a sliver for a
 * document written to be read start to finish. Here it gets a column.
 *
 * Deliberately no Approve / Keep planning. The plan composer is docked above the
 * composer the entire time this tab is open, so the verdict already has one home
 * and a second set of buttons would only be a second thing to keep in step.
 * This is the reading surface; that is the answering one.
 */
export default function PlanTab({
  sessionId,
  tab
}: {
  sessionId: string
  tab: PlanWorkspaceTab
}): React.JSX.Element {
  // Matched on the name as well as the id, and from the back.
  //
  // `plan_ready` carries the tool_id of the Write that produced the plan, so the
  // transcript holds two calls under it: that Write, and the ExitPlanMode this
  // wants. Taking the first match rendered the Write's input — a JSON blob of
  // `content` and `file_path` — where the plan should have been.
  const message = useSessionsStore((s) => {
    const messages = s.sessions.find((x) => x.id === sessionId)?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'tool_call') continue
      const tc = m as ToolCallMessage
      if (tc.tool_id === tab.toolId && tc.tool_name === 'ExitPlanMode') return tc
    }
    return undefined
  })
  const isPending = usePlanApprovalStore((s) => tab.toolId in s.pending)
  const isDrafting = usePlanApprovalStore((s) => tab.toolId in s.drafting)

  const plan = useMemo(() => (message ? extractPlan(message.input) : ''), [message])
  const { title, body } = useMemo(() => splitPlan(plan), [plan])

  // The row survives a restart because the plan behind it does; a chat cleared
  // out from under it is the one case where it does not, and saying so beats an
  // empty pane that looks broken.
  if (!message) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-[11px] text-muted-foreground">
          This plan is no longer in the conversation.
        </p>
      </div>
    )
  }

  const status = isPending
    ? 'Awaiting your approval'
    : isDrafting
      ? 'Still being written'
      : message.denied === true
        ? 'Kept planning'
        : 'Approved'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/55 px-3 py-1.5">
        <ListChecks className="size-3.5 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">
          {title}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-c-md">
        <MarkdownRenderer>{body}</MarkdownRenderer>
      </div>
    </div>
  )
}
