import React, { useCallback, useEffect, useState } from 'react'
import { Eye, FileDiff, GitBranch, Laptop, MemoryStick, RotateCw, TerminalSquare } from 'lucide-react'
import { useSessionsStore, findProject, type TextMessage } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { EMPTY_BROWSER, useBrowserStore } from '../store/browser'
import { browserKey, useWorkspaceStore } from '../store/workspace'
import { collectAttachments, formatSize } from '../lib/summary'
import { formatMemory, readChatMemory, type ChatMemory } from '../lib/chatMemory'
import { openChangesInPanel, openSubagentsInPanel } from '../lib/openFile'
import { useChordLabel } from './ui/kbd'
import { useProcessesStore, type BgProcess } from '../store/processes'
import { formatElapsed } from './ActivityStrip'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { PrRows } from './PullRequestChips'
import { PortBadges } from './PortChips'
import { isMonitor, monitorLabel } from './MonitorChips'

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
    // `group` on the section rather than the header row: hovering a row is how
    // you find out the section has an action at all, and the rows are the part
    // you were reaching for.
    <section className="group px-3 py-2.5 border-b border-border/55 last:border-b-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-foreground/80">{label}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function StatusDot({ className }: { className: string }): React.JSX.Element {
  return (
    <span className="mt-px flex size-3.5 shrink-0 items-center justify-center">
      <span className={`size-1.5 rounded-full ${className}`} />
    </span>
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
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
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
  const processes = useProcessesStore((s) =>
    session ? (s.bySession[session.id] ?? EMPTY_PROCESSES) : EMPTY_PROCESSES
  )
  const browser = useBrowserStore((s) => (session ? s.bySession[session.id] : null) ?? EMPTY_BROWSER)
  const dismissPip = useBrowserStore((s) => s.dismissPip)
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel)
  const changesKeys = useChordLabel('panel.right.changes')
  const [stat, setStat] = useState<Stat | null>(null)
  const [projectBranch, setProjectBranch] = useState('')
  const showMemory = useSettingsStore((s) => s.showChatMemory)
  const [memory, setMemory] = useState<ChatMemory | null>(null)

  const cwd = session?.cwd ?? ''
  const projectPath = project?.path ?? ''
  const isWorktree = !!session?.worktree
  const sessionId = session?.id ?? null

  // Only while the card is on screen, and only when the preference is on. The
  // number comes off the process table, so it is a real read every few seconds —
  // there is nothing to poll for a panel nobody has open.
  useEffect(() => {
    if (!open || !showMemory || !sessionId) {
      setMemory(null)
      return
    }
    let cancelled = false
    const read = async (): Promise<void> => {
      const next = await readChatMemory(sessionId)
      if (!cancelled) setMemory(next)
    }
    void read()
    const id = setInterval(() => void read(), 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [open, showMemory, sessionId])

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
    <div className="pointer-events-auto min-h-0 shrink overflow-y-auto rounded-lg border border-border/70 bg-background/85 shadow-panel backdrop-blur-xl backdrop-saturate-150 dark:border-border dark:bg-card/85">
      <Section
        label="Environment"
        action={
          <Tooltip>
            <TooltipTrigger
              onClick={refresh}
              aria-label="Refresh"
              className="p-0.5 text-muted-foreground transition-colors hover:text-foreground/80"
            >
              <RotateCw className="size-3" />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        }
      >
        {/* The one row here that goes somewhere. It reported a number and left
            you to find the diff yourself; now it opens it. The keycap is read
            from the registry rather than written here, so it stays right after a
            rebinding — same rule as the "+" menu. */}
        <Tooltip>
          <TooltipTrigger
            onClick={() =>
              openChangesInPanel({
                scope: base ? { kind: 'branch', base } : { kind: 'worktree' }
              })
            }
            aria-label="Open changes"
            className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50"
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
              <FileDiff className="size-3.5" />
            </span>
            <span className="flex-1 truncate text-[11px] text-foreground/80">Changes</span>
            {stat && (stat.insertions > 0 || stat.deletions > 0) ? (
              <span className="shrink-0 font-mono text-[11px]">
                <span className="text-success/80">+{stat.insertions.toLocaleString()}</span>{' '}
                <span className="text-danger/80">−{stat.deletions.toLocaleString()}</span>
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {stat ? 'none' : '—'}
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {changesKeys ? `Open changes (${changesKeys})` : 'Open changes'}
          </TooltipContent>
        </Tooltip>
        <Row
          icon={
            <Laptop className="size-3.5" />
          }
          label={isWorktree ? (session.worktree?.permanent ? 'Permanent worktree' : 'Worktree') : 'Local'}
          trailing={project && <span className="text-[10px] text-muted-foreground truncate max-w-[110px]">{project.name}</span>}
        />
        {session.branch && (
          <Row
            icon={
              <GitBranch className="size-3.5" />
            }
            label={session.branch}
          />
        )}
        {/* What this chat is holding: its Claude process, everything under it,
            and the shells it left running. Off the summary card for the same
            reason the cwd is — it is a fact about this conversation, not a
            panel of its own. Gated on the preference because it costs a read of
            the process table every few seconds. */}
        {showMemory && (
          <Row
            icon={<MemoryStick className="size-3.5" />}
            label="Chat RAM"
            trailing={
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {memory && memory.processes > 0 ? formatMemory(memory.bytes) : '—'}
              </span>
            }
          />
        )}
        <p className="mt-1 text-[10px] text-muted-foreground font-mono break-all">{cwd || '—'}</p>
      </Section>

      {/* Shells and monitors Claude left running. The CLI lists these; Nyra had
          them only in a panel tab and a chip in the status line, which is not
          where you look to find out what this conversation has going on. */}
      {liveProcesses.length > 0 && (
        <Section label="Running">
          {liveProcesses.map((proc) => (
            <Row
              key={proc.shellId}
              // A watch and a shell are both "running", but only one of them is
              // going to interrupt you, so they do not get the same icon.
              icon={
                isMonitor(proc) ? (
                  <Eye className="size-3.5 text-info" />
                ) : (
                  <TerminalSquare className="size-3.5" />
                )
              }
              label={isMonitor(proc) ? monitorLabel(proc) : (proc.description ?? proc.command)}
              trailing={
                // The port rather than a second section of its own: a port
                // belongs to the shell serving it, and a Ports section would be
                // this same list again with one column changed.
                <span className="flex shrink-0 items-center gap-1.5">
                  <PortBadges sessionId={session.id} process={proc} />
                  <span className="text-[10px] text-muted-foreground">
                    {formatElapsed(now - proc.startedAt)}
                  </span>
                </span>
              }
            />
          ))}
        </Section>
      )}

      {/* What this chat shipped. Above the subagents because it is the outcome
          and they are the machinery, and persisted with the session — a chat
          reopened next week still says what it opened. */}
      {(session.pullRequests?.length ?? 0) > 0 && (
        <Section label={session.pullRequests!.length === 1 ? 'Pull request' : 'Pull requests'}>
          <PrRows prs={session.pullRequests!} />
        </Section>
      )}

      {/* One line each rather than a count. A count tells you two agents exist;
          this tells you which one is still going and what it is doing, which is
          the question you actually had.

          Reading it is the panel's job; watching it work is not. Both routes go
          to the same tab — the header opens the list, a row opens that agent. */}
      {agents.length > 0 && (
        <Section
          label="Subagents"
          action={
            <Tooltip>
              <TooltipTrigger
                onClick={() => openSubagentsInPanel(null)}
                aria-label="See all subagents"
                className="rounded text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground/80 group-hover:opacity-100 focus-visible:opacity-100"
              >
                See all
              </TooltipTrigger>
              <TooltipContent>See all subagents</TooltipContent>
            </Tooltip>
          }
        >
          {agents.map((agent) => (
            <Tooltip key={agent.toolId}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => openSubagentsInPanel(agent.toolId)}
                  className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50"
                >
                  <StatusDot
                    className={
                      agent.status === 'running'
                        ? 'bg-info nyra-breathe'
                        : agent.status === 'failed'
                          ? 'bg-danger'
                          : 'bg-success'
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-foreground/80">{agent.name}</span>
                    {agent.status === 'running' && agent.activity && (
                      <span className="block truncate text-[10px] italic text-info">
                        {agent.activity}
                      </span>
                    )}
                  </span>
                  {agent.durationMs != null && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatElapsed(agent.durationMs)}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>Open this subagent</TooltipContent>
            </Tooltip>
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
                className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
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
              <StatusDot className={tab.loading ? 'bg-info nyra-breathe' : 'bg-success'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-foreground/80">
                  {tab.title || 'Loading…'}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {tab.url}
                </span>
              </span>
            </button>
          ))}
        </Section>
      )}

      <Section label="Attachments">
        {attachments.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing attached</p>
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
                    <span className="text-[10px] text-muted-foreground shrink-0">{formatSize(a.size)}</span>
                  ) : undefined
                }
              />
            ))}
            {attachments.length > shown.length && (
              <p className="pt-0.5 text-[10px] text-muted-foreground">
                {attachments.length - shown.length} more
              </p>
            )}
          </>
        )}
      </Section>
    </div>
  )
}
