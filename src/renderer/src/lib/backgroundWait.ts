import type { BackgroundAgent } from '../store/backgroundAgents'
import type { BgProcess } from '../store/processes'

export type WaitingTask = {
  taskId: string
  description: string
  kind: 'agent' | 'monitor' | 'shell'
}

/**
 * What an idle chat is still waiting on.
 *
 * The CLI's roster lists every background task — shells, monitors and
 * subagents — and Claude starts a turn by itself when one reports back. A
 * server is the exception: it is meant to keep running, it will not report
 * back, and its port pill already says it is up, so a shell that has bound a
 * port is left out. Everything else is work the conversation is not done with.
 *
 * Shells and monitors have a row in the process registry and subagents do not,
 * which is how the two are told apart: the roster's own `kind` is overwritten
 * with a subagent's type once its progress starts arriving.
 */
export function waitingOn(
  roster: readonly BackgroundAgent[],
  processes: readonly BgProcess[]
): WaitingTask[] {
  return roster.flatMap((task) => {
    const proc = processes.find((p) => p.taskId !== null && p.taskId === task.taskId)
    if (proc && proc.ports.length > 0) return []
    const kind: WaitingTask['kind'] = !proc ? 'agent' : proc.kind === 'monitor' ? 'monitor' : 'shell'
    const description =
      task.description.trim() || proc?.description?.trim() || proc?.command || 'a background task'
    return [{ taskId: task.taskId, description, kind }]
  })
}

/** The line's own words: one task by name, several by count. */
export function waitingLabel(tasks: readonly WaitingTask[]): string {
  if (tasks.length === 1) {
    const [only] = tasks
    return only.kind === 'monitor' ? `Watching ${only.description}` : `Waiting on ${only.description}`
  }
  return `Waiting on ${tasks.length} background tasks`
}
