import React, { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, ListChecks, X, Zap } from 'lucide-react'
import MarkdownRenderer from './MarkdownRenderer'
import { usePlanApprovalStore } from '../store/planApprovals'
import { extractPlan } from '../utils/permission'
import type { ToolCallMessage } from '../store/sessions'

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
  onAnswer
}: {
  message: ToolCallMessage
  /** Approve or keep planning, for a plan that arrived as a file. */
  onAnswer?: (toolId: string, answer: PlanAnswer, planPath?: string, note?: string) => void
}): React.JSX.Element {
  // Both are subscriptions, not one-off reads: the card has to repaint the
  // moment the plan is answered, and a pending plan may carry no session id.
  const pendingSession = usePlanApprovalStore((s) => s.pending[message.tool_id])
  const isPending = usePlanApprovalStore((s) => message.tool_id in s.pending)
  const resolve = usePlanApprovalStore((s) => s.resolve)

  const plan = useMemo(() => extractPlan(message.input), [message.input])
  const { title, body } = useMemo(() => splitPlan(plan), [plan])

  // Open while it waits on you — a plan you have to approve is a plan you have
  // to read. Anything already answered, including every plan in a reloaded
  // transcript, starts collapsed so it stops dominating the conversation.
  const [expanded, setExpanded] = useState(isPending)
  // Non-null once "Keep planning" is clicked: turning it down is rarely the
  // whole answer, and the reason is worth the least effort to give at the
  // moment you have it rather than after hunting for the composer.
  const [note, setNote] = useState<string | null>(null)
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
    setNote(null)
    setExpanded(false)
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <ListChecks className="size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {isPending ? 'Awaiting your approval' : denied ? 'Kept planning' : 'Approved'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/55 px-4 py-3 text-xs">
          <MarkdownRenderer>{body}</MarkdownRenderer>
        </div>
      )}

      {isPending && note === null && (
        <div className="flex items-center justify-end gap-2 border-t border-border/55 px-3 py-2">
          <button
            type="button"
            onClick={() => setNote('')}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <X className="size-3.5" />
            Keep planning
          </button>
          {/* Two ways to say yes, as the CLI offers: approve the plan and keep
              the say over each edit, or hand that over too. */}
          <button
            type="button"
            onClick={() => answer('approve')}
            title="Leave plan mode. Each file change still asks."
            className="flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            <Check className="size-3.5" />
            Approve
          </button>
          <button
            type="button"
            onClick={() => answer('approve-auto')}
            title="Leave plan mode and stop asking about file changes, for this chat only."
            className="flex items-center gap-1.5 rounded-md bg-success px-2.5 py-1 text-xs font-medium text-success-foreground transition-opacity hover:opacity-85"
          >
            <Zap className="size-3.5" />
            Approve &amp; auto-edit
          </button>
        </div>
      )}

      {isPending && note !== null && (
        <div className="flex items-center gap-2 border-t border-border/55 px-3 py-2">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') answer('reject', note)
              if (e.key === 'Escape') setNote(null)
            }}
            placeholder="What should change? (optional)"
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-input/20 px-2.5 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30"
          />
          <button
            type="button"
            onClick={() => answer('reject', note)}
            className="shrink-0 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground transition-opacity hover:opacity-85"
          >
            {note.trim() ? 'Send' : 'Keep planning'}
          </button>
        </div>
      )}
    </div>
  )
}
