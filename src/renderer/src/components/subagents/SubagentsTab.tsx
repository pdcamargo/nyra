import React, { useEffect, useMemo, useRef } from 'react'
import { Bot, ChevronLeft } from 'lucide-react'
import MarkdownRenderer from '../MarkdownRenderer'
import ToolCallGroup from '../ToolCallGroup'
import { formatElapsed } from '../ActivityStrip'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cleanAgentReport } from '../../lib/agentReport'
import { shortModelLabel } from '../../lib/models'
import { openSubagentsInPanel } from '../../lib/openFile'
import {
  useSubagentTranscriptsStore,
  transcriptFor,
  type SubagentEntry
} from '../../store/subagentTranscripts'
import { useSessionsStore, type Agent, type ToolCallMessage } from '../../store/sessions'
import type { SubagentsWorkspaceTab } from '../../store/workspace'

/** A stable empty array — a fresh one per call would re-render forever. */
const NO_AGENTS: Agent[] = []

function dotClass(status: Agent['status']): string {
  if (status === 'running') return 'bg-info animate-pulse'
  if (status === 'failed') return 'bg-danger/60'
  return 'bg-success'
}

/**
 * Consecutive tool calls collapse into one group, the way the transcript does.
 *
 * An agent that reads nine files in a row is one line here rather than nine, and
 * the prose either side of it stays readable — which is the whole reason to show
 * a stream instead of a report.
 */
type Block =
  | { kind: 'prose'; entry: Extract<SubagentEntry, { kind: 'text' | 'thinking' }>; key: string }
  | { kind: 'tools'; messages: ToolCallMessage[]; key: string }

function blocksOf(entries: SubagentEntry[], toolId: string): Block[] {
  const blocks: Block[] = []
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === 'tool') {
      // Synthesised, not stored: `ToolCallGroup` wants `ToolCallMessage[]` and
      // that is a plain shape, so the panel gets the transcript's trace lines,
      // diffs and group summaries without a second renderer to keep in step.
      const message: ToolCallMessage = {
        id: `${toolId}-${i}`,
        role: 'tool_call',
        tool_id: entry.toolId,
        tool_name: entry.name,
        input: entry.input,
        ...(entry.result !== undefined ? { result: entry.result } : {})
      }
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'tools') last.messages.push(message)
      else blocks.push({ kind: 'tools', messages: [message], key: `t-${i}` })
      continue
    }
    blocks.push({ kind: 'prose', entry, key: `p-${i}` })
  }
  return blocks
}

function AgentRow({ agent, onOpen }: { agent: Agent; onOpen: () => void }): React.JSX.Element {
  const model = shortModelLabel(agent.model)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
    >
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dotClass(agent.status)}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground/80">{agent.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {agent.status === 'running' && agent.activity ? agent.activity : agent.subagentType}
        </span>
      </span>
      {model && (
        <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">
          {model}
        </span>
      )}
      {agent.durationMs != null && (
        <span className="mt-0.5 shrink-0 text-[10px] text-muted-foreground">
          {formatElapsed(agent.durationMs)}
        </span>
      )}
    </button>
  )
}

function AgentList({
  agents,
  onOpen
}: {
  agents: Agent[]
  onOpen: (toolId: string) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/55 px-3 py-1.5">
        <Bot className="size-3.5 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">
          Subagents
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {agents.length === 0 ? 'None yet' : `${agents.length}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {agents.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            No subagents in this chat yet.
          </p>
        ) : (
          agents.map((agent) => (
            <AgentRow key={agent.toolId} agent={agent} onOpen={() => onOpen(agent.toolId)} />
          ))
        )}
      </div>
    </div>
  )
}

/**
 * What it is doing right now, pinned under everything it has said so far.
 *
 * A message only appears once it is complete, so between the last tool call and
 * a long answer there is a silent gap — and the answer then lands in one piece,
 * which reads as nothing-then-everything. This is the one genuinely live signal
 * in the whole path: `task_progress` names each step as the agent takes it, and
 * it was already arriving and being thrown away as soon as the stream had any
 * content in it.
 *
 * Not a fake "Thinking…". The reasoning itself is unavailable — every thinking
 * block in every transcript, subagent and parent alike, carries an empty string
 * and a signature — so this says what it is *doing*, which is true, and falls
 * back to a bare pulse rather than inventing a line.
 */
function LiveFooter({ activity }: { activity?: string }): React.JSX.Element {
  return (
    <div className="mt-2 flex items-center gap-2 px-1 py-1">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" />
      <span className="min-w-0 flex-1 truncate text-[11px] italic text-info">
        {activity || 'Working…'}
      </span>
    </div>
  )
}

function AgentStream({
  sessionId,
  agent,
  onBack
}: {
  sessionId: string
  agent: Agent
  onBack: () => void
}): React.JSX.Element {
  const transcript = useSubagentTranscriptsStore((s) => transcriptFor(s, sessionId, agent.toolId))
  const report = useSessionsStore((s) => {
    const session = s.sessions.find((x) => x.id === sessionId)
    const msg = session?.messages.find(
      (m) => m.role === 'tool_call' && (m as ToolCallMessage).tool_id === agent.toolId
    )
    // A background subagent's tool result is its launch receipt, not its report.
    // Showing it verbatim is how the old modal came to display an agent id and a
    // "do not quote any of this" notice where the answer should have been.
    return cleanAgentReport((msg as ToolCallMessage | undefined)?.result)
  })

  // The live stream only exists while the agent runs, but its transcript does
  // not — so an agent from three turns ago, or from before a reload, is read
  // back off disk rather than showing an empty pane.
  useEffect(() => {
    if (transcript.hydrated || transcript.entries.length > 0) return
    const path = agent.outputFile
    if (!path) return
    let cancelled = false
    void window.api.subagents
      .transcript(path)
      .then((data) => {
        if (cancelled) return
        useSubagentTranscriptsStore
          .getState()
          .hydrate(sessionId, agent.toolId, { model: data.model, entries: data.entries })
      })
      .catch(() => {
        /* the file may be gone; the report below is still worth showing */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, agent.toolId, agent.outputFile, transcript.hydrated, transcript.entries.length])

  const blocks = useMemo(
    () => blocksOf(transcript.entries, agent.toolId),
    [transcript.entries, agent.toolId]
  )

  // Follow the bottom while it is still writing, and stop the moment it is not:
  // scrolling a finished agent back to the end every render would fight you.
  const endRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (agent.status !== 'running') return
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [blocks.length, report, agent.status, agent.activity])

  const model = shortModelLabel(transcript.model ?? agent.model)
  const running = agent.status === 'running'
  // Only a finished agent can be empty. A running one always has the footer.
  const empty = blocks.length === 0 && !report && !running

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/55 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to all subagents"
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80"
            >
              <ChevronLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>All subagents</TooltipContent>
        </Tooltip>
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass(agent.status)}`} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">
          {agent.name}
        </span>
        {/* What it actually ran on, off its own messages — not the model the
            composer is set to, which a subagent need not have inherited. */}
        {model && (
          <span className="shrink-0 rounded-sm bg-accent/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {model}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-c-md">
        {empty ? (
          <p className="px-1 py-6 text-center text-[11px] italic text-muted-foreground">
            It left no transcript and no report.
          </p>
        ) : (
          <>
            {blocks.map((block) =>
              block.kind === 'tools' ? (
                <ToolCallGroup key={block.key} messages={block.messages} />
              ) : block.entry.kind === 'thinking' ? (
                <p
                  key={block.key}
                  className="my-1 whitespace-pre-wrap border-l border-border/55 pl-2 text-c-sm italic text-muted-foreground"
                >
                  {block.entry.text}
                </p>
              ) : (
                <div key={block.key} className="my-1">
                  <MarkdownRenderer>{block.entry.text}</MarkdownRenderer>
                </div>
              )
            )}
            {report && (
              <div className="mt-3 border-t border-border/55 pt-2">
                <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Report
                </p>
                <MarkdownRenderer>{report}</MarkdownRenderer>
              </div>
            )}
            {running && <LiveFooter activity={agent.activity} />}
          </>
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

/**
 * This chat's subagents, and what each one is doing while it does it.
 *
 * Replaces a modal that had two states and nothing in between — a blue italic
 * line while the agent ran, then its whole report at once. A list and a stream
 * per agent, in the panel, so you can watch one work against the conversation
 * that spawned it instead of on top of it.
 *
 * One tab with two modes rather than a tab per agent: a fan-out of five would
 * otherwise bury every other tab in the strip. `tab.focus` is the mode.
 */
export default function SubagentsTab({
  sessionId,
  tab
}: {
  sessionId: string
  tab: SubagentsWorkspaceTab
}): React.JSX.Element {
  const agents = useSessionsStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.agents ?? NO_AGENTS
  )
  const focused = tab.focus ? agents.find((a) => a.toolId === tab.focus) : undefined

  // A chat cleared out from under an open tab is the one case the focus outlives
  // its agent. Falling back to the list beats a pane that looks broken.
  if (tab.focus && !focused) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
        <p className="text-center text-[11px] text-muted-foreground">
          That subagent is no longer in the conversation.
        </p>
        <button
          type="button"
          onClick={() => openSubagentsInPanel(null)}
          className="text-[11px] text-info transition-colors hover:underline"
        >
          All subagents
        </button>
      </div>
    )
  }

  if (focused) {
    return (
      <AgentStream
        sessionId={sessionId}
        agent={focused}
        onBack={() => openSubagentsInPanel(null)}
      />
    )
  }

  return <AgentList agents={agents} onOpen={(toolId) => openSubagentsInPanel(toolId)} />
}
