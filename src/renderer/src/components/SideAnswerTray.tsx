import { MessagesSquare, X } from 'lucide-react'
import { useKeptSideThreads, useSideQuestionsStore } from '../store/sideQuestions'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * Side answers added to the chat, at the top of the composer. Each rides along
 * with the next message, like an annotation, and only then reaches Claude.
 */
export default function SideAnswerTray({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const kept = useKeptSideThreads(sessionId)
  if (!sessionId || kept.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 pb-2">
      {kept.map((t) => (
        <span
          key={t.id}
          className="flex max-w-full items-center gap-1.5 rounded-full border bg-background py-1 pl-2.5 pr-1 text-[12.5px]"
        >
          <MessagesSquare className="size-3.5 shrink-0 text-side-accent" />
          <span className="shrink-0 font-[550]">Side answer</span>
          <span className="min-w-0 truncate text-muted-foreground" title={t.turns[0]?.question}>
            {t.turns[0]?.question}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => useSideQuestionsStore.getState().unkeep(sessionId, t.id)}
                aria-label="Remove side answer"
                className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Don't send it</TooltipContent>
          </Tooltip>
        </span>
      ))}
    </div>
  )
}
