/**
 * Claude's checklist for the work it is doing.
 *
 * `TodoWrite`, `TaskCreate` and friends do not exist in the headless CLI — the
 * same hole that swallowed `ExitPlanMode` and `AskUserQuestion` — so the handlers
 * Nyra already had for them could never fire. This is the substitute: a fenced
 * ```nyra-tasks block Claude rewrites whenever something changes, parsed into the
 * list that sits above the composer.
 *
 * The whole list every time, not a diff. A diff needs stable ids and a model
 * that never miscounts; re-stating five lines costs almost nothing and cannot
 * drift out of sync with itself.
 */

import type { Task, TaskStatus } from '../store/sessions'

const TASK_FENCE =
  /^[ \t]*```[ \t]*nyra-tasks[ \t]*\n([\s\S]*?)(?:^[ \t]*```[ \t]*$|$(?![\s\S]))/gm

/** `- [x] done`, `- [>] doing`, `- [ ] still to do`. */
const ITEM = /^[ \t]*[-*][ \t]*\[([ x>~*])\][ \t]*(.*)$/i

function statusOf(mark: string): TaskStatus {
  const m = mark.toLowerCase()
  if (m === 'x') return 'completed'
  if (m === '>' || m === '~' || m === '*') return 'in_progress'
  return 'pending'
}

/** Items out of one block's body. Order is the list's order. */
export function parseTaskBlock(body: string): Task[] {
  const tasks: Task[] = []
  for (const line of body.split('\n')) {
    const match = line.match(ITEM)
    if (!match) continue
    const subject = match[2].trim()
    if (!subject) continue
    tasks.push({
      // Position is the only identity a re-stated list has. It is enough: the
      // list is replaced wholesale, so nothing needs to survive between them.
      taskId: `nyra-task-${tasks.length}`,
      subject,
      description: '',
      status: statusOf(match[1]),
      createdByToolId: 'nyra-tasks'
    })
  }
  return tasks
}

/**
 * Split a reply into what the user reads and the checklist behind it.
 *
 * `tasks` is null when the reply had no block at all, which is different from a
 * block that emptied the list — the first leaves the list alone, the second
 * clears it.
 */
export function extractTaskBlocks(reply: string): { text: string; tasks: Task[] | null } {
  let tasks: Task[] | null = null
  const text = reply.replace(TASK_FENCE, (_match, body: string) => {
    tasks = [...(tasks ?? []), ...parseTaskBlock(body)]
    return ''
  })
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), tasks }
}
