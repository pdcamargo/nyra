/**
 * What Claude wrote to memory, as one line in the transcript.
 *
 * A memory write used to land inside the collapsed tool strip as "Created 1
 * file, Edited 1 file" against two paths under `~/.claude/projects/…` — true,
 * unreadable, and indistinguishable from work on the user's own repo. It is
 * worth naming, but only just: a line at trace-line density, an icon so it reads
 * as its own kind of event, and the memory's name as the way into the memory
 * tab. The description and the type badge live there, one click away.
 */
import React, { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'
import type { MemoryWrite } from '../lib/memoryWrites'
import { summarizeMemoryWrites } from '../lib/memoryWrites'
import { useUiStore } from '../store/ui'
import { TraceLine } from './ToolCallGroup'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export default function MemoryChip({
  writes,
  calls = []
}: {
  writes: MemoryWrite[]
  /** Every tool call behind the line, peeks included — shown only when expanded. */
  calls?: ToolCallMessage[]
}): React.JSX.Element | null {
  const openMemoryFile = useUiStore((s) => s.openMemoryFile)
  const [expanded, setExpanded] = useState(false)
  if (writes.length === 0) return null

  // The index is bookkeeping under whatever it accompanies — saving a memory is
  // the memory plus a pointer line in MEMORY.md, and only one of those is news.
  const named = writes.filter((w) => !w.isIndex)
  const pending = writes.some((w) => w.status === 'pending')
  const anyFailed = writes.some((w) => w.status === 'failed')

  // No status dot, so the row starts on the prose's edge: the headline carries
  // the state instead — shimmering while it saves, red when it failed.
  const headlineClass = pending ? 'nyra-shimmer' : anyFailed ? 'text-danger' : 'text-muted-foreground'

  const headline = summarizeMemoryWrites(writes)

  return (
    <div className="py-1">
      <div className="flex w-full items-center gap-2 py-1">
        <Brain className="size-3 shrink-0 text-muted-foreground" />
        {named.length === 0 ? (
          // Nothing but the index: the headline already names the one file, so it
          // is the link rather than repeating "MEMORY" after itself.
          <button
            type="button"
            onClick={() => openMemoryFile(writes[0].filePath)}
            title={writes[0].filePath}
            className={`truncate text-left text-c-sm transition-colors hover:text-foreground/80 ${headlineClass}`}
          >
            {headline}
          </button>
        ) : (
          <>
            <span className={`shrink-0 text-c-sm ${headlineClass}`}>{headline}</span>
            <span className="flex min-w-0 items-center gap-1 truncate">
              {named.map((w, i) => (
                <React.Fragment key={w.toolId}>
                  {i > 0 && <span className="shrink-0 text-c-sm text-muted-foreground">·</span>}
                  {w.deleted ? (
                    // Gone, so nothing to open — struck through rather than a link
                    // into a file the memory tab no longer has.
                    <span
                      title={w.filePath}
                      className="truncate font-mono text-c-sm text-muted-foreground line-through"
                    >
                      {w.displayName}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openMemoryFile(w.filePath)}
                      title={w.filePath}
                      className="truncate text-left font-mono text-c-sm text-info transition-colors hover:underline"
                    >
                      {w.displayName}
                    </button>
                  )}
                </React.Fragment>
              ))}
            </span>
          </>
        )}
        {calls.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? 'Hide tool calls' : 'Show tool calls'}
                aria-expanded={expanded}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground/80"
              >
                <ChevronRight className={`size-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{expanded ? 'Hide tool calls' : 'Show tool calls'}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {expanded && (
        <div className="ml-3 mt-1 border-l border-border/55 pl-2">
          {calls.map((m) => (
            <TraceLine key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  )
}
