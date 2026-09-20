import React, { useMemo } from 'react'
import { Check, ListChecks, PanelRightOpen, Zap } from 'lucide-react'
import MarkdownRenderer from './MarkdownRenderer'
import { usePlanApprovalStore } from '../store/planApprovals'
import { extractPlan } from '../utils/permission'
import { openPlanInPanel } from '../lib/openFile'
import type { ToolCallMessage } from '../store/sessions'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * What the user said about a plan.
 *
 * `approve-auto` is the CLI's "yes, and auto-accept edits": the same yes, plus
 * giving up the per-file prompt for the rest of this conversation.
 */
export type PlanAnswer = 'approve' | 'approve-auto' | 'reject'

/**
 * The plan's own title, lifted out so the collapsed card says what it is — and
 * removed from the body, so expanding doesn't print the same line twice.
 */
export function splitPlan(plan: string): { title: string; body: string } {
  const lines = plan.split('\n')
  const idx = lines.findIndex((line) => /^#{1,3}\s+\S/.test(line))
  // Only lift a heading that opens the plan. One further down names a section
  // of the plan, not the plan.
  if (idx !== -1 && lines.slice(0, idx).every((line) => line.trim() === '')) {
    return {
      title: lines[idx].replace(/^#{1,3}\s+/, '').trim(),
      body: lines.slice(idx + 1).join('\n').trim()
    }
  }
  const firstProse = lines.find((line) => line.trim().length > 0)
  return { title: firstProse?.trim().slice(0, 90) ?? 'Plan', body: plan }
}

/**
 * A plan, in the conversation rather than on top of it.
 *
 * ExitPlanMode used to raise the permission modal, which put something you are
 * meant to read behind a dialog you have to dismiss — and which took the plan
 * with it when you answered. As a card it stays: expanded while it waits on you,
 * collapsible once answered, and still there to re-read afterwards.
 */
export default function PlanCard({
  message,
  onAnswer,
  pinned = false
}: {
  message: ToolCallMessage
  /** Approve or keep planning, for a plan that arrived as a file. */
  onAnswer?: (toolId: string, answer: PlanAnswer, planPath?: string, note?: string) => void
  /** Rendered above the composer rather than in the transcript. */
  pinned?: boolean
}): React.JSX.Element | null {
  // Both are subscriptions, not one-off reads: the card has to repaint the
  // moment the plan is answered, and a pending plan may carry no session id.
  const pendingSession = usePlanApprovalStore((s) => s.pending[message.tool_id])
  const isPending = usePlanApprovalStore((s) => message.tool_id in s.pending)
  // Written, but the turn that wrote it is still going. A record of what Claude
  // is drafting, not a question — so it keeps its header row and nothing else.
  const isDrafting = usePlanApprovalStore((s) => message.tool_id in s.drafting)
  const resolve = usePlanApprovalStore((s) => s.resolve)

  // While it waits on you it lives above the composer, where it cannot be
  // scrolled past. Rendering it in both places would ask the same question twice.
  const plan = useMemo(() => extractPlan(message.input), [message.input])
  const { title, body } = useMemo(() => splitPlan(plan), [plan])

  const denied = message.denied === true

  // Two ways a plan gets here. Headless Claude writes it to a file, and the card
  // answers by talking to Claude like the user would. A permission-gated
  // ExitPlanMode would park the stream instead, and has to be answered on the
  // wire — no CLI ships that in headless mode today, but the branch costs little.
  const planPath = typeof message.input.path === 'string' ? message.input.path : undefined

  const answer = (verdict: PlanAnswer, text?: string): void => {
    if (planPath) {
      onAnswer?.(message.tool_id, verdict, planPath, text?.trim() || undefined)
    } else {
      void window.api.claude.respondPermission(verdict !== 'reject', pendingSession)
      resolve(message.tool_id)
    }
  }

  // Reading a plan happens in the side panel now. It used to expand in place,
  // capped at 45vh with the transcript and the composer squeezed either side,
  // which is a sliver for a document meant to be read start to finish.
  const open = (): void => openPlanInPanel(message.tool_id)

  if (isPending && !pinned) return null

  return (
    <div
      className={
        pinned
          ? 'pb-2'
          : 'my-2 overflow-hidden rounded-lg border border-border bg-card'
      }
    >
      <button
        type="button"
        onClick={open}
        aria-label={`Open plan: ${title}`}
        className={`flex w-full items-center gap-2 text-left transition-colors ${
          pinned ? 'pb-2' : 'px-3 py-2.5 hover:bg-accent/40'
        }`}
      >
        <ListChecks className="size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate text-c-md font-medium text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-c-xs text-muted-foreground">
          {isPending
            ? 'Awaiting your approval'
            : isDrafting
              ? 'Drafting…'
              : denied
                ? 'Kept planning'
                : 'Approved'}
        </span>
        <PanelRightOpen className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {/* Pinned, the plan shows its first few lines under a fade — a title alone
          is not enough to approve on. The rest is a click away in the panel, so
          this never grows past a glance. While it is still being drafted there
          is nothing worth glancing at. */}
      {pinned && !isDrafting && (
        <div
          onClick={open}
          className="relative max-h-24 cursor-pointer overflow-hidden text-c-md"
        >
          <MarkdownRenderer>{body}</MarkdownRenderer>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-muted to-transparent" />
        </div>
      )}

      {isPending && (
        <div className="flex items-center justify-end gap-2 pt-2">
          {/* No "Keep planning" button. The composer below is that answer: while a
              plan waits, anything you type there means "not yet", and its
              placeholder says so. A button whose only job was to reveal a text
              field sitting two inches lower was a step with nothing in it. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => answer('approve')}
                className="flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-c-md font-medium text-foreground transition-colors hover:bg-accent/50"
              >
                <Check className="size-3.5" />
                Approve
              </button>
            </TooltipTrigger>
            <TooltipContent>Leave plan mode. Each file change still asks.</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => answer('approve-auto')}
                className="flex items-center gap-1.5 rounded-md bg-success px-2.5 py-1 text-c-md font-medium text-success-foreground transition-opacity hover:opacity-85"
              >
                <Zap className="size-3.5" />
                Approve &amp; auto-edit
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Leave plan mode and stop asking about file changes, for this chat only.
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Inset, so the plan and the field below read as one card. */}
      {pinned && <div className="mt-2 h-px bg-separator" />}
    </div>
  )
}
