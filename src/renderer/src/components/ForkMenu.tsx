import React from 'react'
import { ArrowUpRight, Folder, FolderGit2, GitFork } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { useSessionsStore, type ForkMode } from '../store/sessions'
import { canForkIntoWorktree, forkLocalLabel } from '../lib/fork'

/**
 * The two ways to fork, as one menu: into local, or into a new worktree.
 *
 * Codex's pair, and its rule: no dialog. Picking one forks at once and opens the
 * fork, Claude names it after its first message, and renaming is what the list
 * is for. The trigger is the caller's, so a reply's labelled button and the bare
 * icon beside your own message open the same thing.
 */
export function ForkMenu({
  sessionId,
  onFork,
  align = 'start',
  children
}: {
  sessionId: string
  onFork: (mode: ForkMode) => void
  align?: 'start' | 'end'
  children: React.ReactNode
}): React.JSX.Element {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-72">
        <ForkMenuItems
          localLabel={forkLocalLabel(session)}
          worktreeAllowed={canForkIntoWorktree(session)}
          onFork={onFork}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ForkMenuItems({
  localLabel,
  worktreeAllowed,
  onFork
}: {
  localLabel: string
  worktreeAllowed: boolean
  onFork: (mode: ForkMode) => void
}): React.JSX.Element {
  return (
    <>
      <DropdownMenuItem className="items-start" onSelect={() => onFork('local')}>
        <Folder className="mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span>{localLabel}</span>
          <span className="text-c-sm text-muted-foreground">
            Same files as this chat. Claude remembers everything above.
          </span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem className="items-start" disabled={!worktreeAllowed} onSelect={() => onFork('worktree')}>
        <FolderGit2 className="mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span>Fork into new worktree</span>
          <span className="text-c-sm text-muted-foreground">
            {worktreeAllowed
              ? 'Its own copy of the branch, with your uncommitted changes.'
              : 'Only in a git repository.'}
          </span>
        </span>
      </DropdownMenuItem>
    </>
  )
}

/**
 * Where a fork and its source meet, as one line across the transcript.
 *
 * Under the fork's copied history it says where the chat came from; in the
 * source, under the message it was cut after, it says where the conversation
 * went. Either way it opens the other chat. It replaced a message written in
 * Claude's voice that said the same thing, which Claude never said.
 *
 * `to` is null when the other chat is gone: the line still says what happened,
 * it just has nowhere left to go.
 */
export function ForkMark({
  direction,
  title,
  to,
  note
}: {
  direction: 'from' | 'into'
  title: string
  to: string | null
  note?: string
}): React.JSX.Element {
  const body = (
    <>
      <GitFork className="size-3 shrink-0" />
      <span className="shrink-0">{direction === 'from' ? 'Forked from' : 'Forked into'}</span>
      <span className="truncate font-medium text-foreground">{title}</span>
      {note && <span className="shrink-0">· {note}</span>}
      {to && <ArrowUpRight className="size-3 shrink-0" />}
    </>
  )
  const pill =
    'flex min-w-0 max-w-[80%] items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-0.5 text-c-sm text-muted-foreground'
  return (
    <div className="flex items-center gap-2 py-2" data-fork-mark={direction}>
      <div className="h-px flex-1 bg-border" />
      {to ? (
        <button
          type="button"
          className={`${pill} transition-colors hover:bg-accent/50 hover:text-foreground`}
          onClick={() => useSessionsStore.getState().setActiveSession(to)}
        >
          {body}
        </button>
      ) : (
        <span className={pill}>{body}</span>
      )}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
