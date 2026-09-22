import React, { useState } from 'react'
import { ChevronDown, ChevronRight, ListTodo } from 'lucide-react'
import type { Task, ToolCallMessage } from '../store/sessions'

/**
 * A checklist that has been worked through, kept as a record.
 *
 * The live list sits above the composer, which is right while there is work in
 * it and wrong once there is not — ticked and pinned, it is a box you cannot
 * close. When the work ends it lands here instead, collapsed, so what was done
 * survives without taking the room.
 *
 * One line rather than a card. This is a record you skim on the way past, not
 * something you have to read or answer, and it sits in a transcript where the
 * cards are load-bearing — a question, a plan. Density is how those stay
 * distinguishable from the things that merely happened.
 *
 * Partial is a normal outcome, not a failure. A turn can end with items still
 * open — the work was abandoned, or Claude simply stopped restating the block —
 * and the chip says "3 of 5" rather than claiming five tasks got done.
 */
export default function FinishedChecklist({
  message
}: {
  message: ToolCallMessage
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const tasks = Array.isArray(message.input.tasks) ? (message.input.tasks as Task[]) : []
  if (tasks.length === 0) return null

  const done = tasks.filter((t) => t.status === 'completed').length
  const all = done === tasks.length
  const headline = all
    ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} done`
    : `${done} of ${tasks.length} done`

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded px-1 py-[3px] text-left transition-colors hover:bg-accent/40"
      >
        {/* The dot carries the outcome, so it keeps a full-strength fill: at 40%
            on a 6px target it is the only thing reporting the result. */}
        <span
          className={`size-1.5 shrink-0 rounded-full ${all ? 'bg-success' : 'bg-warning'}`}
        />
        <ListTodo className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-c-sm text-muted-foreground">{headline}</span>
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* pl-[26px] lines the rows up under the chip's label: px-1 (4) + dot (6)
          + gap-2 (8) + icon (12) ... close enough that the text sits under the
          headline rather than under the controls to its left. */}
      {expanded && (
        <ul className="space-y-0.5 py-1 pl-[26px] pr-3">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex items-start gap-2 py-0.5">
              <span
                className={`mt-[6px] size-1.5 shrink-0 rounded-full ${
                  task.status === 'completed' ? 'bg-success' : 'bg-border-strong'
                }`}
              />
              <span
                className={`text-c-sm leading-snug ${
                  task.status === 'completed'
                    ? 'text-muted-foreground line-through'
                    : 'text-muted-foreground'
                }`}
              >
                {task.subject}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
