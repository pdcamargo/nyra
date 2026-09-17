import React, { useState } from 'react'
import { ChevronDown, ChevronRight, ListTodo } from 'lucide-react'
import { useSessionsStore, type Task } from '../store/sessions'

/** A stable empty array — a fresh one per call would re-render forever. */
const EMPTY_TASKS: Task[] = []

function dotClass(status: Task['status']): string {
  if (status === 'completed') return 'bg-success'
  if (status === 'in_progress') return 'bg-info animate-pulse'
  return 'bg-secondary'
}

/**
 * What Claude is working through, above the composer where you are looking.
 *
 * The task list used to live in the workspace panel, which is the wrong place
 * twice over: it is about this conversation rather than the workspace, and it
 * was behind a tab, so the answer to "what is it doing?" was a click away while
 * the thing you were watching scrolled past.
 *
 * Open while there is work left and closed once there is not — but only until
 * you say otherwise, after which it stays where you put it.
 */
export default function TaskStrip(): React.JSX.Element | null {
  const tasks = useSessionsStore((state) => {
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.tasks ?? EMPTY_TASKS
  })
  const [manual, setManual] = useState<boolean | null>(null)

  if (tasks.length === 0) return null

  const done = tasks.filter((t) => t.status === 'completed').length
  const current = tasks.find((t) => t.status === 'in_progress')
  const expanded = manual ?? done < tasks.length
  const pct = Math.round((done / tasks.length) * 100)

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <ListTodo className="size-3.5 shrink-0 text-info" />
        <span className="shrink-0 text-xs font-medium text-foreground">Tasks</span>
        {/* Collapsed, the row still has to answer "what is it doing right now?" */}
        {!expanded && current && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {current.activeForm ?? current.subject}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {done}/{tasks.length}
        </span>
      </button>

      <div className="h-0.5 w-full bg-accent">
        <div
          className="h-0.5 bg-success/60 transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {expanded && (
        <ul className="space-y-0.5 px-2 py-1.5">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex items-start gap-2 px-1 py-0.5">
              <span
                className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dotClass(task.status)}`}
              />
              <div className="min-w-0 flex-1">
                <span
                  className={`text-xs leading-snug ${
                    task.status === 'completed'
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground/80'
                  }`}
                >
                  {task.subject}
                </span>
                {task.status === 'in_progress' && task.activeForm && (
                  <p className="mt-0.5 text-[10px] italic text-info/60">{task.activeForm}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
