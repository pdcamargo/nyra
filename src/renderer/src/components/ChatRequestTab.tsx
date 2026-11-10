import React from 'react'
import { CornerDownLeft } from 'lucide-react'
import MarkdownRenderer from './MarkdownRenderer'
import { effortLabel } from './ChatRequestDock'
import { useChatRequestsStore } from '../store/chatRequests'
import { useSessionsStore } from '../store/sessions'
import { useModelVersions } from '../store/modelVersions'
import { modelLabel } from '../lib/models'
import type { ChatRequestPanelTab } from '../store/panelTabs'

/**
 * The chat Claude wants to start, with room to read its prompt.
 *
 * The `PlanTab` bargain: this is where you read, the composer is where you
 * answer, so there are no buttons here to keep in step with the ones there.
 * What the meta box says follows the chips, so changing the model in the
 * composer changes it here too.
 */
export default function ChatRequestTab({
  sessionId,
  tab
}: {
  sessionId: string
  tab: ChatRequestPanelTab
}): React.JSX.Element {
  const request = useChatRequestsStore(
    (s) => s.bySession[sessionId]?.starts.find((r) => r.requestId === tab.requestId) ?? null
  )
  const askerTitle = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.title ?? '')
  const askerProjectId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.projectId ?? null)
  const projectName = useSessionsStore(
    (s) => s.projects.find((p) => p.id === request?.projectId)?.name ?? null
  )
  const versions = useModelVersions()

  // Answered, or withdrawn with the turn: the tab is closed then, so this is
  // only seen for the moment in between.
  if (!request) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-c-sm text-muted-foreground">This request has been answered.</p>
      </div>
    )
  }

  const project = projectName
    ? `${projectName}${request.projectId === askerProjectId ? ' (this project)' : " (not this chat's project)"}`
    : 'No project'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-c-sm text-muted-foreground">
          Asked by <span className="text-foreground">{askerTitle}</span> · {minutesAgo(request.askedAt)}
        </p>
        <h2 className="text-c-lg font-semibold leading-snug text-foreground">{request.title}</h2>
        {request.reason && <p className="text-c-md leading-snug text-muted-foreground">{request.reason}</p>}
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2.5 text-c-sm">
          <dt className="text-muted-foreground">Project</dt>
          <dd className={request.projectId !== askerProjectId ? 'text-warning' : 'text-foreground'}>{project}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="text-foreground">{request.model ? modelLabel(request.model, versions) : 'Default'}</dd>
          <dt className="text-muted-foreground">Effort</dt>
          <dd className="text-foreground">{effortLabel(request.effort).replace(/ effort$/, '')}</dd>
          <dt className="text-muted-foreground">Starts in</dt>
          <dd className="text-foreground">{request.planMode ? 'Plan mode' : 'Normal mode'}</dd>
        </dl>
        <p className="text-c-xs font-semibold uppercase tracking-wide text-muted-foreground">
          First message, word for word
        </p>
        <div className="text-c-md">
          <MarkdownRenderer>{request.prompt}</MarkdownRenderer>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border/55 px-5 py-2.5 text-c-sm text-muted-foreground">
        <CornerDownLeft className="size-3.5 shrink-0" />
        Answer in the composer: start, decline, or type a note.
      </div>
    </div>
  )
}

function minutesAgo(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000)
  return m < 1 ? 'just now' : `${m} min ago`
}
