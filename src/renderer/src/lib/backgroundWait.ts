import { useEffect, useMemo, useReducer } from 'react'
import { useBackgroundAgentsStore, type BackgroundAgent } from '../store/backgroundAgents'
import { useProcessesStore, type BgProcess } from '../store/processes'
import { useRunningStore } from '../store/running'
import { useFlowRunsStore, type FlowRun } from '../store/flowRuns'
import type { Session } from '../store/sessions'

export type WaitingTask = {
  taskId: string
  description: string
  kind: 'agent' | 'monitor' | 'shell' | 'flow'
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

/**
 * Chats with work in flight: a turn, or something Claude will come back from.
 *
 * The rail's spinner rule. It used to be the turn alone, so a chat whose turn
 * had ended on "waiting for these agents" showed as idle in the list for as
 * long as they ran — the transcript said it was busy and the rail said it was
 * done. The same `waitingOn`, so a dev server does not keep a row spinning.
 */
export function busyChats(
  running: Readonly<Record<string, true>>,
  rosters: Readonly<Record<string, readonly BackgroundAgent[] | undefined>>,
  processes: Readonly<Record<string, readonly BgProcess[] | undefined>>,
  /** Flow runs: one going counts for the chat it belongs to. One paused on
   *  the chat does not — that chat is waiting on you, not working. */
  flowRuns: Readonly<Record<string, FlowRun>> = {}
): Record<string, true> {
  let busy: Record<string, true> | null = null
  const add = (sid: string): void => {
    if (running[sid] || busy?.[sid]) return
    busy ??= { ...running }
    busy[sid] = true
  }
  for (const [sid, roster] of Object.entries(rosters)) {
    if (!roster?.length) continue
    if (waitingOn(roster, processes[sid] ?? []).length === 0) continue
    add(sid)
  }
  for (const run of Object.values(flowRuns)) {
    if (run.chatId && run.status === 'running') add(run.chatId)
  }
  // The same object when nothing is waiting, so a memo downstream holds.
  return busy ?? (running as Record<string, true>)
}

/** `busyChats`, live. */
export function useBusyChats(): Record<string, true> {
  const running = useRunningStore((s) => s.running)
  const rosters = useBackgroundAgentsStore((s) => s.bySession)
  const processes = useProcessesStore((s) => s.bySession)
  const flowRuns = useFlowRunsStore((s) => s.runs)
  return useMemo(() => busyChats(running, rosters, processes, flowRuns), [running, rosters, processes, flowRuns])
}

/** A span of time as a person would say it: `under a minute`, `4 min`, `1 h 5 min`. */
export const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h >= 48) return `${Math.round(h / 24)} days`
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/**
 * When a `ScheduleWakeup` from this chat's last turn will fire, if it still will.
 *
 * A self-paced `/loop` ends each round on one: the turn is over, and the CLI
 * starts the next round by itself when the delay runs out.
 */
export function wakesAt(session: Pick<Session, 'messages'>, now: number): number | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]
    // A message of yours since then means the wake-up is not what it is waiting on.
    if (m.role === 'user') return null
    if (m.role !== 'tool_call' || m.tool_name !== 'ScheduleWakeup') continue
    const delay = Number(m.input.delaySeconds)
    if (!m.timestamp || !Number.isFinite(delay) || m.input.stop === true) return null
    const at = m.timestamp + delay * 1000
    return at > now ? at : null
  }
  return null
}

/** The soonest of these chats' wake-ups, if any is ahead. */
export function nextWakeAt(sessions: readonly Pick<Session, 'messages'>[], now: number): number | null {
  let next: number | null = null
  for (const s of sessions) {
    const at = wakesAt(s, now)
    if (at !== null && (next === null || at < next)) next = at
  }
  return next
}

/** Re-renders once, just after `at`, so a wake-up that has fired stops being shown. */
export function useExpiry(at: number | null): void {
  const [, expire] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (at === null) return
    const timer = window.setTimeout(expire, Math.max(0, at - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [at])
}

/** `wakesAt` for one chat, live. */
export function useWakeAt(session: Pick<Session, 'messages'> | null | undefined): number | null {
  const at = session ? wakesAt(session, Date.now()) : null
  useExpiry(at)
  return at
}

/** `wakesAt` for a list of chats, live: the ones with a wake-up ahead, by id. */
export function useWakeups(sessions: readonly Session[]): Record<string, number> {
  const [tick, expire] = useReducer((n: number) => n + 1, 0)
  const wakes = useMemo(() => {
    const now = Date.now()
    const out: Record<string, number> = {}
    for (const s of sessions) {
      const at = wakesAt(s, now)
      if (at !== null) out[s.id] = at
    }
    return out
    // `tick` is the clock: it moves when the earliest wake-up passes.
  }, [sessions, tick])
  const next = Math.min(Infinity, ...Object.values(wakes))
  useEffect(() => {
    if (next === Infinity) return
    const timer = window.setTimeout(expire, Math.max(0, next - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [next])
  return wakes
}
