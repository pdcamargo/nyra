import React, { useState } from 'react'
import { ChevronDown, ChevronRight, ListTodo } from 'lucide-react'
import type { Task, ToolCallMessage } from '../store/sessions'

/**
 * A checklist that has been worked through, kept as a record.
 *
 * The live list sits above the composer, which is right while there is work in
 * it and wrong once there is not — ticked and pinned, it is a box you cannot
 * close. On the last item it lands here instead, collapsed, so what was done
 * survives without taking the room.
 */
export default function FinishedChecklist({
  message
}: {
  message: ToolCallMessage
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const tasks = Array.isArray(message.input.tasks) ? (message.input.tasks as Task[]) : []

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border/55 bg-card/50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <ListTodo className="size-3.5 shrink-0 text-success" />
        <span className="text-c-md text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? '' : 's'} done
        </span>
      </button>
      {/* pl-[34px] puts the rows under the header's icon and their text under its
          label — px-3 (12) + chevron (14) + gap-2 (8). mx-1 gives the 6px dot the
          same 14px column the icons above it occupy, so the text lands on the
          same edge in both halves of the card. */}
      {expanded && (
        <ul className="space-y-0.5 border-t border-border/55 py-1.5 pl-[34px] pr-3">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex items-start gap-2 py-0.5">
              <span className="mx-1 mt-[6px] size-1.5 shrink-0 rounded-full bg-success" />
              <span className="text-c-md leading-snug text-muted-foreground line-through">
                {task.subject}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
