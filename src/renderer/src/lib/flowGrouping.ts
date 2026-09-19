/**
 * How the Flow rail sorts itself out.
 *
 * Pure, and out of `Sidebar.tsx`, so the grouping can be asserted without
 * rendering a rail. The shapes here are the ones the design turns on: a flow
 * belongs to a project or to nothing, and an unscoped flow is usually unscoped
 * on purpose rather than waiting to be filed.
 */
import type { WorkflowDefinition } from '../../../shared/workflow-types'

export type GroupedFlows = {
  /** Project id to its flows, in the order the backend returned them. */
  byProject: Map<string, WorkflowDefinition[]>
  /** Flows scoped to no project: deliberately portable ones, and fresh installs. */
  loose: WorkflowDefinition[]
}

export function groupFlowsByProject(workflows: WorkflowDefinition[]): GroupedFlows {
  const byProject = new Map<string, WorkflowDefinition[]>()
  const loose: WorkflowDefinition[] = []
  for (const wf of workflows) {
    if (!wf.projectId) {
      loose.push(wf)
      continue
    }
    const list = byProject.get(wf.projectId) ?? []
    list.push(wf)
    byProject.set(wf.projectId, list)
  }
  return { byProject, loose }
}

/**
 * What wakes a flow, for the line under its name.
 *
 * Triggers are the most capable thing Flows has and they were buried in a
 * per-flow dialog. Disabled ones say nothing: a schedule you turned off should
 * not read as a schedule.
 */
export function triggerSummary(wf: WorkflowDefinition): string | null {
  const live = (wf.triggers ?? []).filter((t) => t.enabled)
  if (live.length === 0) return null
  const [first] = live
  const extra = live.length > 1 ? ` +${live.length - 1}` : ''
  if (first.type === 'cron') return `${first.schedule}${extra}`
  if (first.type === 'fileWatcher') return `on ${first.paths[0] ?? 'file change'}${extra}`
  return `webhook${extra}`
}

/** An absolute path cut down to something a 240px rail can hold. */
export function shortPath(path: string, home: string): string {
  const tilde = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  const parts = tilde.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : tilde
}

/**
 * The line under a flow's name.
 *
 * A running flow reports progress, because that is the only thing worth knowing
 * while it runs. Otherwise a trigger beats a timestamp, and a flow that has
 * never run says so rather than showing nothing.
 */
export function flowMeta(
  wf: WorkflowDefinition,
  opts: {
    running?: { done: number; total: number }
    /** Set when the last run of this flow ended badly, so the rail can say so. */
    ended?: 'failed' | 'aborted'
    home?: string
  }
): string {
  if (opts.running) return `${opts.running.done} of ${opts.running.total}`
  // A failure outranks a schedule: a flow that broke is the thing you want to
  // see from another tab, and the schedule is still there underneath it.
  if (opts.ended === 'failed') return 'failed'
  if (opts.ended === 'aborted') return 'stopped'
  const trigger = triggerSummary(wf)
  if (trigger) return trigger
  const last = wf.recentCwds?.[0]
  if (last) return `last ran in ${shortPath(last, opts.home ?? '')}`
  return 'never run'
}

/**
 * What a flow is made of, for the hover card.
 *
 * Structured rather than a formatted string: the card renders each count with
 * its own icon, the way `ChatCard` does for a chat's folder and branch.
 */
export function flowComposition(wf: WorkflowDefinition): {
  nodes: number
  prompts: number
  scripts: number
  subflows: number
} {
  let prompts = 0
  let scripts = 0
  let subflows = 0
  for (const n of wf.nodes ?? []) {
    if (n.data?.type === 'prompt') prompts += 1
    else if (n.data?.type === 'script') scripts += 1
    else if (n.data?.type === 'subworkflow') subflows += 1
  }
  return { nodes: wf.nodes?.length ?? 0, prompts, scripts, subflows }
}
