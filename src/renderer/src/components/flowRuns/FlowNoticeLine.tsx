import React from 'react'
import { Workflow } from 'lucide-react'
import type { MessageContext } from '../../store/sessions'
import { openFlowRunInPanel } from '../../lib/openFile'

/**
 * What a run told the chat — it paused here, it ended — where it happened.
 *
 * Sent as a message so Claude reads it and takes a turn, but it is not the
 * user speaking, so it is a line rather than a bubble on the user's side.
 */
export default function FlowNoticeLine({ context }: { context: MessageContext[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 py-1">
      {context.map((c, i) => (
        <button
          key={i}
          type="button"
          onClick={() => c.ref?.executionId && openFlowRunInPanel(c.ref.executionId)}
          className="flex items-center gap-2 self-start text-c-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Workflow className="size-3.5 shrink-0 text-info" />
          <span className="truncate">{c.label}</span>
        </button>
      ))}
    </div>
  )
}

/** A user message that is only a run reporting in. */
export function isFlowNotice(text: string, context: MessageContext[] | undefined): boolean {
  return !text.trim() && !!context?.length && context.every((c) => c.kind === 'flow-run')
}
