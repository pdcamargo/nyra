/**
 * What a turn changed, in the transcript.
 *
 * Sits in the message flow like a code block — not floated, not pinned. The
 * header opens the Changes tab; a filename opens the file itself, and the button
 * at its end opens the diff of that file.
 *
 * Both carry the block's `base` through, which is the whole point of recording
 * it: once the work is committed, "uncommitted changes" no longer contains any of
 * this, and a card that sent you there would open an empty pane.
 */
import React, { useState } from 'react'
import { ChevronDown, FileDiff, GitCommitHorizontal } from 'lucide-react'
import { byChurn, changeTotals, type ChangeBlock } from '../lib/changeBlocks'
import { openChangedFileInPanel, openChangesInPanel } from '../lib/openFile'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { ChangeScope } from '../store/changes'

/** Enough to see the shape of the work without pushing the reply off screen. */
const SHOWN = 5

export default function ChangesCard({ block }: { block: ChangeBlock }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (block.files.length === 0) return null

  const files = byChurn(block.files)
  const shown = expanded ? files : files.slice(0, SHOWN)
  const sum = changeTotals(files)
  const scope: ChangeScope | undefined = block.base
    ? { kind: 'since', base: block.base }
    : undefined

  return (
    <div className="my-2">
      <div className="overflow-hidden rounded-md border border-border/55 bg-card/40">
        <button
          type="button"
          onClick={() => openChangesInPanel({ scope })}
          className="flex w-full items-center gap-2 border-b border-border/55 px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
        >
          <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </span>
          {sum.insertions > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-success/80">
              +{sum.insertions.toLocaleString()}
            </span>
          )}
          {sum.deletions > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-danger/80">
              −{sum.deletions.toLocaleString()}
            </span>
          )}
        </button>

        {shown.map((f) => {
          const name = f.path.split('/').pop() ?? f.path
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
          return (
            <div
              key={f.path}
              className="flex w-full items-center gap-2 border-b border-border/55 transition-colors last:border-b-0 hover:bg-accent/50"
            >
              {/* The filename opens the file. A path in the transcript says
                  "this is the thing that changed", and the thing you want to
                  see is the file — the diff is the second question, asked with
                  the button on the right. */}
              <button
                type="button"
                onClick={() => void openChangedFileInPanel(f.path)}
                title={f.path}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
              >
                {/* Basename first: it is the part that identifies the file, and
                    the directory is what should be cut when space runs out. */}
                <span className="shrink-0 truncate font-mono text-xs text-foreground/80">
                  {name}
                </span>
                {dir && (
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                    {dir}
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                  {f.insertions > 0 && <span className="text-success/80">+{f.insertions}</span>}
                  {f.deletions > 0 && <span className="text-danger/80">−{f.deletions}</span>}
                </span>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Show the diff for ${name}`}
                    onClick={() => openChangesInPanel({ scope, focusPath: f.path })}
                    className="mr-1.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <FileDiff className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Open the diff</TooltipContent>
              </Tooltip>
            </div>
          )
        })}

        {files.length > SHOWN && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/50"
          >
            <ChevronDown
              className={`size-3 shrink-0 text-muted-foreground transition-transform ${
                expanded ? 'rotate-180' : ''
              }`}
            />
            <span className="text-[11px] text-muted-foreground">
              {expanded ? 'Show fewer' : `${files.length - SHOWN} more`}
            </span>
          </button>
        )}
      </div>

      {/* Outside the card rather than in its header: in the header it competes
          with the totals, and it is a footnote about the card, not part of it. */}
      {block.base && (
        <p className="mt-1 flex items-center gap-1.5 px-0.5 text-[10px] text-muted-foreground">
          <GitCommitHorizontal className="size-3 shrink-0" />
          <span className="font-mono">as of {block.base}</span>
        </p>
      )}
    </div>
  )
}
