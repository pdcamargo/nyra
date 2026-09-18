import React, { useRef, useEffect } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  activeIndex: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export default function InSessionSearchBar({
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onNext,
  onPrev,
  onClose
}: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.nativeEvent.stopImmediatePropagation()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-border/55 bg-popover px-4 py-1.5">
      <Search className="size-3.5 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in conversation…"
        className="flex-1 bg-transparent text-xs text-foreground placeholder-muted-foreground/70 outline-hidden"
      />
      {query && (
        <span className="text-[11px] text-muted-foreground font-mono tabular-nums shrink-0">
          {matchCount > 0 ? `${activeIndex + 1} of ${matchCount}` : 'No results'}
        </span>
      )}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onPrev}
              disabled={matchCount === 0}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground/80 disabled:opacity-25 transition-colors"
              aria-label="Previous (Shift+Enter)"
            >
              <ChevronUp className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Previous (Shift+Enter)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onNext}
              disabled={matchCount === 0}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground/80 disabled:opacity-25 transition-colors"
              aria-label="Next (Enter)"
            >
              <ChevronDown className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Next (Enter)</TooltipContent>
        </Tooltip>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClose}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground/80 transition-colors"
            aria-label="Close (Esc)"
          >
            <X className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Close (Esc)</TooltipContent>
      </Tooltip>
    </div>
  )
}
