/**
 * What a turn was aimed at, as one line in the transcript.
 *
 * `/goal` is answered by the CLI rather than the model, and in headless mode it
 * lasts exactly one turn: the CLI does not carry the condition into the next
 * turn and does not loop until it is met — sending `/goal x` then `/goal`
 * reports "No goal set", even when x was never achieved. So this is a record of
 * what this turn was pointed at, not a mode the conversation is now in, and it
 * belongs in the transcript beside the turn it describes rather than in a tray
 * above the composer that would outlive what it reports.
 *
 * One line at trace density, like a memory write: an icon so it reads as its own
 * kind of event, the act named, and the condition in the model's own words. The
 * dot is info rather than success because setting a goal is not achieving one —
 * whether it was met is the turn's own business, said in the turn's own reply.
 */
import React from 'react'
import { Target } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'

export default function GoalChip({
  message
}: {
  message: ToolCallMessage
}): React.JSX.Element | null {
  const condition = typeof message.input.condition === 'string' ? message.input.condition : ''
  if (!condition) return null

  return (
    <div className="py-0.5">
      <div className="flex w-full items-center gap-2 px-1 py-[3px]">
        <span className="size-1.5 shrink-0 rounded-full bg-info/70" />
        <Target className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-c-sm text-muted-foreground">Goal for this turn</span>
        <span className="min-w-0 truncate text-c-sm text-info" title={condition}>
          {condition}
        </span>
      </div>
    </div>
  )
}
