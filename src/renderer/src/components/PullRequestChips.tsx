/**
 * A chat's pull requests, in the four places they show up.
 *
 * One file rather than four, because the *labelling* rule is shared and is the
 * only part with a decision in it: a chip says `#42` while a chat's PRs live in
 * one repo and `nyra#42` once they do not. A chat working across three repos —
 * which is the case this was built for — would otherwise show three
 * indistinguishable numbers.
 *
 * Icon and colour both track the state, which is GitHub's own scheme on
 * purpose: anyone who reads PRs all day knows green-open, grey-draft,
 * purple-merged, red-closed without being told. Carrying it in the icon shape
 * too means the state survives being looked at by someone who does not separate
 * those hues.
 */
import React from 'react'
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useSessionsStore } from '../store/sessions'
import {
  PR_STATE_CLASS,
  PR_STATE_LABEL,
  prLabel,
  prSlug,
  sortPrs,
  spansRepos,
  type PullRequest
} from '../lib/pullRequests'

/** Stable empty array — a fresh one per call re-renders forever. */
const NO_PRS: PullRequest[] = []

/**
 * Up to this many pills inline; beyond it, a count that opens the list.
 *
 * Lower when the composer is narrow, because the bar has controls in it that
 * must never be the ones to give: a second PR pill pushed the send button clean
 * off the end of a 334 px bar, which is what `compact` exists to prevent. The
 * pills drop whole rather than clipping — half of `cli#9000` is `cli#90`, and a
 * chip that shows a *different PR number* is worse than a chip that shows a
 * count.
 */
const INLINE_LIMIT = 2
const INLINE_LIMIT_COMPACT = 1

export function openPr(url: string): void {
  void window.api.system.openExternal(url)
}

const ICONS = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed
} as const

export function PrIcon({
  pr,
  className = 'size-3.5'
}: {
  pr: PullRequest
  className?: string
}): React.JSX.Element {
  // No state yet — `gh` has not answered, or is not installed. The open icon is
  // the honest neutral here: it says "a PR", and the colour says nothing.
  const Icon = pr.state ? ICONS[pr.state] : GitPullRequest
  const tone = pr.state ? PR_STATE_CLASS[pr.state] : 'text-muted-foreground'
  return <Icon className={`${className} shrink-0 ${tone}`} aria-hidden="true" />
}

/** What the tooltip says: `owner/repo#42 · Merged`, then the title. */
function prTooltip(pr: PullRequest): string {
  const state = pr.state ? ` · ${PR_STATE_LABEL[pr.state]}` : ''
  return pr.title ? `${prSlug(pr)}${state}\n${pr.title}` : `${prSlug(pr)}${state}`
}

export function usePullRequests(sessionId: string | null): PullRequest[] {
  const prs = useSessionsStore((s) =>
    sessionId ? (s.sessions.find((x) => x.id === sessionId)?.pullRequests ?? NO_PRS) : NO_PRS
  )
  return prs
}

/** One row per PR, for the hover card and the Pinned Summary. */
export function PrRows({ prs }: { prs: readonly PullRequest[] }): React.JSX.Element {
  const withRepo = spansRepos(prs)
  return (
    <>
      {sortPrs(prs).map((pr) => (
        <button
          key={pr.url}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            openPr(pr.url)
          }}
          className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50"
        >
          <PrIcon pr={pr} />
          <span className="shrink-0 font-mono text-[11px] text-foreground/80">
            {prLabel(pr, withRepo)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {pr.title ?? ''}
          </span>
          {pr.state && (
            <span className={`shrink-0 text-[10px] ${PR_STATE_CLASS[pr.state]}`}>
              {PR_STATE_LABEL[pr.state]}
            </span>
          )}
        </button>
      ))}
    </>
  )
}

/**
 * The PRs on a chat's hover card, as lines rather than buttons.
 *
 * The card is a Radix tooltip: it exists to be read while you point at the row,
 * and a control inside something that closes when the pointer drifts is a
 * control you miss. So this matches the card's other lines — folder, branch,
 * worktree — and the clickable version lives in the composer and the summary,
 * both of which stay put.
 */
export function PrCardLines({ prs }: { prs: readonly PullRequest[] }): React.JSX.Element | null {
  if (prs.length === 0) return null
  const sorted = sortPrs(prs)
  const withRepo = spansRepos(sorted)
  return (
    <>
      {sorted.map((pr) => (
        <span key={pr.url} className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <PrIcon pr={pr} className="size-3" />
          <span className="shrink-0 font-mono">{prLabel(pr, withRepo)}</span>
          {pr.title && <span className="truncate">{pr.title}</span>}
          {pr.state && (
            <span className={`shrink-0 ${PR_STATE_CLASS[pr.state]}`}>{PR_STATE_LABEL[pr.state]}</span>
          )}
        </span>
      ))}
    </>
  )
}

/**
 * The composer's pills, left of the spacer with the other state about this turn.
 *
 * A couple inline, then a count — a chat that opened five PRs should not push
 * the model pill off the end of the bar. How many count as "a couple" depends on
 * how wide the bar actually is; see `compact`.
 */
export function ComposerPrPills({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const prs = usePullRequests(activeSessionId)
  if (prs.length === 0) return null

  const sorted = sortPrs(prs)
  // The repo prefix is the long part, and it is the first thing to go: a narrow
  // bar shows `#16079`, and the popover still says which repo it is in.
  const withRepo = spansRepos(sorted) && !compact

  if (sorted.length > (compact ? INLINE_LIMIT_COMPACT : INLINE_LIMIT)) {
    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground">
              <PrIcon pr={sorted[0]} className="size-3.5" />
              {sorted.length} PRs
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{`${sorted.length} pull requests from this chat`}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-80 p-1.5">
          <PrRows prs={sorted} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      {sorted.map((pr) => (
        <Tooltip key={pr.url}>
          <TooltipTrigger
            onClick={() => openPr(pr.url)}
            className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <PrIcon pr={pr} />
            <span className="font-mono">{prLabel(pr, withRepo)}</span>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{prTooltip(pr)}</TooltipContent>
        </Tooltip>
      ))}
    </>
  )
}

/**
 * The sidebar row's mark: an icon, or an icon and a count.
 *
 * Trailing, with the unread dot — not next to the spinner, which sits left of
 * the title and would shove it sideways every time a chat opened a PR. The
 * numbers themselves are in the hover card, which already exists to say what a
 * chat is.
 */
export function ChatRowPrChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const prs = usePullRequests(sessionId)
  if (prs.length === 0) return null
  const sorted = sortPrs(prs)
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <PrIcon pr={sorted[0]} className="size-3" />
      {sorted.length > 1 && (
        <span className="font-mono text-[0.7em] text-muted-foreground">{sorted.length}</span>
      )}
    </span>
  )
}
