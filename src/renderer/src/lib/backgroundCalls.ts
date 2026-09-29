import type { BgProcess } from '../store/processes'
import { newMessageId, useSessionsStore, type ToolCallMessage } from '../store/sessions'

/**
 * Backgrounded shells and monitors, as lines in the transcript.
 *
 * Folded into a run of tool calls, `Bash(run_in_background)` read as one more
 * command that had already finished, and a Monitor as nothing at all: the only
 * sign either was still going was a pill in the composer. They get the subagent
 * treatment instead — a line where they started, live while they run, and a
 * second line where they ended.
 */

export type BackgroundKind = 'shell' | 'monitor'

/** A tool call that leaves something running after it returns. */
export function isBackgroundCall(tc: ToolCallMessage): boolean {
  if (tc.tool_name === 'Monitor') return true
  return tc.tool_name === 'Bash' && tc.input.run_in_background === true
}

export function backgroundKindOf(tc: ToolCallMessage): BackgroundKind {
  return tc.tool_name === 'Monitor' ? 'monitor' : 'shell'
}

/** What the call is called: its description, else what it runs or watches. */
export function backgroundLabel(tc: ToolCallMessage): string {
  const description = typeof tc.input.description === 'string' ? tc.input.description.trim() : ''
  if (description) return description
  if (typeof tc.input.command === 'string' && tc.input.command.trim()) return tc.input.command.trim()
  const ws = tc.input.ws as { url?: unknown } | undefined
  if (typeof ws?.url === 'string') return ws.url
  return tc.tool_name === 'Monitor' ? 'a monitor' : 'a background command'
}

/**
 * Still going, as far as the registry knows. Untracked means the pid was never
 * found, not that it stopped; orphaned means its Claude went away and it did not.
 */
export function isLive(proc: BgProcess | undefined): boolean {
  return proc?.status === 'running' || proc?.status === 'untracked' || proc?.status === 'orphaned'
}

export type BackgroundOutcome = 'done' | 'failed' | 'stopped'

export function outcomeOf(proc: BgProcess): BackgroundOutcome {
  if (proc.status === 'killed' || proc.status === 'stopped') return 'stopped'
  return proc.exitCode !== null && proc.exitCode !== 0 ? 'failed' : 'done'
}

/**
 * Rows that ended between `prev` and `next`, or learned how they ended.
 *
 * The second half is the exit code: the CLI marks a shell failed first and
 * names its exit code in a later notification, so the end line written on the
 * first is corrected on the second.
 */
export function endedBetween(prev: readonly BgProcess[], next: readonly BgProcess[]): BgProcess[] {
  return next.filter((row) => {
    if (isLive(row)) return false
    const before = prev.find((p) => p.shellId === row.shellId)
    if (!before) return false
    return isLive(before) || (before.exitCode === null && row.exitCode !== null)
  })
}

/**
 * The end, as its own line where it happened — `SubagentEnded`'s twin, for the
 * same reason: the start line is off screen by the time a test run finishes.
 *
 * Only for a call the transcript shows a start line for, and once per call,
 * because the registry rebroadcasts a row every time anything on it changes. A
 * later word on how it ended rewrites that line rather than adding another.
 */
export function announceBackgroundEnd(sid: string, proc: BgProcess): void {
  const store = useSessionsStore.getState()
  const session = store.sessions.find((s) => s.id === sid)
  if (!session) return
  const start = session.messages.find(
    (m): m is ToolCallMessage => m.role === 'tool_call' && m.tool_id === proc.shellId
  )
  if (!start || !isBackgroundCall(start)) return
  const toolId = `ended-${proc.shellId}`
  const input = {
    shellId: proc.shellId,
    kind: backgroundKindOf(start),
    name: backgroundLabel(start),
    status: outcomeOf(proc),
    exitCode: proc.exitCode
  }
  const already = session.messages.find(
    (m): m is ToolCallMessage => m.role === 'tool_call' && m.tool_id === toolId
  )
  if (already) {
    if (already.input.status !== input.status || already.input.exitCode !== input.exitCode) {
      store.updateToolInput(sid, toolId, input)
    }
    return
  }
  store.addMessage(sid, {
    id: newMessageId(),
    role: 'tool_call',
    tool_id: toolId,
    tool_name: 'BackgroundEnded',
    input,
    result: ''
  })
}
