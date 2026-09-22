import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import MarkdownRenderer from '../MarkdownRenderer'
import Modal from '../Modal'
import { homedir } from '../../lib/homedir'
import { activeProjectCwd, useSessionsStore } from '../../store/sessions'
import type { ScopedList } from '../../lib/api-types'

/**
 * The parts Skills, Commands and Memory share.
 *
 * All three were a filter box over a stack of full-width rows, each row carrying
 * four hover-revealed text buttons — a list that reported one item per 56px and
 * spent the other 600px of the page on nothing. What they have in common is the
 * shape of the thing: a global set, a set per project, and an item that is a
 * markdown file you mostly want to *read*.
 *
 * So: one search, a global section, a tab per project, a two-column grid, and a
 * dialog that renders the file. The per-row buttons are gone — Run, Edit, Export
 * and Delete were four targets on every row for actions you take on one item
 * occasionally, and they now live in the dialog for the item you opened.
 */

/** Anything with a name, a one-line description and a file behind it. */
export type LibraryItem = {
  name: string
  /** Optional: a CLAUDE.md anchor has no frontmatter to take one from. */
  description?: string
  filePath: string
}

/** Filters by name and description, which is all any of these rows shows. */
export function matches<T extends LibraryItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (i) => i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q)
  )
}

export function LibrarySearch({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
}): React.JSX.Element {
  return (
    <div className="relative mb-7">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-full border border-border bg-muted/40 py-2 pl-9 pr-3 text-c-md text-foreground outline-hidden placeholder:text-muted-foreground focus:border-border-strong"
      />
    </div>
  )
}

export function SectionHeading({
  children,
  trailing
}: {
  children: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4 border-b border-separator pb-2">
      <h2 className="text-c-lg font-medium text-foreground">{children}</h2>
      {trailing && <span className="shrink-0 font-mono text-c-xs text-muted-foreground">{trailing}</span>}
    </div>
  )
}

/**
 * One tab per project, current one live.
 *
 * A segmented control — one of N is on and the fill *is* the answer — so it
 * takes --bubble, the same idiom as the rail's Chat/Flow toggle, rather than the
 * quieter pill a list selection gets.
 */
export function ProjectTabs({
  projects,
  activeId,
  onSelect
}: {
  projects: { id: string; name: string }[]
  activeId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element | null {
  if (projects.length === 0) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1">
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect(p.id)}
          className={`rounded-full px-3 py-1 text-c-md transition-colors ${
            p.id === activeId
              ? 'bg-bubble font-medium text-bubble-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          }`}
        >
          {p.name}
        </button>
      ))}
    </div>
  )
}

export function LibraryGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">{children}</div>
}

/**
 * One item.
 *
 * Two lines, the second one truncated to exactly one. The old row let the
 * description wrap, so a long one pushed the next item down the page and the
 * list lost its rhythm — and a description is a reminder of what the thing is,
 * not something anyone reads to the end from an index.
 */
export function LibraryCard({
  name,
  description,
  Icon,
  badge,
  onClick
}: {
  name: string
  description?: string
  Icon: React.ComponentType<{ className?: string }>
  badge?: React.ReactNode
  /** Omitted for a card that only reports something — the CLI reference has no
   *  file to open, and a button that does nothing when clicked is worse than
   *  text. */
  onClick?: () => void
}): React.JSX.Element {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`flex min-w-0 items-center gap-2.5 rounded-lg border border-border/55 bg-muted/40 px-2.5 py-2 text-left ${
        onClick ? 'transition-colors hover:bg-accent/60' : ''
      }`}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background/70 ring-1 ring-border/60">
        <Icon className="size-3.5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-c-md font-medium text-foreground">{name}</span>
          {badge}
        </span>
        <span className="block truncate text-c-sm text-muted-foreground">
          {description || 'No description'}
        </span>
      </span>
    </Tag>
  )
}

export function EmptyNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-0.5 py-2 text-c-md text-muted-foreground">{children}</p>
}

/** Everything above the body of a skill or command file, which the dialog header
 *  already says in its own words. */
function withoutFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  return (match?.[1] ?? content).trim()
}

/**
 * Read one of these files.
 *
 * Deliberately not an editor: this is the thing you reach for to remember what a
 * skill actually tells the model, and an editor makes that a decision about
 * whether you are about to change it. Editing is still one button away for the
 * things that have an editor.
 *
 * `fs.readTextFile` rather than `fs.readFile` — it is the bounded read, meant for
 * exactly this, and it refuses a binary or an enormous file by name instead of
 * handing back a screenful of mojibake.
 */
export function PreviewDialog({
  open,
  onClose,
  name,
  description,
  filePath,
  kind,
  badge,
  onDelete,
  actions
}: {
  open: boolean
  onClose: () => void
  name: string
  description: string
  filePath: string
  /** The word after the title — "Skill", "Command". */
  kind: string
  badge?: React.ReactNode
  onDelete?: () => void | Promise<void>
  actions?: React.ReactNode
}): React.JSX.Element {
  const [body, setBody] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    setBody(null)
    setConfirming(false)
    void window.api.fs.readTextFile(filePath).then((outcome) => {
      if (!live) return
      if (outcome.kind === 'text') setBody(withoutFrontmatter(outcome.content))
      else if (outcome.kind === 'error') setBody(`Could not read this file: ${outcome.message}`)
      else setBody('This file is not readable as text.')
    })
    return () => {
      live = false
    }
  }, [open, filePath])

  return (
    <Modal open={open} onClose={onClose} title={name} showCloseButton className="sm:max-w-2xl">
      {/* min-w-0 the whole way down. A fenced code block in a skill is as wide as
          its longest line, and a flex child sized `auto` grows to fit it — so
          without this the column is wider than the dialog and the dialog, which
          is overflow-hidden, simply cuts the right-hand side off. */}
      {/* The cap is the dialog's own 85vh minus its 1rem of padding on each
          side. Repeating a bare 85vh here asks for the whole dialog inside the
          dialog's content box, and the footer ends up 16px below the bottom
          edge — visibly hanging off it. */}
      <div className="flex max-h-[calc(85vh-2rem)] min-h-0 w-full min-w-0 flex-col">
        <header className="min-w-0 shrink-0 px-6 pb-4 pt-5">
          <h2 className="flex min-w-0 items-center gap-2 text-c-xl font-semibold text-foreground">
            <span className="min-w-0 truncate">{name}</span>
            <span className="shrink-0 text-c-md font-normal text-muted-foreground">{kind}</span>
            {badge}
          </h2>
          {description && (
            <p className="mt-1 line-clamp-2 text-c-md text-muted-foreground">{description}</p>
          )}
          <p className="mt-2 truncate font-mono text-c-xs text-muted-foreground" title={filePath}>
            {filePath}
          </p>
        </header>

        {/* Focusable, and the first tabbable thing in the dialog, so Radix's
            open-focus lands here rather than on Delete — which is both
            destructive and, being leftmost in the footer, first in the DOM. */}
        <div
          tabIndex={0}
          className="scroll-auto-hide mx-6 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-border/55 bg-black/[0.06] px-4 py-3 outline-hidden dark:bg-black/25">
          {body === null ? (
            <p className="text-c-md text-muted-foreground">Loading…</p>
          ) : (
            <MarkdownRenderer>{body}</MarkdownRenderer>
          )}
        </div>

        <footer className="flex min-w-0 shrink-0 items-center justify-between gap-3 px-6 py-4">
          {onDelete ? (
            confirming ? (
              <span className="flex items-center gap-2 text-c-md">
                <span className="text-muted-foreground">Delete this {kind.toLowerCase()}?</span>
                <button
                  type="button"
                  onClick={async () => {
                    await onDelete()
                    onClose()
                  }}
                  className="rounded-md bg-danger/15 px-2 py-1 font-medium text-danger transition-colors hover:bg-danger/25"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-md px-2 py-1 text-c-md font-medium text-danger transition-colors hover:bg-danger/15"
              >
                Delete
              </button>
            )
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1.5">{actions}</span>
        </footer>
      </div>
    </Modal>
  )
}

/** The quiet button in a dialog footer. */
export function DialogAction({
  onClick,
  primary,
  children
}: {
  onClick: () => void
  primary?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? 'rounded-md bg-info/90 px-3 py-1.5 text-c-md font-medium text-info-foreground transition-colors hover:bg-info'
          : 'rounded-md border border-border bg-muted/40 px-3 py-1.5 text-c-md font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground'
      }
    >
      {children}
    </button>
  )
}

/**
 * The global set, plus one project's set per project you have.
 *
 * `skills_list` and `commands_list` each answer for one cwd, so the tabs mean one
 * call per project. That is a handful of directory reads at open, and it beats
 * the alternative of a backend command that takes a list of paths for the sake
 * of a view that changes as often as the sidebar does.
 */
export function useScopedLibrary<T>(
  list: (cwd: string) => Promise<ScopedList<T>>,
  changeEvent?: string
): {
  global: T[]
  byProject: Record<string, T[]>
  projects: { id: string; name: string; path: string }[]
  activeId: string | null
  setActiveId: (id: string) => void
  reload: () => void
} {
  const projects = useSessionsStore((s) => s.projects)
  const activeCwd = useSessionsStore(activeProjectCwd)
  const [data, setData] = useState<{ global: T[]; byProject: Record<string, T[]> }>({
    global: [],
    byProject: {}
  })
  const [activeId, setActiveId] = useState<string | null>(null)

  const sorted = useMemo(
    () => [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [projects]
  )

  const reload = useCallback(() => {
    let live = true
    const run = async (): Promise<void> => {
      const byProject: Record<string, T[]> = {}
      const results = await Promise.all(sorted.map((p) => list(p.path)))
      sorted.forEach((p, i) => {
        byProject[p.id] = results[i].project
      })
      // Global is the same answer whichever cwd asks, so the first call already
      // has it; with no projects at all there is nothing to piggyback on.
      const globals = results[0]?.global ?? (await list(activeCwd || homedir())).global
      if (live) setData({ global: globals, byProject })
    }
    void run()
    return () => {
      live = false
    }
  }, [sorted, list, activeCwd])

  useEffect(() => reload(), [reload])

  useEffect(() => {
    if (!changeEvent) return
    const onChange = (): void => void reload()
    window.addEventListener(changeEvent, onChange)
    return () => window.removeEventListener(changeEvent, onChange)
  }, [changeEvent, reload])

  // The project you are working in is the one you mean, until you say otherwise.
  useEffect(() => {
    if (activeId && sorted.some((p) => p.id === activeId)) return
    const current = sorted.find((p) => p.path === activeCwd)
    setActiveId(current?.id ?? sorted[0]?.id ?? null)
  }, [activeCwd, sorted, activeId])

  return {
    global: data.global,
    byProject: data.byProject,
    projects: sorted,
    activeId,
    setActiveId,
    reload
  }
}
