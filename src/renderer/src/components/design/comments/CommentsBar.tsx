import { useState } from 'react'
import { Eye, EyeOff, Info, MessageCircle, PanelRight, X } from 'lucide-react'
import { cn } from 'cn'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { since, threadOf, type DesignComment } from '../../../lib/designComments'

type Filter = 'open' | 'resolved' | 'all'

/**
 * The count of comments on this file, the eye that hides their pins, and the
 * button that opens the list. Floats over the canvas; the list itself is
 * `CommentsPanel`, docked beside it.
 *
 * Only there once a file has comments: a bar that says "0" is a bar in the way.
 */
export default function CommentsBar({
  comments,
  shown,
  onShown,
  onList
}: {
  comments: DesignComment[]
  shown: boolean
  onShown: (shown: boolean) => void
  onList: () => void
}): React.ReactElement | null {
  if (comments.length === 0) return null
  const open = comments.filter((c) => c.status !== 'resolved')
  const resolved = comments.length - open.length
  return (
    <div className="absolute top-3 right-3 z-30 flex items-center gap-2 rounded-[8px] border bg-background px-2 py-1 text-[12.5px]">
      <button type="button" onClick={onList} className="flex items-center gap-1.5 hover:text-foreground">
        <MessageCircle className="size-[13px] text-muted-foreground" />
        <span className="tabular-nums">{open.length} open</span>
        {resolved > 0 && <span className="text-muted-foreground tabular-nums">· {resolved} resolved</span>}
      </button>
      <span className="h-3.5 w-px bg-border" aria-hidden="true" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={shown ? 'Hide comments' : 'Show comments'}
            aria-pressed={!shown}
            onClick={() => onShown(!shown)}
            className="rounded-[4px] p-0.5 text-muted-foreground hover:text-foreground"
          >
            {shown ? <Eye className="size-[13px]" /> : <EyeOff className="size-[13px]" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{shown ? 'Hide comments' : 'Show comments'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="List comments"
            onClick={onList}
            className="rounded-[4px] p-0.5 text-muted-foreground hover:text-foreground"
          >
            <PanelRight className="size-[13px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>List comments</TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The comments on this file, docked beside the canvas so it narrows rather
 * than hiding what is under the list. For finding one again: every comment
 * already went to Claude when it was sent.
 */
export function CommentsPanel({
  comments,
  activeId,
  onPick,
  onClose
}: {
  comments: DesignComment[]
  activeId: string | null
  /** Frame the comment's artboard and open its pin. */
  onPick: (c: DesignComment) => void
  onClose: () => void
}): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('open')
  const open = comments.filter((c) => c.status !== 'resolved')
  const resolved = comments.length - open.length
  const listed = filter === 'all' ? comments : filter === 'open' ? open : comments.filter((c) => c.status === 'resolved')
  return (
    <aside className="flex w-[280px] shrink-0 flex-col gap-3 border-l bg-background p-3 text-[12.5px]">
      <div className="flex items-center gap-2 px-1 pt-1">
        <span className="flex-1 text-[15px] font-semibold">Comments</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Close comments"
              onClick={onClose}
              className="rounded-[4px] p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-[13px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex rounded-[8px] bg-muted p-0.5" role="tablist">
        {(
          [
            ['open', `Open ${open.length}`],
            ['resolved', `Resolved ${resolved}`],
            ['all', 'All']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={cn(
              'rounded-[4px] px-3 py-0.5',
              filter === key ? 'bg-background font-[550] ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
        {listed.length === 0 ? (
          <p className="p-3 text-center text-muted-foreground">{filter === 'open' ? 'Nothing open.' : 'None yet.'}</p>
        ) : (
          listed.map((c) => {
            const last = threadOf(c).at(-1)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-[8px] px-3 py-2 text-left',
                  activeId === c.id ? 'bg-design-accent/10' : 'hover:bg-muted/60'
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-medium tabular-nums',
                    c.status === 'resolved' ? 'border border-input bg-background text-success' : 'bg-design-accent text-design-accent-foreground'
                  )}
                >
                  {c.n}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[11.5px] font-medium text-muted-foreground">
                    {c.anchor.label} · {c.artboardName}
                  </span>
                  <span className="line-clamp-2">{c.text}</span>
                  <span className="text-[11.5px] font-medium text-muted-foreground">
                    You · {since(c.createdAt)}
                    {last ? ` · ${threadOf(c).length} ${threadOf(c).length === 1 ? 'reply' : 'replies'}` : ''}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
      <p className="flex items-start gap-2 rounded-[8px] bg-muted p-2 text-[11.5px] font-medium text-muted-foreground">
        <Info className="mt-px size-[13px] shrink-0" />
        Every comment went to Claude when you sent it. This list is for finding them again.
      </p>
    </aside>
  )
}
