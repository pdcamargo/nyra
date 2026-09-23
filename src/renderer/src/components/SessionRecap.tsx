import React from 'react'
import { ArrowDown, CircleAlert, CircleCheck, GitPullRequest, History, Sparkles, X } from 'lucide-react'
import { buildRecap, formatAway, RECAP_FILE_LIMIT, type RecapStat } from '../lib/recap'
import { useSessionsStore } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * What ran while you were in another chat.
 *
 * Coming back to a conversation that kept working is the one moment the
 * transcript is worst at: the answer is spread over forty messages you did not
 * watch arrive, and the only way to find out what happened is to read all of
 * them. This says it in a glance.
 *
 * Deliberately two halves. Everything above the buttons is derived from what is
 * already on disk, so it costs nothing and appears the instant you open the
 * chat. Prose costs a turn, so it is a button: "Ask Claude to summarise" runs
 * the CLI's own `/recap`, and carries a `1 turn` badge. A card that spends
 * tokens on being opened is a card you learn to dread, so nothing here spends
 * anything until you click the button that says what it costs.
 */

function StatRow({ stat }: { stat: RecapStat }): React.JSX.Element {
  if (stat.kind === 'tasks') {
    const all = stat.done === stat.total
    return (
      <div className="flex items-center gap-2">
        <CircleCheck className={`size-3.5 shrink-0 ${all ? 'text-success' : 'text-warning'}`} />
        <span className="text-c-sm text-foreground">
          {all ? 'Finished the checklist' : 'Checklist left partly done'} — {stat.done} of{' '}
          {stat.total} task{stat.total === 1 ? '' : 's'} done
        </span>
      </div>
    )
  }
  if (stat.kind === 'pr') {
    return (
      <div className="flex items-center gap-2">
        <GitPullRequest className="size-3.5 shrink-0 text-info" />
        <span className="min-w-0 truncate text-c-sm text-foreground">
          Opened PR #{stat.number}
          {stat.title ? ` — ${stat.title}` : ''}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <CircleAlert className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 truncate text-c-sm text-foreground">
        A turn ended with an error — {stat.text}
      </span>
    </div>
  )
}

export default function SessionRecap({
  sessionId,
  onSummarise,
  onJump,
  isOnScreen
}: {
  sessionId: string | null
  /** Spends a turn: runs the CLI's `/recap`. */
  onSummarise: () => void
  onJump: (messageId: string) => void
  /** Whether a message is already in view, which makes jumping to it pointless. */
  isOnScreen: (messageId: string) => boolean
}): React.JSX.Element | null {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const dismissAway = useSessionsStore((s) => s.dismissAway)
  const enabled = useSettingsStore((s) => s.awayRecap)

  // Only a fallback for a window pinned before its length was recorded. Frozen
  // at mount rather than ticking: a stopwatch would imply it is still running.
  const [now] = React.useState(() => Date.now())
  const recap = session ? buildRecap(session, now) : null
  if (!enabled || !session || !recap) return null

  const shown = recap.files.slice(0, RECAP_FILE_LIMIT)
  const rest = recap.files.length - shown.length

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card shadow-panel">
      <div className="flex items-center gap-2 bg-info/10 px-3 py-2">
        <History className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground">While you were away</span>
        <span className="flex-1 font-mono text-c-xs text-muted-foreground">
          {formatAway(recap.awayMs)}
          {recap.turns > 0 ? ` · ${recap.turns} turn${recap.turns === 1 ? '' : 's'}` : ''}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => dismissAway(session.id)}
              aria-label="Dismiss recap"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col gap-3 px-3 py-2.5">
        {recap.stats.length > 0 && (
          <div className="flex flex-col gap-2">
            {recap.stats.map((stat, i) => (
              <StatRow key={`${stat.kind}-${i}`} stat={stat} />
            ))}
          </div>
        )}

        {recap.files.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md bg-muted/50 px-2.5 py-2">
            <span className="text-c-xs text-muted-foreground">
              {recap.files.length} file{recap.files.length === 1 ? '' : 's'} changed
            </span>
            {shown.map((f) => (
              <div key={f.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-c-xs text-muted-foreground">
                  {f.path}
                </span>
                <span className="shrink-0 font-mono text-c-xs text-success">+{f.insertions}</span>
                <span className="shrink-0 font-mono text-c-xs text-danger">−{f.deletions}</span>
              </div>
            ))}
            {rest > 0 && (
              <span className="text-c-xs text-muted-foreground">and {rest} more</span>
            )}
          </div>
        )}
      </div>

      {/* The cost rides on the button that spends it. This was a caption under
          both buttons saying the card was free and the summary was not, which
          put the price of a decision in a footnote one line below where you
          make it, and truncated first whenever the panel narrowed. A badge on
          the button itself says it where it counts. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/55 px-3 py-2">
        <button
          type="button"
          onClick={onSummarise}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-c-xs text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Sparkles className="size-3" />
          Ask Claude to summarise
          <span className="rounded-sm bg-primary-foreground/15 px-1 py-px font-mono text-c-xxs">
            1 turn
          </span>
        </button>
        {/* The card sits over the bottom of the transcript, and a short
            window is often all still in view: offering to scroll to it then
            is a button that does nothing. */}
        {recap.firstMessageId && !isOnScreen(recap.firstMessageId) && (
          <button
            type="button"
            onClick={() => onJump(recap.firstMessageId as string)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-3 py-1 text-c-xs text-foreground transition-colors hover:bg-accent/50"
          >
            <ArrowDown className="size-3" />
            Jump to where you left off
          </button>
        )}
      </div>
    </div>
  )
}
