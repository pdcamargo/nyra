import React, { useEffect, useMemo } from 'react'
import { Check, ChevronDown, Eye, Folder, Gauge, ListChecks, MessageSquarePlus, PanelRightOpen, Sparkles } from 'lucide-react'
import type { Effort } from '@shared/types'
import { DockButton } from './QuestionDock'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { useChatRequestsStore, type ChatStartEdit, type ChatStartRequest } from '../store/chatRequests'
import { useSessionsStore, workspaceIdOf } from '../store/sessions'
import { useModelVersions } from '../store/modelVersions'
import { modelChoices, modelLabel } from '../lib/models'
import { answerChatStart, answerStatusAccess } from '../lib/chatControl'
import { openChatRequestInPanel } from '../lib/openFile'

const EFFORTS: { value: Effort; label: string }[] = [
  { value: '', label: 'Default effort' },
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'xhigh', label: 'Extra high effort' },
  { value: 'max', label: 'Max effort' }
]

export const effortLabel = (effort: Effort): string =>
  EFFORTS.find((e) => e.value === effort)?.label ?? `${effort} effort`

/**
 * "Start a new chat?", as the top of the composer.
 *
 * Claude's turn is held on it, so it sits where its questions sit. The title,
 * the reason and what it will run on are here; the prompt itself is a click
 * away in the side panel, because it can be pages long and this is a glance.
 * The chips are the answer's fine print — change the model before saying yes
 * and Claude is told you did.
 *
 * Like a plan, the composer below is the "no, because": anything typed there
 * goes back as the reason, and the buttons change to say so.
 */
export function ChatRequestDock({
  sessionId,
  text,
  running,
  onDeclined
}: {
  sessionId: string
  /** What is in the composer: the note a decline carries. */
  text: string
  /** Whether the turn is still going. One that ended took the request with it. */
  running: boolean
  /** The note was sent; clear the composer. */
  onDeclined: () => void
}): React.JSX.Element | null {
  const request = useChatRequestsStore((s) => s.bySession[sessionId]?.starts[0] ?? null)

  useEffect(() => {
    if (request && !running) answerChatStart(sessionId, request.requestId, { outcome: 'withdrawn' })
  }, [request, running, sessionId])

  if (!request) return null
  return <StartRequest sessionId={sessionId} request={request} text={text} onDeclined={onDeclined} />
}

function StartRequest({
  sessionId,
  request,
  text,
  onDeclined
}: {
  sessionId: string
  request: ChatStartRequest
  text: string
  onDeclined: () => void
}): React.JSX.Element {
  const versions = useModelVersions()
  // Strings, not the session: it is a new object on every streamed message.
  const askerProjectId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.projectId ?? null)
  const workspaceId = useSessionsStore((s) => {
    const asker = s.sessions.find((x) => x.id === sessionId)
    return asker ? workspaceIdOf(s, asker) : null
  })
  const allProjects = useSessionsStore((s) => s.projects)
  // Another workspace is another account; a chat cannot be started there.
  const projects = useMemo(
    () => allProjects.filter((p) => p.workspaceId === workspaceId),
    [allProjects, workspaceId]
  )
  const edit = (patch: ChatStartEdit): void =>
    useChatRequestsStore.getState().editStart(sessionId, request.requestId, patch)

  const note = text.trim()
  const elsewhere = request.projectId !== askerProjectId
  const target = projects.find((p) => p.id === request.projectId)
  const projectLabel = target?.name ?? 'No project'

  const start = (open: boolean): void => answerChatStart(sessionId, request.requestId, { outcome: 'started', open })
  const decline = (): void => {
    answerChatStart(sessionId, request.requestId, { outcome: 'declined', message: note })
    if (note) onDeclined()
  }

  const hint = note
    ? 'Your note goes back to Claude as the reason.'
    : elsewhere
      ? `Runs in ${projectLabel}, not this chat's project.`
      : 'Starts in the background.'

  return (
    <div className="pb-2" role="group" aria-label={`Start a new chat: ${request.title}?`}>
      <div className="flex items-center gap-2 pb-1.5">
        <MessageSquarePlus className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground/80">Start a new chat?</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => openChatRequestInPanel(sessionId, request.requestId)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1 text-c-sm font-medium text-info transition-opacity hover:opacity-80"
        >
          Read the full prompt
          <PanelRightOpen className="size-3.5" />
        </button>
      </div>
      <p className="pb-1 text-c-md font-medium leading-snug text-foreground">{request.title}</p>
      {request.reason && (
        <p className="line-clamp-2 pb-2 text-c-sm leading-snug text-muted-foreground">{request.reason}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <Chip icon={Folder} label={projectLabel} flag={elsewhere}>
          {projects.map((p) => (
            <ChoiceItem key={p.id} on={p.id === request.projectId} onSelect={() => edit({ projectId: p.id })}>
              {p.name}
              {p.id === askerProjectId ? <span className="text-muted-foreground"> · this chat's</span> : null}
            </ChoiceItem>
          ))}
          {askerProjectId === null && (
            <ChoiceItem on={request.projectId === null} onSelect={() => edit({ projectId: null })}>
              No project
            </ChoiceItem>
          )}
        </Chip>
        <Chip icon={Sparkles} label={request.model ? modelLabel(request.model, versions) : 'Default model'}>
          <ChoiceItem on={request.model === ''} onSelect={() => edit({ model: '' })}>
            Default model
          </ChoiceItem>
          {modelChoices(versions).map((m) => (
            <ChoiceItem key={m.value} on={m.value === request.model} onSelect={() => edit({ model: m.value })}>
              {m.label}
            </ChoiceItem>
          ))}
          {request.model && !modelChoices(versions).some((m) => m.value === request.model) && (
            <ChoiceItem on onSelect={() => undefined}>
              {modelLabel(request.model, versions)}
            </ChoiceItem>
          )}
        </Chip>
        <Chip icon={Gauge} label={effortLabel(request.effort)}>
          {EFFORTS.map((e) => (
            <ChoiceItem key={e.value || 'default'} on={e.value === request.effort} onSelect={() => edit({ effort: e.value })}>
              {e.label}
            </ChoiceItem>
          ))}
        </Chip>
        <button
          type="button"
          aria-pressed={request.planMode}
          onClick={() => edit({ planMode: !request.planMode })}
          className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-c-sm transition-colors ${
            request.planMode
              ? 'border-border-strong text-foreground'
              : 'border-input text-muted-foreground hover:text-foreground'
          }`}
        >
          <ListChecks className="size-3.5" />
          {request.planMode ? 'Plan mode' : 'No plan mode'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`min-w-0 flex-1 truncate text-c-xs ${!note && elsewhere ? 'text-warning' : 'text-muted-foreground'}`}>
          {hint}
        </span>
        {note ? (
          <>
            <DockButton solid onClick={decline}>
              Decline with note
            </DockButton>
            <DockButton onClick={() => start(false)}>Start chat</DockButton>
          </>
        ) : (
          <>
            <DockButton onClick={decline}>No</DockButton>
            <DockButton onClick={() => start(true)}>Start &amp; open</DockButton>
            <DockButton solid onClick={() => start(false)}>
              Start chat
            </DockButton>
          </>
        )}
      </div>
      <div className="mt-2 h-px bg-separator" />
    </div>
  )
}

function Chip({
  icon: Icon,
  label,
  flag = false,
  children
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  /** A project other than the asking chat's. */
  flag?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-c-sm text-foreground transition-colors hover:bg-accent/50 aria-expanded:bg-accent ${
          flag ? 'border-warning' : 'border-input'
        }`}
      >
        <Icon className={`size-3.5 ${flag ? 'text-warning' : 'text-muted-foreground'}`} />
        {label}
        <ChevronDown className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-72 min-w-44 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChoiceItem({
  on,
  onSelect,
  children
}: {
  on: boolean
  onSelect: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect} className="flex items-center gap-2">
      <span className="flex-1">{children}</span>
      {on && <Check className="size-3.5 text-foreground" />}
    </DropdownMenuItem>
  )
}

/**
 * "Let Claude see what's running in web?", the first time a chat looks at
 * another project of the same workspace. The `DesktopAccessDock` shape: once,
 * here, or always — "always" kept on this chat's project and revocable in its
 * settings.
 */
export function StatusAccessDock({
  sessionId,
  running
}: {
  sessionId: string
  running: boolean
}): React.JSX.Element | null {
  const ask = useChatRequestsStore((s) => s.bySession[sessionId]?.peeks[0] ?? null)

  useEffect(() => {
    if (ask && !running) useChatRequestsStore.getState().settlePeek(sessionId, ask.key, 'dismissed')
  }, [ask, running, sessionId])

  if (!ask) return null
  const answer = (a: 'chat' | 'always' | 'no'): void => answerStatusAccess(sessionId, ask.key, a)
  const name = ask.projectName

  return (
    <div className="pb-2" role="group" aria-label={`Let Claude see what's running in ${name}?`}>
      <div className="flex items-center gap-2 pb-1.5">
        <Eye className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground">
          Let Claude see what’s running in {name}?
        </span>
      </div>
      <p className="pb-2 text-c-sm leading-snug text-muted-foreground">
        Claude sees each chat’s title and state: running, waiting on you, its subagents and background
        tasks, and what it is waiting for. It doesn’t see the messages, and it can’t change anything there.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-c-xs text-muted-foreground">
          {ask.canAlways ? 'You can take “Always” back in Project settings.' : ''}
        </span>
        <DockButton onClick={() => answer('no')}>No</DockButton>
        {ask.canAlways && <DockButton onClick={() => answer('always')}>Always</DockButton>}
        <DockButton solid onClick={() => answer('chat')}>
          In this chat
        </DockButton>
      </div>
      <div className="mt-2 h-px bg-separator" />
    </div>
  )
}
