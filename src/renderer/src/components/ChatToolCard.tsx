import React, { useMemo, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  FolderTree,
  LoaderCircle,
  MessageSquarePlus,
  MessageSquareText,
  MessageSquareX
} from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'
import { useSessionsStore } from '../store/sessions'
import { useChatRequestsStore } from '../store/chatRequests'
import { openChatRequestInPanel } from '../lib/openFile'
import { useModelVersions } from '../store/modelVersions'
import { modelLabel } from '../lib/models'
import { effortLabel } from './ChatRequestDock'
import type { Effort } from '@shared/types'

type Status = {
  id: string
  title: string
  state: string
  waitingOn?: string
  runningFor?: string
  idleFor?: string
  tool?: string
  subagents?: { name: string; doing?: string }[]
  background?: { kind: string; what: string }[]
  wakesIn?: string
  flow?: { name: string; status: string }
}

function parse(result: string | undefined): Record<string, unknown> | null {
  if (!result) return null
  try {
    const v = JSON.parse(result)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * A `nyra_chat` call in the transcript: a chat it asked to start and what you
 * said, or the chats it looked at and what they were doing. Reads are cards you
 * can open; a start is one line, because the decision was made in the composer.
 */
export default function ChatToolCard({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const action = str(message.input.action)
  const result = useMemo(() => parse(message.result), [message.result])

  if (message.result !== undefined && (message.isError || !result)) {
    return (
      <Line icon={MessageSquareX} muted>
        {action === 'start' ? 'Couldn’t start a chat' : 'Couldn’t check chats'}
        {message.result ? `: ${message.result.split('\n')[0]}` : ''}
      </Line>
    )
  }
  if (action === 'start') return <StartLine message={message} result={result} />
  if (!result) {
    return (
      <Line icon={Activity} muted>
        <span className="nyra-shimmer">Checking chats…</span>
      </Line>
    )
  }
  if (action === 'read') return <ReplyCard result={result} />
  if (action === 'projects') {
    const projects = Array.isArray(result.projects) ? result.projects.length : 0
    return (
      <Line icon={FolderTree} muted>
        Listed {projects} {projects === 1 ? 'project' : 'projects'} in this workspace
      </Line>
    )
  }
  const chats = (action === 'status' ? [result] : Array.isArray(result.chats) ? result.chats : []) as Status[]
  const where = str(result.project)
  const heading =
    action === 'status'
      ? ['Checked ', <span key="t" className="text-foreground">{str(result.title)}</span>]
      : [
          'Checked ',
          <span key="n" className="text-foreground">
            {chats.length} {chats.length === 1 ? 'chat' : 'chats'}
          </span>,
          where ? ` in ${where}` : ' outside any project'
        ]
  return <StatusCard heading={heading} chats={chats} />
}

function StartLine({
  message,
  result
}: {
  message: ToolCallMessage
  result: Record<string, unknown> | null
}): React.JSX.Element {
  const title = str(message.input.title) || 'a new chat'
  // A card is only on screen in the chat it belongs to, so that chat's
  // request is the one to look in. A string, so the selector settles.
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const pending = useChatRequestsStore((s) =>
    sessionId ? (s.bySession[sessionId]?.starts.find((r) => r.title === title)?.requestId ?? null) : null
  )
  const started = result?.outcome === 'started' ? str(result.chat) : ''
  const exists = useSessionsStore((s) => !!started && s.sessions.some((x) => x.id === started))
  const versions = useModelVersions()

  if (!result) {
    return (
      <button
        type="button"
        disabled={!pending}
        onClick={() => pending && sessionId && openChatRequestInPanel(sessionId, pending)}
        className="my-1 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-start text-c-md"
      >
        <MessageSquarePlus className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Start a chat · <span className="text-foreground">{title}</span>
        </span>
        {pending && (
          <>
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-warning" />
            <span className="shrink-0 text-c-sm text-warning">Waiting for you</span>
          </>
        )}
      </button>
    )
  }

  if (result.outcome === 'started') {
    const model = str(result.model)
    const effort = str(result.effort)
    const facts = [
      model && model !== 'default' ? modelLabel(model, versions) : '',
      effort && effort !== 'default' ? effortLabel(effort as Effort).replace(/ effort$/, '') : ''
    ].filter(Boolean)
    return (
      <div className="my-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-c-md">
        <MessageSquarePlus className="size-3.5 shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Started <span className="text-foreground">{str(result.title) || title}</span>
          {facts.length ? ` · ${facts.join(' · ')}` : ''}
          {result.project ? ` · ${str(result.project)}` : ''}
        </span>
        {exists && (
          <button
            type="button"
            onClick={() => useSessionsStore.getState().setActiveSession(started)}
            className="flex shrink-0 items-center gap-1 text-c-sm font-medium text-info hover:opacity-80"
          >
            Open
            <ArrowUpRight className="size-3.5" />
          </button>
        )}
      </div>
    )
  }

  if (result.outcome === 'declined') {
    const note = str(result.message)
    return (
      <Line icon={MessageSquareX} muted>
        Declined{note ? ' · ' : ` · ${title}`}
        {note && <span className="text-foreground">“{note}”</span>}
      </Line>
    )
  }
  return (
    <Line icon={MessageSquareX} muted>
      No answer · {title}
    </Line>
  )
}

function Line({
  icon: Icon,
  muted,
  children
}: {
  icon: React.ComponentType<{ className?: string }>
  muted?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1 text-c-md">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={`min-w-0 truncate ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{children}</span>
    </div>
  )
}

function StatusCard({ heading, chats }: { heading: React.ReactNode; chats: Status[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border text-c-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-start"
      >
        <Activity className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{heading}</span>
        {open ? (
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/55 px-3 py-2">
          {chats.length === 0 && <p className="text-c-sm text-muted-foreground">No chats.</p>}
          {chats.map((c) => (
            <StatusRow key={c.id} chat={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function StatusRow({ chat }: { chat: Status }): React.JSX.Element {
  const tone = chat.waitingOn ? 'waiting' : chat.state === 'running' ? 'running' : 'idle'
  const state =
    tone === 'waiting'
      ? 'Waiting on you'
      : tone === 'running'
        ? `Running${chat.runningFor ? ` · ${chat.runningFor}` : ''}`
        : `Idle${chat.idleFor ? ` · ${chat.idleFor}` : ''}`
  const detail = [
    chat.waitingOn ? `Needs ${chat.waitingOn}` : '',
    chat.tool ?? '',
    chat.subagents?.length ? `${chat.subagents.length} ${chat.subagents.length === 1 ? 'subagent' : 'subagents'} working` : '',
    chat.background?.length
      ? chat.background.length === 1
        ? `${chat.background[0].kind === 'monitor' ? 'Watching' : 'Waiting on'} ${chat.background[0].what}`
        : `${chat.background.length} background tasks`
      : '',
    chat.wakesIn ? `wakes in ${chat.wakesIn}` : '',
    chat.flow ? `Flow ${chat.flow.name} ${chat.flow.status}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex items-start gap-2">
      <span
        className={`mt-[0.45em] size-1.5 shrink-0 rounded-full ${
          tone === 'waiting' ? 'bg-warning' : tone === 'running' ? 'bg-info' : 'bg-muted-foreground'
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={() => useSessionsStore.getState().setActiveSession(chat.id)}
            className="min-w-0 flex-1 truncate text-start font-medium text-foreground hover:underline"
          >
            {chat.title}
          </button>
          <span
            className={`shrink-0 text-c-sm ${
              tone === 'waiting' ? 'text-warning' : tone === 'running' ? 'text-info' : 'text-muted-foreground'
            }`}
          >
            {state}
          </span>
        </div>
        {detail && <p className="truncate text-c-sm text-muted-foreground">{detail}</p>}
      </div>
    </div>
  )
}

function ReplyCard({ result }: { result: Record<string, unknown> }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const reply = str(result.reply)
  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border text-c-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-start"
      >
        <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Read the last reply of <span className="text-foreground">{str(result.title)}</span>
        </span>
        <span className="shrink-0 text-c-sm text-muted-foreground">{str(result.state)}</span>
        {open ? (
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <p className="line-clamp-3 whitespace-pre-line border-t border-border/55 px-3 py-2 text-foreground">
          {reply || 'No reply yet.'}
        </p>
      )}
    </div>
  )
}
