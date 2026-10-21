import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, MessagesSquare, X } from 'lucide-react'
import { useOpenSideThread, type SideTurn } from '../store/sideQuestions'
import { useAnnotationsStore } from '../store/annotations'
import { applySideEvent, askSide, closeSide, keepSide } from '../lib/sideAsk'
import MarkdownRenderer from './MarkdownRenderer'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * A side question, answered beside the chat while the chat carries on.
 *
 * Throwaway by design: the answer comes from a fork the main conversation
 * never sees, and closing the sheet ends it. "Add to chat" is the one way
 * anything here reaches Claude, by parking the exchange with the next message.
 */
export default function SideQuestionSheet({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  // Mounted with the chat whether or not a sheet is open: the backend answers
  // by thread id, and a thread can stream while its chat is not on screen.
  useEffect(() => window.api.claude.onSide(applySideEvent), [])

  const thread = useOpenSideThread(sessionId)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const threadId = thread?.id
  // A new thread starts with an empty field, focused when there is nothing asked yet.
  useLayoutEffect(() => {
    setDraft('')
    if (threadId) field.current?.focus()
  }, [threadId])

  const last = thread?.turns[thread.turns.length - 1]
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [last?.answer, thread?.turns.length])

  if (!sessionId || !thread) return null
  const busy = last?.status === 'streaming'
  const answered = thread.turns.some((t) => t.status === 'done')

  const send = (): void => {
    if (!draft.trim() || busy) return
    askSide(sessionId, draft)
    setDraft('')
  }

  return (
    <aside
      aria-label="Side question"
      className="flex h-full w-[400px] shrink-0 flex-col border-l border-border/55 bg-side-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          closeSide(sessionId)
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/55 py-2.5 pl-4 pr-3">
        <MessagesSquare className="size-3.5 text-side-accent" />
        <span className="flex-1 text-[13px] font-[550]">Side question</span>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A span, so the tooltip still answers while the button is disabled. */}
            <span tabIndex={answered && !busy ? -1 : 0}>
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-at-8 px-3 text-[12.5px]"
                disabled={!answered || busy}
                onClick={() => keepSide(sessionId)}
              >
                Add to chat
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Not added to the chat. Gone when you close it.</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => closeSide(sessionId)}
              aria-label="Close side question"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close · gone for good</TooltipContent>
        </Tooltip>
      </div>

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-[14px]">
        {thread.quote && (
          <button
            type="button"
            onClick={() => {
              const q = thread.quote!
              useAnnotationsStore.getState().requestJump({ messageId: q.messageId, start: q.start, end: q.end })
            }}
            className="flex gap-2 text-left"
          >
            <span className="w-0.5 shrink-0 rounded-full bg-side-accent" />
            <span className="line-clamp-3 text-[12.5px] text-muted-foreground hover:text-foreground">{thread.quote.quote}</span>
          </button>
        )}
        {thread.turns.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            Ask anything about this chat. Claude answers from a copy of the conversation; the chat itself never sees it.
          </p>
        )}
        {thread.turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
      </div>

      <div className="px-4 pb-3 pt-1">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-border-strong">
          <textarea
            ref={field}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={thread.turns.length === 0 ? 'Ask on the side…' : 'Follow up…'}
            aria-label="Side question"
            className="max-h-32 min-h-5 flex-1 resize-none bg-transparent text-[13px] leading-5 outline-none [field-sizing:content] placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim() || busy}
            aria-label="Ask"
            className="mb-px rounded-md p-0.5 text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-50"
          >
            <ArrowUp className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
}

function Turn({ turn }: { turn: SideTurn }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="ml-8 self-end rounded-lg bg-bubble px-3.5 py-2 text-[13.5px] text-bubble-foreground whitespace-pre-wrap">
        {turn.question}
      </div>
      {turn.answer && (
        <div className="min-w-0">
          <MarkdownRenderer>{turn.answer}</MarkdownRenderer>
        </div>
      )}
      {turn.status === 'streaming' && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin text-side-accent" />
          {turn.activity ? `Looking with ${turn.activity}…` : turn.answer ? 'Answering…' : 'Reading the chat…'}
        </div>
      )}
      {turn.status === 'error' && <p className="text-[12.5px] text-danger">{turn.error}</p>}
    </div>
  )
}
