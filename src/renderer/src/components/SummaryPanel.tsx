import React, { useCallback, useEffect, useState } from 'react'
import { FileDiff, GitBranch, Laptop, RotateCw, TerminalSquare } from 'lucide-react'
import { useSessionsStore, findProject, type TextMessage, type ToolCallMessage } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { EMPTY_BROWSER, useBrowserStore } from '../store/browser'
import { browserKey, useWorkspaceStore } from '../store/workspace'
import { collectAttachments, formatSize } from '../lib/summary'
import { useProcessesStore, type BgProcess } from '../store/processes'
import Modal from './Modal'
import MarkdownRenderer from './MarkdownRenderer'
import { cleanAgentReport } from '../lib/agentReport'
import { formatElapsed } from './ActivityStrip'

type Stat = { filesChanged: number; insertions: number; deletions: number }

/** Stable empty array — a fresh one per call re-renders forever. */
const EMPTY_PROCESSES: BgProcess[] = []

/** Ticks once a second while `active`, so elapsed times stay honest. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

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
/**
 * What a subagent actually reported.
 *
 * Its whole answer comes back as the `Task` tool's result and has been sitting in
 * the store all along — collapsed inside a tool strip nobody opens, filed under a
 * name like "Task". Here it is under the agent that produced it.
 */
function AgentReport({ toolId, onClose }: { toolId: string; onClose: () => void }): React.JSX.Element {
  const agent = useSessionsStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    return session?.agents?.find((a) => a.toolId === toolId) ?? null
  })
  const report = useSessionsStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    const msg = session?.messages.find(
      (m) => m.role === 'tool_call' && (m as ToolCallMessage).tool_id === toolId
    )
    // A background subagent's tool result is the launch receipt, not the report,
    // and showing it verbatim is how this panel came to display an agent id and
    // a "do not quote any of this" notice where the answer should be.
    return cleanAgentReport((msg as ToolCallMessage | undefined)?.result)
  })

  return (
    <Modal open onClose={onClose} title={agent?.name ?? 'Subagent'} className="max-w-2xl">
      <div className="max-h-[78vh] overflow-y-auto px-5 pb-5 text-xs">
        {agent?.status === 'running' || (!report && agent?.status !== 'failed') ? (
          <p className="italic text-info/70">
            {agent?.activity ? agent.activity : 'Still working — nothing reported yet.'}
          </p>
        ) : report ? (
          <MarkdownRenderer>{report}</MarkdownRenderer>
        ) : (
          <p className="italic text-muted-foreground/60">
            It finished without leaving a report.
          </p>
        )}
      </div>
    </Modal>
  )
}

export default function SummaryPanel(): React.JSX.Element | null {
  const open = useUiStore((s) => s.summaryOpen)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null)
  const project = useSessionsStore((s) => findProject(s, session?.projectId))
  const processes = useProcessesStore((s) =>
    session ? (s.bySession[session.id] ?? EMPTY_PROCESSES) : EMPTY_PROCESSES
  )
  const browser = useBrowserStore((s) => (session ? s.bySession[session.id] : null) ?? EMPTY_BROWSER)
  const dismissPip = useBrowserStore((s) => s.dismissPip)
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel)
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

  // Above the guard: a hook that runs only while the panel is open is a hook
  // that vanishes when it closes, and React counts them.
  // Only what is still going — a finished shell belongs in the Processes tab,
  // not in a summary of what this conversation has in flight.
  const liveProcesses = processes.filter((p) => p.status === 'running')
  const now = useClock(open && liveProcesses.length > 0)
  /** Which subagent's report is open, if any. */
  const [openAgent, setOpenAgent] = useState<string | null>(null)

  if (!open || !session) return null

  const attachments = collectAttachments(
    session.messages.filter((m): m is TextMessage => m.role === 'user' || m.role === 'assistant')
  )
  const shown = attachments.slice(0, 4)
  const agents = session.agents ?? []

  // Glass: this is the one panel with real content behind it to blur. The
  // workspace rail is docked with nothing underneath, so the same treatment
  // there would just be an expensive opaque surface.
  //
  // `top-3` rather than the old hand-tuned `top-[92px]` — the title bar is a
  // real element now, so this is positioned against the chat column itself.
  return (
    <div className="pointer-events-auto min-h-0 shrink overflow-y-auto rounded-xl border border-border bg-secondary/80 shadow-xl backdrop-blur-xl backdrop-saturate-150">
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

      {/* Shells and monitors Claude left running. The CLI lists these; Nyra had
          them only in a panel tab and a chip in the status line, which is not
          where you look to find out what this conversation has going on. */}
      {liveProcesses.length > 0 && (
        <Section label="Running">
          {liveProcesses.map((proc) => (
            <Row
              key={proc.shellId}
              icon={<TerminalSquare className="size-3.5" />}
              label={proc.description ?? proc.command}
              trailing={
                <span className="text-[10px] text-muted-foreground/40">
                  {formatElapsed(now - proc.startedAt)}
                </span>
              }
            />
          ))}
        </Section>
      )}

      {openAgent && <AgentReport toolId={openAgent} onClose={() => setOpenAgent(null)} />}

      {/* One line each rather than a count. A count tells you two agents exist;
          this tells you which one is still going and what it is doing, which is
          the question you actually had. */}
      {agents.length > 0 && (
        <Section label="Subagents">
          {agents.map((agent) => (
            <button
              key={agent.toolId}
              type="button"
              onClick={() => setOpenAgent(agent.toolId)}
              title="Show what it reported"
              className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50"
            >
              <span
                className={`mt-1 size-1.5 shrink-0 rounded-full ${
                  agent.status === 'running'
                    ? 'bg-info animate-pulse'
                    : agent.status === 'failed'
                      ? 'bg-danger/60'
                      : 'bg-success'
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-foreground/80">{agent.name}</span>
                {agent.status === 'running' && agent.activity && (
                  <span className="block truncate text-[10px] italic text-info/60">
                    {agent.activity}
                  </span>
                )}
              </span>
              {agent.durationMs != null && (
                <span className="shrink-0 text-[10px] text-muted-foreground/40">
                  {formatElapsed(agent.durationMs)}
                </span>
              )}
            </button>
          ))}
        </Section>
      )}

      {/* Every page this chat has open, whoever opened it. The browser keeps
          running with the panel closed and the miniature dismissed, so without
          this there is nowhere that says what it is doing — and nowhere to undo
          a dismissal from. */}
      {browser.tabs.length > 0 && (
        <Section
          label="Browser"
          action={
            browser.pipDismissed ? (
              <button
                type="button"
                onClick={() => session && dismissPip(session.id, false)}
                className="text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                Show preview
              </button>
            ) : undefined
          }
        >
          {browser.tabs.map((tab) => (
            <button
              key={tab.tabId}
              type="button"
              onClick={() => {
                if (!session) return
                // Parks if the strip has not caught up yet, so this works
                // whichever way the race goes.
                useWorkspaceStore.getState().selectTab(session.id, browserKey(tab.tabId))
                toggleRightPanel()
              }}
              title={tab.url}
              className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50"
            >
              <span
                className={`mt-1 size-1.5 shrink-0 rounded-full ${
                  tab.loading ? 'animate-pulse bg-info' : 'bg-success'
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-foreground/80">
                  {tab.title || 'Loading…'}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground/60">
                  {tab.url}
                </span>
              </span>
            </button>
          ))}
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
