import { useState } from 'react'
import { Check, ChevronsUpDown, Frame, FolderInput, Search, SwatchBook } from 'lucide-react'
import { cn } from 'cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { useUiStore } from '../../store/ui'
import type { DesignEntry, SystemEntry } from '../../lib/api-types'
import { homedir } from '../../lib/homedir'
import { basename, isWithin, joinPath, relativeTo, separatorOf } from '../../lib/paths'

/** `~/dev/ts/closeup/design` for a path under the home directory; anything
 *  else as it is. A label, never a path to open. */
export function tildePath(path: string, home: string = homedir()): string {
  if (!home || !isWithin(home, path)) return path
  const inside = relativeTo(home, path)
  return inside ? `~${separatorOf(path)}${inside}` : '~'
}

/**
 * Where a system lives, said briefly: `closeup/design` for one kept in its
 * repo — the project's folder and the path inside it — and the home-relative
 * folder for one kept anywhere else.
 */
export function shortRoot(system: Pick<SystemEntry, 'root' | 'project'>, home?: string): string {
  if (!isWithin(system.project, system.root)) return tildePath(system.root, home)
  const inside = relativeTo(system.project, system.root)
  const project = basename(system.project)
  return inside ? joinPath(project, inside) : project
}

/** The caption style: group labels, hints, a row's second line. */
export const CAPTION = 'text-[11.5px] font-medium leading-[1.4] tracking-[0.2px]'

/** A group's heading in a design menu. */
export const GROUP_LABEL =
  'px-2 pt-2 pb-1 text-[11.5px] font-medium leading-[1.4] tracking-[0.6px] uppercase text-muted-foreground'

/**
 * Which design the tab shows: this project's design systems and its drafts, in
 * one list. A draft is a quick single file on the built-in theme; moving it
 * into a system is Claude's job — it merges components and asks about
 * conflicts — so that row drafts the request in the composer rather than
 * moving a file behind the user's back.
 */
export function DesignPicker({
  label,
  systems,
  drafts,
  current,
  componentCounts,
  size = 'compact',
  onSystem,
  onDraft
}: {
  label: string
  systems: SystemEntry[]
  drafts: DesignEntry[]
  /** The system id or draft id on screen. */
  current: string | null
  /** Components per system id, for the systems already loaded. A system not
   *  in here is listed without a count rather than loaded to get one. */
  componentCounts?: Readonly<Record<string, number>>
  /** `title` is a system's header, where the name is the heading of the panel. */
  size?: 'compact' | 'title'
  onSystem: (id: string) => void
  onDraft: (id: string) => void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const only = systems.length === 1 ? systems[0] : null
  const q = query.trim().toLowerCase()
  const shownSystems = q
    ? systems.filter((s) => s.name.toLowerCase().includes(q) || s.root.toLowerCase().includes(q))
    : systems
  const shownDrafts = q ? drafts.filter((d) => d.name.toLowerCase().includes(q)) : drafts

  const pickFirst = (): boolean => {
    if (shownSystems[0]) onSystem(shownSystems[0].id)
    else if (shownDrafts[0]) onDraft(shownDrafts[0].id)
    else return false
    return true
  }

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery('')}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 items-center text-left hover:bg-accent',
            size === 'title' ? '-mx-1 gap-2 rounded-at-4 px-1 py-0.5' : 'gap-1 rounded-sm px-1 py-0.5'
          )}
          aria-label="Pick a design or design system"
        >
          <span
            className={cn(
              'truncate',
              size === 'title' ? 'text-[15px] leading-[1.35] font-semibold' : 'text-xs font-medium'
            )}
          >
            {label}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex w-[380px] flex-col gap-px rounded-at-12 shadow-panel">
        <div className="flex items-center gap-2 p-2">
          <Search className="size-[13px] shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The menu's typeahead would otherwise take every letter.
              e.stopPropagation()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                e.currentTarget
                  .closest('[role="menu"]')
                  ?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
                  ?.focus()
              }
              if (e.key === 'Enter' && pickFirst()) e.preventDefault()
            }}
            placeholder="Find a system or design"
            aria-label="Find a system or design"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] leading-[1.5] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <DropdownMenuSeparator className="mx-0 my-0 bg-border" />
        {shownSystems.length > 0 && (
          <>
            <DropdownMenuLabel className={GROUP_LABEL}>Design system{systems.length > 1 ? 's' : ''}</DropdownMenuLabel>
            {shownSystems.map((s) => {
              const count = componentCounts?.[s.id]
              return (
                <DropdownMenuItem key={s.id} onSelect={() => onSystem(s.id)} className={ROW}>
                  <SwatchBook className="size-[15px] text-design-accent!" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-[550] text-foreground">{s.name}</span>
                    {/* A truncated path: `title` discloses the rest. */}
                    <span className={cn(CAPTION, 'truncate text-muted-foreground!')} title={s.root}>
                      {shortRoot(s)}
                      {count !== undefined && ` · ${count} component${count === 1 ? '' : 's'}`}
                    </span>
                  </span>
                  {current === s.id && <Check className="size-3.5 text-design-accent!" />}
                </DropdownMenuItem>
              )
            })}
          </>
        )}
        {shownDrafts.length > 0 && (
          <>
            <DropdownMenuLabel className={GROUP_LABEL}>Drafts in this project</DropdownMenuLabel>
            {shownDrafts.map((d) => (
              <DropdownMenuItem key={d.id} onSelect={() => onDraft(d.id)} className={cn(ROW, 'group')}>
                <Frame className="size-[15px] text-muted-foreground!" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-[550] text-foreground" title={d.path}>
                    {d.name}
                  </span>
                  <span className={cn(CAPTION, 'truncate text-muted-foreground!')}>Single file · built-in theme</span>
                </span>
                {only && (
                  <span
                    role="button"
                    tabIndex={-1}
                    className={cn(
                      CAPTION,
                      'hidden shrink-0 items-center gap-1 rounded-at-4 border bg-background px-2 py-px text-foreground group-focus:flex group-data-[highlighted]:flex'
                    )}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      useUiStore
                        .getState()
                        .prefillInput(`Move the "${d.name}" draft into the ${only.name} design system. `)
                    }}
                  >
                    <FolderInput className="size-3 text-muted-foreground!" />
                    Move into {only.name}
                  </span>
                )}
                {current === d.id && <Check className="size-3.5 text-design-accent!" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {q && shownSystems.length === 0 && shownDrafts.length === 0 && (
          <p className={cn(CAPTION, 'p-2 text-muted-foreground')}>Nothing matches “{query.trim()}”.</p>
        )}
        <DropdownMenuSeparator className="mx-0 my-0 bg-border" />
        <p className={cn(CAPTION, 'p-2 text-muted-foreground')}>
          {systems.length > 0
            ? `A draft is a quick single file. Move it into ${only?.name ?? 'a system'} and it starts using the system's components and tokens.`
            : 'A draft is a quick single file on the built-in theme. Ask Claude for a design system to give a project its own components and tokens.'}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A two-line row. The `!` colours hold through the item's focus style, which
 * otherwise repaints every descendant in the accent foreground — the muted
 * second line and the system's accent icon included.
 */
const ROW = 'items-center gap-2 rounded-at-4 p-2 text-[12.5px] leading-[1.5]'
