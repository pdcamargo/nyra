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
import React from 'react'
import { Brain } from 'lucide-react'
import type { MemoryWrite } from '../lib/memoryWrites'
import { summarizeMemoryWrites } from '../lib/memoryWrites'
import { useUiStore } from '../store/ui'

export default function MemoryChip({ writes }: { writes: MemoryWrite[] }): React.JSX.Element | null {
  const openMemoryFile = useUiStore((s) => s.openMemoryFile)
  if (writes.length === 0) return null

  // The index is bookkeeping under whatever it accompanies — saving a memory is
  // the memory plus a pointer line in MEMORY.md, and only one of those is news.
  const named = writes.filter((w) => !w.isIndex)
  const pending = writes.some((w) => w.status === 'pending')
  const anyFailed = writes.some((w) => w.status === 'failed')

  const dotClass = pending
    ? 'bg-warning/60 animate-pulse'
    : anyFailed
      ? 'bg-danger/60'
      : 'bg-success/40'

  const headline = summarizeMemoryWrites(writes)

  return (
    <div className="py-0.5">
      <div className="flex w-full items-center gap-2 px-1 py-[3px]">
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
        <Brain className="size-3 shrink-0 text-muted-foreground" />
        {named.length === 0 ? (
          // Nothing but the index: the headline already names the one file, so it
          // is the link rather than repeating "MEMORY" after itself.
          <button
            type="button"
            onClick={() => openMemoryFile(writes[0].filePath)}
            title={writes[0].filePath}
            className="truncate text-left text-c-sm text-muted-foreground transition-colors hover:text-foreground/80"
          >
            {headline}
          </button>
        ) : (
          <>
            <span className="shrink-0 text-c-sm text-muted-foreground">{headline}</span>
            <span className="flex min-w-0 items-center gap-1 truncate">
              {named.map((w, i) => (
                <React.Fragment key={w.toolId}>
                  {i > 0 && <span className="shrink-0 text-c-sm text-muted-foreground">·</span>}
                  <button
                    type="button"
                    onClick={() => openMemoryFile(w.filePath)}
                    title={w.filePath}
                    className="truncate text-left font-mono text-c-sm text-info transition-colors hover:underline"
                  >
                    {w.displayName}
                  </button>
                </React.Fragment>
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
