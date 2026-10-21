import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ListTree, Search } from 'lucide-react'
import { fileName, type TimelineFile, type TimelinePrompt } from '../lib/promptTimeline'
import { formatMessageTime } from '../lib/messageTime'
import { formatElapsed } from './ActivityStrip'
import { openChangedFileInPanel, openChangesInPanel, openFileInPanel } from '../lib/openFile'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { IconButton } from './ui/icon-button'

/** Px between ticks while there is room for it; past that they share the rail. */
const PITCH = 12
/** Fewer than this and there is nothing to navigate between. */
const MIN_PROMPTS = 2

/**
 * A rail on the transcript's right edge: one tick per prompt you sent, longer
 * when that turn changed files. Hover shows the prompt and its files, a click
 * jumps there, and the button under it opens the outline of every prompt.
 *
 * Ticks are evenly spaced rather than placed where each prompt sits in the
 * scroll. The scrollbar already says where things are; this says what they are,
 * and a short turn should not cost its neighbour the room to be pointed at.
 */
export default function PromptTimeline({
  prompts,
  currentId,
  onJump
}: {
  prompts: TimelinePrompt[]
  /** The prompt whose turn is at the top of the view. */
  currentId: string | null
  onJump: (id: string) => void
}): React.JSX.Element | null {
  const railRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)

  useEffect(() => {
    const toggle = (): void => setOutlineOpen((open) => !open)
    window.addEventListener('nyra:prompt-outline', toggle)
    return () => window.removeEventListener('nyra:prompt-outline', toggle)
  }, [])

  if (prompts.length < MIN_PROMPTS) return null

  const n = prompts.length
  const topOf = (i: number): string => `calc(${i / (n - 1)} * (100% - 3px))`

  // The nearest tick to the pointer, not the one under it: packed ticks are too
  // thin to aim at.
  const indexAt = (clientY: number): number => {
    const box = railRef.current!.getBoundingClientRect()
    const t = (clientY - box.top) / Math.max(1, box.height)
    return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))
  }

  const hovered = hover === null ? null : prompts[hover]

  return (
    <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
      <div
        className="absolute top-1/2 z-20 flex -translate-y-1/2 flex-col items-end gap-3"
        style={{ right: 'calc(var(--scrollbar-size) + 4px)', height: `min(${(n - 1) * PITCH + 48}px, 60%)` }}
      >
        <PopoverAnchor asChild>
          <div
            ref={railRef}
            role="navigation"
            aria-label="Prompt timeline"
            // A strip wide enough to hover; the ticks inside are what is drawn.
            className="relative w-6 min-h-0 flex-1 cursor-pointer"
            onMouseMove={(e) => setHover(indexAt(e.clientY))}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => {
              onJump(prompts[indexAt(e.clientY)].id)
              setHover(null)
            }}
          >
            {prompts.map((p, i) => {
              const state =
                hover === i ? 'hover' : p.id === currentId ? 'current' : p.files.length > 0 ? 'changed' : 'plain'
              return (
                <span
                  key={p.id}
                  aria-hidden
                  className={`absolute right-1 h-[3px] rounded-full transition-[width,background-color] duration-100 ${
                    state === 'hover'
                      ? 'w-[18px] bg-info'
                      : state === 'current'
                        ? 'w-[18px] bg-foreground'
                        : state === 'changed'
                          ? 'w-3.5 bg-muted-foreground'
                          : 'w-2 bg-border-strong'
                  }`}
                  style={{ top: topOf(i) }}
                />
              )
            })}
            {hovered && !outlineOpen && (
              <div
                className="pointer-events-none absolute right-8 w-[300px] -translate-y-1/2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-panel"
                style={{ top: `calc(${topOf(hover!)} + 1.5px)` }}
              >
                <PromptMeta prompt={hovered} />
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug">{hovered.text}</p>
                {hovered.files.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {hovered.files.slice(0, 6).map((f) => (
                      <FileChip key={f.path} file={f} />
                    ))}
                    {hovered.files.length > 6 && (
                      <span className="self-center text-[11px] text-muted-foreground">+{hovered.files.length - 6} more</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </PopoverAnchor>
        <IconButton
          label="Prompt outline"
          command="chat.outline"
          active={outlineOpen}
          onClick={() => setOutlineOpen((open) => !open)}
          className="mr-0.5 text-muted-foreground"
        >
          <ListTree className="size-3.5" />
        </IconButton>
      </div>
      <PopoverContent
        side="left"
        align="center"
        sideOffset={12}
        className="w-[380px] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(e) => {
          // Into the filter, not onto the first row.
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).querySelector('input')?.focus()
        }}
      >
        <Outline
          prompts={prompts}
          currentId={currentId}
          onJump={(id) => {
            setOutlineOpen(false)
            onJump(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function PromptMeta({ prompt }: { prompt: TimelinePrompt }): React.JSX.Element {
  const parts = [
    prompt.at !== undefined ? formatMessageTime(prompt.at) : null,
    prompt.durationMs !== undefined ? formatElapsed(prompt.durationMs) : null
  ].filter(Boolean)
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="font-mono">{prompt.n}</span>
      <span>{parts.join(' · ')}</span>
    </div>
  )
}

function openFile(file: TimelineFile, base: string | undefined): void {
  if (base) openChangesInPanel({ scope: { kind: 'since', base }, focusPath: file.path })
  else if (/^([a-zA-Z]:[\\/]|\/)/.test(file.path)) openFileInPanel(file.path)
  else void openChangedFileInPanel(file.path)
}

function FileChip({
  file,
  onClick
}: {
  file: TimelineFile
  onClick?: () => void
}): React.JSX.Element {
  const body = (
    <>
      <span className="text-foreground">{fileName(file.path)}</span>
      {file.insertions > 0 && <span className="text-success">+{file.insertions}</span>}
      {file.deletions > 0 && <span className="text-danger">−{file.deletions}</span>}
    </>
  )
  const className =
    'flex items-center gap-1 rounded-sm border border-border/70 px-1.5 py-px font-mono text-[11px] leading-[18px]'
  return onClick ? (
    <button
      type="button"
      title={file.path}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`${className} transition-colors hover:bg-accent`}
    >
      {body}
    </button>
  ) : (
    <span className={className}>{body}</span>
  )
}

function Outline({
  prompts,
  currentId,
  onJump
}: {
  prompts: TimelinePrompt[]
  currentId: string | null
  onJump: (id: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return prompts
    return prompts.filter(
      (p) => p.text.toLowerCase().includes(q) || p.files.some((f) => f.path.toLowerCase().includes(q))
    )
  }, [prompts, query])
  const [active, setActive] = useState<number>(() => Math.max(0, prompts.findIndex((p) => p.id === currentId)))
  const listRef = useRef<HTMLDivElement>(null)

  // A new filter starts at the top of what it left.
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(shown.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter' && shown[active]) {
              e.preventDefault()
              onJump(shown[active].id)
            }
          }}
          placeholder="Filter prompts"
          aria-label="Filter prompts"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {shown.length === prompts.length ? `${prompts.length} prompts` : `${shown.length} of ${prompts.length}`}
        </span>
      </div>
      <div ref={listRef} role="listbox" aria-label="Prompts" className="max-h-[60vh] overflow-y-auto p-1">
        {shown.length === 0 && <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">No prompt matches</p>}
        {shown.map((p, i) => (
          <div
            key={p.id}
            role="option"
            aria-selected={i === active}
            data-row={i}
            onMouseEnter={() => setActive(i)}
            onClick={() => onJump(p.id)}
            className={`flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 ${
              i === active ? 'bg-accent' : p.id === currentId ? 'bg-accent/50' : ''
            }`}
          >
            <span className="w-[18px] shrink-0 pt-px font-mono text-[11px] text-muted-foreground">{p.n}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[13px]" title={p.text}>
                {p.text}
              </span>
              {p.files.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.files.map((f) => (
                    <FileChip key={f.path} file={f} onClick={() => openFile(f, p.base)} />
                  ))}
                </div>
              )}
            </div>
            {p.at !== undefined && (
              <span className="shrink-0 pt-px text-[11px] text-muted-foreground">{formatMessageTime(p.at)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
