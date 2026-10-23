/**
 * The sidebar's status vocabulary: what a chat is doing, what a project's chats
 * add up to, and which chats are waiting on you from anywhere.
 *
 * Blue is Claude working, amber is Claude stopped on you. The two used to share
 * the blue of unread, which made a chat stuck on a permission prompt and a chat
 * with a reply waiting look like the same thing from the rail.
 */
import React, { useEffect, useState } from 'react'
import {
  Bell,
  CircleAlert,
  GitMerge,
  GitPullRequest,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  ShieldAlert,
  type LucideIcon
} from 'lucide-react'
import { DotSpinner } from './ui/dot-spinner'
import type { Project, Session } from '../store/sessions'
import { projectIcon } from '../lib/project-appearance'
import {
  describeRollup,
  formatElapsed,
  isEmptyRollup,
  projectInitial,
  type ChatWait,
  type ChatWaitKind,
  type ProjectRollup
} from '../lib/sidebarStatus'

const WAIT_ICONS: Record<ChatWaitKind, LucideIcon> = {
  permission: ShieldAlert,
  plan: ListChecks,
  question: MessageCircleQuestion
}

/**
 * The mark in a row's gutter: amber for what it is waiting on, otherwise the
 * app's spinner while it works. Waiting wins — a chat stopped on a prompt is
 * still "running" as far as the CLI is concerned, and the spinner would say
 * the opposite of what is true.
 */
export function ChatStatusGlyph({
  wait,
  busy,
  className = ''
}: {
  wait: ChatWait | null
  busy: boolean
  className?: string
}): React.JSX.Element | null {
  if (wait) {
    const Icon = WAIT_ICONS[wait.kind]
    return <Icon className={`size-3 shrink-0 text-warning ${className}`} aria-label={wait.label} />
  }
  if (busy) return <DotSpinner className={`text-info ${className}`} />
  return null
}

/** Names the ask — `Allow Bash`, `Question`, `Plan` — rather than one label for all three. */
export function WaitChip({ wait }: { wait: ChatWait }): React.JSX.Element {
  return (
    <span className="max-w-[8rem] shrink-0 truncate rounded-sm bg-warning/15 px-1 py-px text-[0.72em] font-medium text-warning">
      {wait.label}
    </span>
  )
}

/** How long the turn has been going. Ticks once a second while mounted. */
export function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span className="shrink-0 font-mono text-[0.72em] tabular-nums text-muted-foreground">
      {formatElapsed(now - since)}
    </span>
  )
}

/**
 * A project's chats, summed, on its header. Zero counts are left out, so an
 * idle project with no PRs shows nothing at all.
 *
 * No tooltip: the header swaps these for its actions on hover, so one could
 * never open. The marks are the rows' own, which is what makes them readable
 * without one.
 */
export function ProjectRollupMarks({ rollup }: { rollup: ProjectRollup }): React.JSX.Element | null {
  if (isEmptyRollup(rollup)) return null
  return (
    <span
      role="img"
      aria-label={describeRollup(rollup)}
      className="flex shrink-0 items-center gap-2 text-[0.72em] font-medium tabular-nums"
    >
      {rollup.busy > 0 && (
        <span className="flex items-center gap-0.5 text-info">
          <DotSpinner className="size-2.5" />
          {rollup.busy}
        </span>
      )}
      {rollup.waiting > 0 && (
        <span className="flex items-center gap-0.5 text-warning">
          <CircleAlert className="size-2.5" aria-hidden="true" />
          {rollup.waiting}
        </span>
      )}
      {rollup.open > 0 && (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <GitPullRequest className="size-2.5 text-success" aria-hidden="true" />
          {rollup.open}
        </span>
      )}
      {rollup.merged > 0 && (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <GitMerge className="size-2.5 text-merged" aria-hidden="true" />
          {rollup.merged}
        </span>
      )}
    </span>
  )
}

/**
 * A project's mark: its icon, or its initial, framed in its colour. A project
 * nobody customised still gets one of each, so two of them never look alike.
 */
export function ProjectTile({
  project,
  tint,
  size = 'md',
  className = ''
}: {
  project: Pick<Project, 'name' | 'icon'>
  /** A CSS colour, or null for none. */
  tint: string | null
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const Icon = projectIcon(project.icon)
  const box = size === 'sm' ? 'size-[15px] rounded-at-4' : 'size-[18px] rounded-at-5'
  return (
    <span
      className={`flex shrink-0 items-center justify-center border ${box} ${tint ? '' : 'border-border-strong text-muted-foreground'} ${className}`}
      style={tint ? { borderColor: tint, color: tint } : undefined}
      aria-hidden="true"
    >
      {Icon ? (
        <Icon className={size === 'sm' ? 'size-2.5' : 'size-3'} />
      ) : (
        <span className={`font-semibold leading-none ${size === 'sm' ? 'text-[0.62em]' : 'text-[0.7em]'}`}>
          {projectInitial(project.name)}
        </span>
      )}
    </span>
  )
}

export type NeedsYouItem = {
  session: Session
  project: Project | null
  tint: string | null
  wait: ChatWait
}

/**
 * Every chat waiting on you, from every project, above the lists. The rows
 * already say it, but not from inside a collapsed project or under Show more,
 * which is exactly where a stuck chat gets forgotten.
 */
export function NeedsYouTray({
  items,
  onOpen
}: {
  items: NeedsYouItem[]
  onOpen: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <section
      aria-label="Needs you"
      className="mb-2 rounded-lg border border-warning/25 bg-warning/10 p-0.5"
    >
      <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5">
        <Bell className="size-2.5 text-warning" aria-hidden="true" />
        <span className="text-[0.77em] font-semibold uppercase tracking-widest text-warning">
          Needs you
        </span>
        <span className="ml-auto text-[0.77em] font-medium tabular-nums text-warning">{items.length}</span>
      </div>
      <div className="space-y-px">
        {items.map(({ session, project, tint, wait }) => {
          const Icon = WAIT_ICONS[wait.kind]
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onOpen(session.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-warning/10"
            >
              {project ? (
                <ProjectTile project={project} tint={tint} size="sm" />
              ) : (
                <MessageSquare className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate text-[0.92em] text-foreground/80">{session.title}</span>
              <Icon className="size-3 shrink-0 text-warning" aria-hidden="true" />
              <span className="max-w-[7rem] shrink-0 truncate text-[0.77em] font-medium text-warning">
                {wait.label}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
