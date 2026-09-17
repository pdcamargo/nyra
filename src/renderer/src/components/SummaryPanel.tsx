import React, { useCallback, useEffect, useState } from 'react'
import { FileDiff, GitBranch, Laptop, RotateCw } from 'lucide-react'
import { useSessionsStore, findProject, type TextMessage } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { collectAttachments, formatSize } from '../lib/summary'

type Stat = { filesChanged: number; insertions: number; deletions: number }

function Section({
  label,
  action,
  children
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="px-3 py-2.5 border-b border-border/55 last:border-b-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-foreground/80">{label}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({
  icon,
  label,
  trailing
}: {
  icon: React.ReactNode
  label: string
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1 min-w-0">
      <span className="text-muted-foreground/70 shrink-0">{icon}</span>
      <span className="text-[11px] text-foreground/80 truncate flex-1">{label}</span>
      {trailing}
    </div>
  )
}

/**
 * The conversation's environment: where the agent is working, what it has
 * changed, what it was given.
 *
 * Floats over the message area rather than sitting beside it. It answers a
 * question you ask in passing — a docked panel would reflow the conversation
 * every time you glanced at it, and it is separate from the workspace panel,
 * which is about the project rather than this chat.
 */
export default function SummaryPanel(): React.JSX.Element | null {
  const open = useUiStore((s) => s.summaryOpen)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null)
  const project = useSessionsStore((s) => findProject(s, session?.projectId))
  const [stat, setStat] = useState<Stat | null>(null)
  const [projectBranch, setProjectBranch] = useState('')

  const cwd = session?.cwd ?? ''
  const projectPath = project?.path ?? ''
  const isWorktree = !!session?.worktree

  // A worktree chat is measured against the branch it diverged from, so the
  // number covers everything the branch has done, commits included. A local chat
  // is measured against HEAD — just "what is uncommitted right now".
  useEffect(() => {
    let cancelled = false
    if (!isWorktree || !projectPath) {
      setProjectBranch('')
      return
    }
    void window.api.git.branch(projectPath).then((b) => {
      if (!cancelled) setProjectBranch(b)
    })
    return () => {
      cancelled = true
    }
  }, [isWorktree, projectPath])

  const base = isWorktree && projectBranch ? projectBranch : null

  const refresh = useCallback(async () => {
    if (!cwd) {
      setStat(null)
      return
    }
    try {
      setStat(await window.api.git.diffStat(cwd, base))
    } catch {
      setStat(null)
    }
  }, [cwd, base])

  // Spec §3: refreshed when it opens and on return to the chat, not polled in
  // the background — a git subprocess per project per tick buys nothing.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!open || !session) return null

  const attachments = collectAttachments(
    session.messages.filter((m): m is TextMessage => m.role === 'user' || m.role === 'assistant')
  )
  const shown = attachments.slice(0, 4)
  const agents = session.agents ?? []
  const doneAgents = agents.filter((a) => a.status !== 'running').length

  // Glass: this is the one panel with real content behind it to blur. The
  // workspace rail is docked with nothing underneath, so the same treatment
  // there would just be an expensive opaque surface.
  //
  // `top-3` rather than the old hand-tuned `top-[92px]` — the title bar is a
  // real element now, so this is positioned against the chat column itself.
  return (
    <div className="absolute right-3 top-3 z-30 max-h-[calc(100%-96px)] w-[308px] overflow-y-auto rounded-xl border border-border bg-secondary/80 shadow-xl backdrop-blur-xl backdrop-saturate-150">
      <Section
        label="Environment"
        action={
          <button
            onClick={refresh}
            className="p-0.5 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
            title="Refresh"
          >
            <RotateCw className="size-3" />
          </button>
        }
      >
        <Row
          icon={
            <FileDiff className="size-3.5" />
          }
          label="Changes"
          trailing={
            stat && (stat.insertions > 0 || stat.deletions > 0) ? (
              <span className="text-[11px] font-mono shrink-0">
                <span className="text-success/80">+{stat.insertions.toLocaleString()}</span>{' '}
                <span className="text-danger/80">−{stat.deletions.toLocaleString()}</span>
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground/40 shrink-0">{stat ? 'none' : '—'}</span>
            )
          }
        />
        <Row
          icon={
            <Laptop className="size-3.5" />
          }
          label={isWorktree ? (session.worktree?.permanent ? 'Permanent worktree' : 'Worktree') : 'Local'}
          trailing={project && <span className="text-[10px] text-muted-foreground/40 truncate max-w-[110px]">{project.name}</span>}
        />
        {session.branch && (
          <Row
            icon={
              <GitBranch className="size-3.5" />
            }
            label={session.branch}
          />
        )}
        <p className="mt-1 text-[10px] text-muted-foreground/40 font-mono break-all">{cwd || '—'}</p>
      </Section>

      {agents.length > 0 && (
        <Section label="Subagents">
          <p className="text-[11px] text-foreground/80">
            {doneAgents === agents.length
              ? `${agents.length} done`
              : `${agents.length - doneAgents} running · ${doneAgents} done`}
          </p>
        </Section>
      )}

      <Section label="Attachments">
        {attachments.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/40">Nothing attached</p>
        ) : (
          <>
            {shown.map((a) => (
              <Row
                key={a.key}
                icon={
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {a.kind === 'image' ? (
                      <>
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="m21 15-5-5L5 21" />
                      </>
                    ) : (
                      <>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </>
                    )}
                  </svg>
                }
                label={a.name}
                trailing={
                  a.kind === 'file' ? (
                    <span className="text-[10px] text-muted-foreground/40 shrink-0">{formatSize(a.size)}</span>
                  ) : undefined
                }
              />
            ))}
            {attachments.length > shown.length && (
              <p className="pt-0.5 text-[10px] text-muted-foreground/40">
                {attachments.length - shown.length} more
              </p>
            )}
          </>
        )}
      </Section>
    </div>
  )
}
