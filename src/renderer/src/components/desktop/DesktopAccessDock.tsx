import React from 'react'
import { AppWindow } from 'lucide-react'
import { useDesktopStore } from '../../store/desktop'
import { answerDesktopAccess } from '../../lib/desktopControl'

/**
 * "Let Claude use Mail in this chat?", as the top of the composer.
 *
 * The turn is waiting on it, which is why it sits where a question from Claude
 * sits rather than in a toast: it is the thing to answer before anything else
 * happens in this chat. One at a time; a second app waits its turn.
 */
export default function DesktopAccessDock({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const ask = useDesktopStore((s) => s.bySession[sessionId]?.asks[0] ?? null)
  if (!ask) return null

  const answer = (a: 'chat' | 'always' | 'no'): void => answerDesktopAccess(sessionId, ask.key, a)
  const name = ask.app.name

  return (
    <div className="pb-2" role="group" aria-label={`Let Claude use ${name}?`}>
      <div className="flex items-center gap-2 pb-1.5">
        <AppWindow className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground">Let Claude use {name}?</span>
      </div>
      <p className="pb-2 text-c-sm leading-snug text-muted-foreground">
        Claude can see {name}’s windows, click and type in them. It checks with you before anything
        important, like sending or deleting. Press Esc to stop it.
      </p>
      {ask.warning && (
        <p className="pb-2 text-c-sm leading-snug text-warning">
          {ask.warning.charAt(0).toUpperCase() + ask.warning.slice(1)}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => answer('chat')}
          className="rounded-md bg-primary px-3 py-1 text-c-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          In this chat
        </button>
        <button
          type="button"
          onClick={() => answer('always')}
          className="rounded-md border border-input px-3 py-1 text-c-xs text-foreground transition-colors hover:bg-input/40"
        >
          Always
        </button>
        <button
          type="button"
          onClick={() => answer('no')}
          className="rounded-md border border-input px-3 py-1 text-c-xs text-foreground transition-colors hover:bg-input/40"
        >
          No
        </button>
      </div>
    </div>
  )
}
