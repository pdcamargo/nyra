import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Component as ComponentIcon,
  Frame,
  LayoutTemplate,
  Monitor,
  PanelLeft,
  Search,
  type LucideIcon
} from 'lucide-react'
import { hasIcon, lookupToken, themeFor, type FontBundle, type Theme } from '@nyra/design'
import NamedIcon from './NamedIcon'
import { cn } from 'cn'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import MarkdownRenderer from '../MarkdownRenderer'
import ScaledArtboard from './ScaledArtboard'
import {
  compileContextFor,
  semanticContrast,
  systemFileText,
  usedIn,
  type ContrastRow,
  type Guideline,
  type LoadedSystem,
  type OutlineFile,
  type SystemIcon
} from '../../lib/designSystem'
import { compileOffThread, type CompileOutcome } from '../../lib/designCompile'

/** Below this the nav folds into a picker at the top of the page. */
const NARROW = 720

type NavItem = { id: string; label: string; status?: 'ready' | 'draft'; search: string }
type NavGroup = {
  title: string
  count?: number
  items: NavItem[]
  groups?: { title: string; items: NavItem[] }[]
  /** Folds to a single row while its page is not the one shown. */
  foldable?: boolean
}

const FOUNDATIONS = [
  { id: 'color', label: 'Color' },
  { id: 'typography', label: 'Typography' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'radius', label: 'Radius' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'borders', label: 'Borders' },
  { id: 'icons', label: 'Icons' }
] as const
type FoundationId = (typeof FOUNDATIONS)[number]['id']
const FOUNDATION_IDS = new Set<string>(FOUNDATIONS.map((f) => f.id))

export const fileSection = (rel: string): string => `file:${rel}`
export const guideSection = (rel: string): string => `guide:${rel}`

function navOf(sys: LoadedSystem): NavGroup[] {
  const item = (f: OutlineFile): NavItem => ({
    id: fileSection(f.rel),
    label: f.name,
    status: f.meta?.status,
    search: [f.name, f.rel, ...f.components.map((c) => c.name)].join(' ').toLowerCase()
  })
  const out: NavGroup[] = []
  if (sys.tokens.parsed) {
    out.push({
      title: 'Foundations',
      count: FOUNDATIONS.length,
      foldable: true,
      items: FOUNDATIONS.map((f) => ({ ...f, search: f.label.toLowerCase() }))
    })
  }
  const components = sys.files.filter((f) => f.kind === 'component')
  if (components.length) {
    const byGroup = new Map<string, NavItem[]>()
    for (const f of components) {
      const g = f.meta?.group ?? 'Components'
      byGroup.set(g, [...(byGroup.get(g) ?? []), item(f)])
    }
    const count = components.reduce((n, f) => n + Math.max(1, f.components.length), 0)
    // Nothing grouped: "Components" inside "Components" says nothing twice.
    if (byGroup.size === 1 && byGroup.has('Components')) {
      out.push({ title: 'Components', count, items: byGroup.get('Components') ?? [] })
    } else {
      out.push({ title: 'Components', count, items: [], groups: [...byGroup].map(([title, items]) => ({ title, items })) })
    }
  }
  for (const [kind, title] of [
    ['pattern', 'Patterns'],
    ['screen', 'Screens']
  ] as const) {
    const files = sys.files.filter((f) => f.kind === kind)
    if (files.length) out.push({ title, count: files.length, items: files.map(item) })
  }
  if (sys.guidelines.length) {
    out.push({
      title: 'Guidelines',
      items: sys.guidelines.map((g) => ({ id: guideSection(g.rel), label: g.title, search: g.title.toLowerCase() }))
    })
  }
  return out
}

/** One file, one page: what the right side shows for a section id. */
type Page =
  | { kind: 'foundations' }
  | { kind: 'file'; file: OutlineFile }
  | { kind: 'guide'; guide: Guideline }
  | { kind: 'none' }

function pageOf(sys: LoadedSystem, id: string | null): Page {
  if (id && FOUNDATION_IDS.has(id) && sys.tokens.parsed) return { kind: 'foundations' }
  if (id?.startsWith('file:')) {
    const file = sys.files.find((f) => fileSection(f.rel) === id)
    if (file) return { kind: 'file', file }
  }
  if (id?.startsWith('guide:')) {
    const guide = sys.guidelines.find((g) => guideSection(g.rel) === id)
    if (guide) return { kind: 'guide', guide }
  }
  // Nothing remembered, or what was is gone: the first page in the nav.
  if (sys.tokens.parsed) return { kind: 'foundations' }
  if (sys.files[0]) return { kind: 'file', file: sys.files[0] }
  if (sys.guidelines[0]) return { kind: 'guide', guide: sys.guidelines[0] }
  return { kind: 'none' }
}

/** The element sections observe against: the page, not the window. */
const ScrollRoot = createContext<HTMLElement | null>(null)

/**
 * A section that draws only once it nears the viewport, at a reserved height
 * until then — so a long page opens at once and fills in as it is scrolled.
 * Once drawn it stays drawn.
 */
function Lazy({
  estimate,
  head,
  children
}: {
  estimate: number
  /** Shown above the placeholder until the section draws. */
  head?: React.ReactNode
  children: () => React.ReactNode
}): React.ReactElement {
  const root = useContext(ScrollRoot)
  const ref = useRef<HTMLDivElement | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen || !ref.current) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true)
      },
      { root, rootMargin: '800px 0px' }
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [root, seen])
  if (seen) return <>{children()}</>
  return (
    <div ref={ref} style={{ minHeight: estimate }}>
      {head}
      <Placeholder />
    </div>
  )
}

function Placeholder(): React.ReactElement {
  return (
    <div aria-hidden className="flex flex-col gap-3 rounded-[8px] bg-muted p-4">
      <div className="h-3.5 w-[55%] rounded-[4px] bg-border" />
      <div className="h-2.5 w-[80%] rounded-[4px] bg-border" />
      <div className="h-2.5 w-[70%] rounded-[4px] bg-border" />
    </div>
  )
}

export default function SystemOverview({
  sys,
  mode,
  section,
  onSection,
  onOpenFile
}: {
  sys: LoadedSystem
  mode: string | undefined
  section: string | null
  onSection: (id: string) => void
  onOpenFile: (rel: string, artboard?: string) => void
}): React.ReactElement {
  const nav = useMemo(() => navOf(sys), [sys])
  const [filter, setFilter] = useState('')
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const outer = useRef<HTMLDivElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // The section shown, and every navigation to it as its own event: picking
  // the page already shown still scrolls back to its top.
  const [current, setCurrent] = useState<string | null>(section)
  const [jump, setJump] = useState<{ id: string | null; n: number }>({ id: section, n: 0 })
  // The section last received from the tab or sent to it, so the tab echoing
  // our own change back is not taken for a new navigation.
  const lastSection = useRef(section)

  useEffect(() => {
    const node = outer.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const go = useCallback(
    (id: string) => {
      lastSection.current = id
      setCurrent(id)
      setJump((j) => ({ id, n: j.n + 1 }))
      setPickerOpen(false)
      onSection(id)
    },
    [onSection]
  )

  // A section set from outside — Claude opening the system at a page.
  useEffect(() => {
    if (!section || section === lastSection.current) return
    lastSection.current = section
    setCurrent(section)
    setJump((j) => ({ id: section, n: j.n + 1 }))
  }, [section])

  const page = useMemo(() => pageOf(sys, current), [sys, current])
  const onFoundations = page.kind === 'foundations'

  // A jump to a foundation section is held there for a moment: the sections
  // above it draw as they near the viewport and change height, which would
  // otherwise slide the target away. Any scroll of the user's own lets go.
  const pinned = useRef<{ id: string; until: number } | null>(null)
  const scrollToSection = useCallback(
    (id: string): boolean => {
      const el = scroller?.querySelector(`[data-section="${id}"]`)
      el?.scrollIntoView({ block: 'start' })
      return !!el
    },
    [scroller]
  )

  // Land on the section asked for — on open, from the nav, from a chip — once
  // its page is in the DOM. A new page starts at its top.
  const handled = useRef(-1)
  useLayoutEffect(() => {
    if (!scroller || handled.current === jump.n) return
    handled.current = jump.n
    const id = jump.id
    if (onFoundations && id && FOUNDATION_IDS.has(id) && id !== FOUNDATIONS[0].id && scrollToSection(id)) {
      pinned.current = { id, until: performance.now() + 1500 }
    } else {
      pinned.current = null
      scroller.scrollTop = 0
    }
  }, [scroller, jump, onFoundations, scrollToSection])

  useEffect(() => {
    const node = content.current
    if (!scroller || !node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const pin = pinned.current
      if (!pin) return
      if (performance.now() > pin.until) pinned.current = null
      else scrollToSection(pin.id)
    })
    ro.observe(node)
    const unpin = (): void => {
      pinned.current = null
    }
    scroller.addEventListener('wheel', unpin, { passive: true })
    scroller.addEventListener('pointerdown', unpin)
    scroller.addEventListener('keydown', unpin)
    return () => {
      ro.disconnect()
      scroller.removeEventListener('wheel', unpin)
      scroller.removeEventListener('pointerdown', unpin)
      scroller.removeEventListener('keydown', unpin)
    }
  }, [scroller, scrollToSection])

  // On the Foundations page, which section is on screen, for the nav highlight
  // and for the tab to remember: the topmost one whose heading has passed the
  // top third.
  useEffect(() => {
    if (!scroller || !onFoundations) return
    const onScroll = (): void => {
      if (pinned.current && performance.now() <= pinned.current.until) return
      const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
      const sections = [...scroller.querySelectorAll<HTMLElement>('[data-section]')]
      let at: string | null = null
      for (const el of sections) {
        if (el.getBoundingClientRect().top <= top) at = el.dataset.section ?? null
      }
      // At the very bottom the last sections can never reach the top third;
      // the one in view then is the last one.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        at = sections.at(-1)?.dataset.section ?? at
      }
      if (at && at !== lastSection.current) {
        lastSection.current = at
        setCurrent(at)
        onSection(at)
      }
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller, onFoundations, onSection])

  const narrow = width > 0 && width < NARROW
  const active =
    page.kind === 'foundations'
      ? current && FOUNDATION_IDS.has(current)
        ? current
        : FOUNDATIONS[0].id
      : page.kind === 'file'
        ? fileSection(page.file.rel)
        : page.kind === 'guide'
          ? guideSection(page.guide.rel)
          : null
  const activeGroup = nav.find((g) => [...g.items, ...(g.groups ?? []).flatMap((x) => x.items)].some((i) => i.id === active))
  const activeLabel = activeGroup && [...activeGroup.items, ...(activeGroup.groups ?? []).flatMap((x) => x.items)].find((i) => i.id === active)?.label

  const empty = sys.files.length === 0 && !sys.tokens.parsed && sys.guidelines.length === 0

  const navPanel = (className: string): React.ReactElement => (
    <NavPanel
      nav={nav}
      filter={filter}
      onFilter={setFilter}
      active={active}
      foundationsOpen={onFoundations}
      onPick={go}
      className={className}
    />
  )

  return (
    <div ref={outer} className={cn('flex min-h-0 flex-1', narrow && 'flex-col')}>
      {!narrow && navPanel('w-[212px] shrink-0 overflow-y-auto border-r bg-sidebar')}
      {narrow && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-sidebar px-3 py-2">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 rounded-[4px] border bg-background px-2 py-1 text-[12.5px] leading-[1.5]"
              >
                <PanelLeft className="size-[13px] shrink-0 text-muted-foreground" />
                {activeGroup && activeLabel !== undefined && (
                  <>
                    <span className="shrink-0 text-muted-foreground">{activeGroup.title}</span>
                    <span className="shrink-0 text-muted-foreground">/</span>
                  </>
                )}
                <span className="min-w-0 truncate font-[550]">{activeLabel ?? 'Sections'}</span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="max-h-[min(480px,var(--radix-popover-content-available-height))] w-[260px] gap-0 overflow-y-auto bg-sidebar p-0"
            >
              {navPanel('')}
            </PopoverContent>
          </Popover>
          <span className="flex-1" />
          <IconButton
            label="Filter the system"
            onClick={() => setPickerOpen(true)}
            className="flex size-[26px] items-center justify-center rounded-[4px]"
          >
            <Search className="size-3.5" />
          </IconButton>
        </div>
      )}
      <ScrollRoot.Provider value={scroller}>
        <div ref={setScroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div ref={content} className={cn('flex flex-col', narrow ? 'px-5 pt-5 pb-6' : 'px-8 pt-6 pb-8')}>
            {empty ? (
              <EmptySystem name={sys.manifest.name} />
            ) : (
              <>
                {sys.tokens.issues.length > 0 && (
                  <div className="mb-4 rounded-[8px] border border-danger/40 bg-danger/5 p-3 text-[12.5px] leading-[1.5]">
                    <p className="font-[550] text-danger">tokens.json does not load</p>
                    <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                      {sys.tokens.issues.slice(0, 6).map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {page.kind === 'foundations' && <FoundationsPage sys={sys} mode={mode} narrow={narrow} />}
                {page.kind === 'file' && (
                  <FilePage
                    key={page.file.rel}
                    sys={sys}
                    file={page.file}
                    mode={mode}
                    narrow={narrow}
                    onOpenFile={onOpenFile}
                    onJump={go}
                  />
                )}
                {page.kind === 'guide' && <GuidePage key={page.guide.rel} guide={page.guide} narrow={narrow} />}
              </>
            )}
          </div>
        </div>
      </ScrollRoot.Provider>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The nav
// ---------------------------------------------------------------------------

function NavPanel({
  nav,
  filter,
  onFilter,
  active,
  foundationsOpen,
  onPick,
  className
}: {
  nav: NavGroup[]
  filter: string
  onFilter: (v: string) => void
  active: string | null
  /** The Foundations page is shown, so its group lists its sections. */
  foundationsOpen: boolean
  onPick: (id: string) => void
  className: string
}): React.ReactElement {
  const q = filter.trim().toLowerCase()
  return (
    <nav aria-label="Design system" className={cn('flex flex-col px-2 py-3 text-[12.5px] leading-[1.5]', className)}>
      <label className="flex items-center gap-2 rounded-[4px] border bg-background px-2 py-1">
        <Search className="size-[13px] shrink-0 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Filter"
          aria-label="Filter the system"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </label>
      {nav.map((g) => (
        <NavSection
          key={g.title}
          group={g}
          filter={q}
          active={active}
          folded={!!g.foldable && !foundationsOpen}
          onPick={onPick}
        />
      ))}
    </nav>
  )
}

function NavSection({
  group,
  filter,
  active,
  folded,
  onPick
}: {
  group: NavGroup
  filter: string
  active: string | null
  folded: boolean
  onPick: (id: string) => void
}): React.ReactElement | null {
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [unfolded, setUnfolded] = useState(false)
  const match = (i: NavItem): boolean => !filter || i.search.includes(filter)
  const items = group.items.filter(match)
  const groups = (group.groups ?? []).map((g) => ({ ...g, items: g.items.filter(match) })).filter((g) => g.items.length)
  if (!items.length && !groups.length) return null

  if (folded) {
    const open = filter.length > 0 || unfolded
    return (
      <div className="pt-2">
        <GroupRow title={group.title} count={items.length} open={open} onToggle={() => setUnfolded(!open)} />
        {open && items.map((i) => <NavRow key={i.id} item={i} active={active === i.id} onPick={onPick} indent />)}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between px-3 pt-4 pb-1 text-[11.5px] leading-[1.4] font-medium text-muted-foreground">
        <span className="tracking-[0.6px] uppercase">{group.title}</span>
        {group.count !== undefined && <span className="tabular-nums">{group.count}</span>}
      </div>
      {items.map((i) => (
        <NavRow key={i.id} item={i} active={active === i.id} onPick={onPick} />
      ))}
      {groups.map((g) => {
        // Collapsed by default once there are several, unless the filter or the
        // page shown is inside it.
        const open = filter.length > 0 || g.items.some((i) => i.id === active) || !(closed[g.title] ?? groups.length > 2)
        return (
          <div key={g.title}>
            <GroupRow
              title={g.title}
              count={g.items.length}
              open={open}
              onToggle={() => setClosed((c) => ({ ...c, [g.title]: open }))}
            />
            {open && g.items.map((i) => <NavRow key={i.id} item={i} active={active === i.id} onPick={onPick} indent />)}
          </div>
        )
      })}
    </div>
  )
}

function GroupRow({
  title,
  count,
  open,
  onToggle
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1 rounded-[4px] px-3 py-1 text-left hover:bg-foreground/5"
    >
      {open ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className={cn('min-w-0 flex-1 truncate', open && 'font-[550]')}>{title}</span>
      <span className="text-[11.5px] font-medium text-muted-foreground tabular-nums">{count}</span>
    </button>
  )
}

function NavRow({
  item,
  active,
  indent,
  onPick
}: {
  item: NavItem
  active: boolean
  indent?: boolean
  onPick: (id: string) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onPick(item.id)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-[4px] py-1 pr-3 text-left',
        indent ? 'pl-7' : 'pl-3',
        active ? 'bg-design-accent/10 font-[550] text-design-accent' : 'hover:bg-foreground/5'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.status && (
        <span
          className={cn('size-1.5 shrink-0 rounded-full', item.status === 'ready' ? 'bg-success' : 'bg-warning')}
          aria-label={item.status === 'ready' ? 'Ready' : 'Draft'}
        />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

function EmptySystem({ name }: { name: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <Frame className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">Nothing in {name} yet</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Ask Claude to set up its foundations and components — it will ask a few questions first.
      </p>
    </div>
  )
}

function PageHeader({
  crumb,
  title,
  narrow,
  lead,
  status,
  action,
  tags
}: {
  crumb: string[]
  title: string
  narrow: boolean
  lead?: string
  /** Beside the title: the Ready / Draft tag. */
  status?: React.ReactNode
  /** At the far end of the title row. */
  action?: React.ReactNode
  tags?: React.ReactNode
}): React.ReactElement {
  return (
    <header>
      {!narrow && crumb.length > 0 && (
        <div className="flex items-center gap-1 text-[12.5px] leading-[1.5]">
          {crumb.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
              <span className={i === crumb.length - 1 ? 'text-foreground' : 'text-muted-foreground'}>{c}</span>
            </Fragment>
          ))}
        </div>
      )}
      <div className={cn('flex items-center gap-3', narrow ? 'pb-2' : 'py-2')}>
        <h1
          className={cn(
            'min-w-0 break-words',
            narrow
              ? 'text-[22px] leading-[1.25] font-[620] tracking-[-0.2px]'
              : 'text-[28px] leading-[1.2] font-[650] tracking-[-0.3px]'
          )}
        >
          {title}
        </h1>
        {status}
        {action && (
          <>
            <span className="flex-1" />
            {action}
          </>
        )}
      </div>
      {lead && (
        <p
          className={cn(
            'max-w-[560px] text-muted-foreground',
            narrow ? 'text-[12.5px] leading-[1.5]' : 'text-[14px] leading-[1.55]'
          )}
        >
          {lead}
        </p>
      )}
      {tags && <div className="flex flex-wrap gap-2 pt-4">{tags}</div>}
    </header>
  )
}

function SubHead({ title, hint, className }: { title: string; hint?: string; className?: string }): React.ReactElement {
  return (
    <div className={cn('flex flex-col gap-0.5 pt-8 pb-3', className)}>
      <h2 className="text-[15px] leading-[1.35] font-semibold">{title}</h2>
      {hint && <p className="text-[12.5px] leading-[1.5] text-muted-foreground">{hint}</p>}
    </div>
  )
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'

const TONES: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
  accent: 'bg-design-accent/10 text-design-accent'
}

function Tag({ tone = 'neutral', mono, children }: { tone?: Tone; mono?: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-px text-[11.5px]',
        mono ? 'font-mono leading-[1.45]' : 'leading-[1.4] font-medium',
        TONES[tone]
      )}
    >
      {children}
    </span>
  )
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function resolveIn(theme: Theme, path: string): string | undefined {
  try {
    const v = lookupToken(theme, path)
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Foundations — generated from tokens.json, never hand-written pages
// ---------------------------------------------------------------------------

function FoundationsPage({ sys, mode, narrow }: { sys: LoadedSystem; mode: string | undefined; narrow: boolean }): React.ReactElement {
  const tokens = sys.tokens.parsed!
  const theme = useMemo(() => themeFor(tokens, mode, sys.manifest.name), [tokens, mode, sys.manifest.name])
  const rows = useMemo(() => semanticContrast(tokens, mode), [tokens, mode])
  const resolve = useCallback((path: string) => resolveIn(theme, path), [theme])
  const ramps = Object.values(theme.color).filter((v) => typeof v === 'object' && v !== null).length

  // What a section is held at until it draws, so the page scrolls true.
  const estimate: Record<FoundationId, number> = {
    color: 280 + rows.length * 45 + ramps * 92,
    typography: 300 + Object.keys(theme.font).length * 62,
    spacing: 200 + Object.keys(theme.space).length * 24,
    radius: 300,
    elevation: 340,
    borders: 300,
    icons: 220 + Math.ceil(sys.icons.length / 6) * 86
  }
  const body = (id: FoundationId): React.ReactNode => {
    switch (id) {
      case 'color':
        return <ColorSection theme={theme} rows={rows} narrow={narrow} />
      case 'typography':
        return <TypographySection sys={sys} theme={theme} mode={mode} narrow={narrow} resolve={resolve} />
      case 'spacing':
        return <SpacingSection theme={theme} narrow={narrow} resolve={resolve} />
      case 'radius':
        return <RadiusSection theme={theme} narrow={narrow} resolve={resolve} />
      case 'elevation':
        return <ElevationSection theme={theme} narrow={narrow} resolve={resolve} />
      case 'borders':
        return <BordersSection theme={theme} narrow={narrow} resolve={resolve} />
      case 'icons':
        return <IconsSection icons={sys.icons} narrow={narrow} />
    }
  }
  return (
    <>
      {FOUNDATIONS.map((f, i) => (
        <section
          key={f.id}
          data-section={f.id}
          className={cn(i > 0 && (narrow ? 'mt-6 border-t pt-5' : 'mt-8 border-t pt-6'))}
        >
          <Lazy estimate={estimate[f.id]} head={<SubHead title={f.label} className="pt-0" />}>
            {() => body(f.id)}
          </Lazy>
        </section>
      ))}
    </>
  )
}

const GRADE: Record<NonNullable<ContrastRow['grade']>, { tone: Tone; label: string; short: string }> = {
  AAA: { tone: 'success', label: 'AAA', short: 'AAA' },
  AA: { tone: 'success', label: 'AA', short: 'AA' },
  large: { tone: 'warning', label: 'Large text only', short: 'Large only' },
  none: { tone: 'neutral', label: 'Not for text', short: 'Not for text' }
}

function ColorSection({ theme, rows, narrow }: { theme: Theme; rows: ContrastRow[]; narrow: boolean }): React.ReactElement {
  const ramps = Object.entries(theme.color).filter(([, v]) => typeof v === 'object' && v !== null) as [string, Record<string, unknown>][]
  const failing = rows.filter((r) => r.grade === 'large').length
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Color']}
        title="Color"
        narrow={narrow}
        lead="Every colour a design uses is an alias pointing at a ramp step. Change the step and every alias that points at it follows."
        tags={
          <>
            <Tag mono>tokens.json</Tag>
            <Tag>{plural(ramps.length, 'ramp')}</Tag>
            <Tag>{plural(rows.length, 'alias', 'aliases')}</Tag>
            {failing > 0 && <Tag tone="warning">{failing} below AA for text</Tag>}
          </>
        }
      />
      <SubHead title="Semantic" hint="What designs reach for. Contrast is measured against the surface." />
      <div className="overflow-hidden rounded-[8px] border">
        {rows.map((r, i) => (
          <div key={r.token} className={cn('flex items-center gap-3 px-3 py-2', i > 0 && 'border-t')}>
            <span className="size-7 shrink-0 rounded-[4px] border" style={{ background: r.hex ?? 'transparent' }} />
            <div className="flex w-[168px] min-w-0 shrink-0 flex-col">
              <code className="truncate font-mono text-[12.5px] leading-[1.5] text-foreground">{r.token}</code>
              {r.ref && <code className="truncate font-mono text-[11.5px] leading-[1.45] text-muted-foreground">→ {r.ref}</code>}
            </div>
            {narrow ? (
              <span className="flex-1" />
            ) : (
              <code className="flex-1 font-mono text-[11.5px] leading-[1.45] text-muted-foreground">{r.hex ?? ''}</code>
            )}
            {r.grade && r.ratio !== null && (
              <Tag tone={GRADE[r.grade].tone}>
                {narrow ? GRADE[r.grade].short : GRADE[r.grade].label} · {r.ratio.toFixed(1)}
              </Tag>
            )}
          </div>
        ))}
      </div>
      {ramps.length > 0 && (
        <>
          <SubHead title="Ramps" hint="The raw steps. A design uses one directly only when no alias fits." />
          <div className="flex flex-col gap-4">
            {ramps.map(([name, steps]) => (
              <div key={name} className="flex gap-3">
                <code className="w-14 shrink-0 pt-2 font-mono text-[12.5px] leading-[1.5]">{name}</code>
                <div className="grid flex-1 gap-1" style={{ gridTemplateColumns: 'repeat(11, minmax(0, 1fr))' }}>
                  {Object.keys(steps).map((step) => (
                    <div key={step} className="flex min-w-0 flex-col gap-1">
                      <span className="h-9 rounded-[4px] border" style={{ background: resolveIn(theme, `$color.${name}.${step}`) }} />
                      <code className="truncate font-mono text-[11.5px] leading-[1.45] text-muted-foreground">{step}</code>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function TypographySection({
  sys,
  theme,
  mode,
  narrow,
  resolve
}: {
  sys: LoadedSystem
  theme: Theme
  mode: string | undefined
  narrow: boolean
  resolve: (path: string) => string | undefined
}): React.ReactElement {
  const fonts = Object.entries(theme.font)
  const families = new Set(fonts.map(([, b]) => b.family)).size
  const base = sys.tokens.parsed!.baseMode
  const shown = mode ?? base
  const modal = sys.tokens.modes.length > 1
  // Drawn on the system's own surface, in its own ink — what a design gets.
  const canvas = { background: resolve('$color.bg') ?? resolve('$color.surface') ?? '#fff', color: resolve('$color.text') ?? '#111' }
  const meta = resolve('$color.textMuted') ?? resolve('$color.textSubtle')
  const rule = resolve('$color.border')
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Typography']}
        title="Typography"
        narrow={narrow}
        lead="A style is a bundle: family, size, weight, line height and tracking travel together, so a heading can't drift away from its own scale."
        tags={
          <>
            <Tag>{plural(fonts.length, 'style')}</Tag>
            <Tag>{plural(families, 'family', 'families')}</Tag>
            {modal &&
              (shown === base ? (
                <Tag>{shown} (base)</Tag>
              ) : (
                <Tag tone="accent" mono>
                  modes.{shown}
                </Tag>
              ))}
          </>
        }
      />
      <SubHead
        title="Scale"
        hint={
          modal
            ? `Drawn in the system's ${shown} mode. The panel around it stays in Nyra's theme.`
            : "Drawn in the system's own tokens. The panel around it stays in Nyra's theme."
        }
      />
      <div className="overflow-hidden rounded-[8px]" style={canvas}>
        {fonts.map(([name, b], i) => (
          <TypeRow key={name} name={name} bundle={b} meta={meta} rule={i > 0 ? (rule ?? 'transparent') : undefined} />
        ))}
      </div>
    </>
  )
}

function TypeRow({
  name,
  bundle,
  meta,
  rule
}: {
  name: string
  bundle: FontBundle
  /** The system's muted ink, for the numbers under the name. */
  meta: string | undefined
  /** The divider above this row, in the system's border colour. */
  rule: string | undefined
}): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-4 px-4 py-3', rule && 'border-t')} style={rule ? { borderColor: rule } : undefined}>
      <div className="flex w-[132px] shrink-0 flex-col">
        <code className="font-mono text-[12.5px] leading-[1.5]">{name}</code>
        <code className="font-mono text-[11.5px] leading-[1.45]" style={{ color: meta }}>
          {bundle.size} · {bundle.weight} · {bundle.lineHeight}
        </code>
      </div>
      <p
        className="min-w-0 flex-1 truncate"
        style={{
          fontFamily: bundle.family,
          fontSize: bundle.size,
          fontWeight: bundle.weight,
          lineHeight: bundle.lineHeight,
          letterSpacing: bundle.letterSpacing
        }}
      >
        The quick brown fox jumps over the lazy dog
      </p>
    </div>
  )
}

type FoundationProps = { theme: Theme; narrow: boolean; resolve: (path: string) => string | undefined }

function SpacingSection({ theme, narrow, resolve }: FoundationProps): React.ReactElement {
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Spacing']}
        title="Spacing"
        narrow={narrow}
        lead="Every gap and inset in a design is one of these steps."
      />
      <div className="flex flex-col gap-1.5 pt-6">
        {Object.entries(theme.space)
          .sort((a, b) => a[1] - b[1])
          .map(([name, v]) => (
            <div key={name} className="flex items-center gap-3">
              <code className="w-24 shrink-0 font-mono text-[12.5px] leading-[1.5]">space.{name}</code>
              <span className="w-12 shrink-0 text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">{v}px</span>
              <span className="h-3 rounded-[2px]" style={{ width: Math.min(400, v * 2), background: resolve('$color.accent') ?? 'currentColor' }} />
            </div>
          ))}
      </div>
    </>
  )
}

function RadiusSection({ theme, narrow, resolve }: FoundationProps): React.ReactElement {
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Radius']}
        title="Radius"
        narrow={narrow}
        lead="How round a corner is, from square to a full pill."
      />
      <div className="flex flex-wrap gap-4 pt-6">
        {Object.entries(theme.radius).map(([name, v]) => (
          <div key={name} className="flex flex-col items-center gap-1.5">
            <div className="size-14 border-2" style={{ borderRadius: Math.min(v, 28), borderColor: resolve('$color.accent') ?? 'currentColor' }} />
            <code className="font-mono text-[12.5px] leading-[1.5]">{name}</code>
            <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">{v >= 999 ? 'full' : `${v}px`}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function ElevationSection({ theme, narrow, resolve }: FoundationProps): React.ReactElement {
  const background = resolve('$color.bg') ?? resolve('$color.surface') ?? '#fff'
  const ink = resolve('$color.text') ?? '#111'
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Elevation']}
        title="Elevation"
        narrow={narrow}
        lead="The shadows a surface can lift with, drawn on the system's own background."
      />
      <div className="mt-6 flex flex-wrap gap-5 rounded-[8px] p-5" style={{ background }}>
        {Object.entries(theme.shadow).map(([name, v]) => (
          <div key={name} className="flex flex-col items-center gap-2" style={{ color: ink }}>
            <div className="h-14 w-24 rounded-[8px]" style={{ boxShadow: v, background: resolve('$color.surface') ?? '#fff' }} />
            <code className="font-mono text-[12.5px] leading-[1.5]">{name}</code>
          </div>
        ))}
      </div>
    </>
  )
}

function BordersSection({ theme, narrow, resolve }: FoundationProps): React.ReactElement {
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Borders']}
        title="Borders"
        narrow={narrow}
        lead="A border is a bundle too: width, style and colour travel together."
      />
      <div className="flex flex-wrap gap-4 pt-6">
        {Object.entries(theme.border).map(([name, b]) => (
          <div key={name} className="flex flex-col items-center gap-1.5">
            <div className="h-12 w-20 rounded-[4px]" style={{ border: `${b.width}px ${b.style} ${resolve(b.color) ?? b.color}` }} />
            <code className="font-mono text-[12.5px] leading-[1.5]">{name}</code>
          </div>
        ))}
      </div>
    </>
  )
}

function IconsSection({ icons, narrow }: { icons: SystemIcon[]; narrow: boolean }): React.ReactElement {
  const missing = icons.filter((i) => !hasIcon(i.name)).length
  return (
    <>
      <PageHeader
        crumb={['Foundations', 'Icons']}
        title="Icons"
        narrow={narrow}
        lead="Every icon the system's files draw, found by reading them. Icons are lucide's, by name."
        tags={
          icons.length > 0 ? (
            <>
              <Tag>{plural(icons.length, 'icon')}</Tag>
              {missing > 0 && <Tag tone="danger">{missing} not in lucide</Tag>}
            </>
          ) : undefined
        }
      />
      {icons.length === 0 ? (
        <div className="mt-6 rounded-[8px] bg-muted px-4 py-6 text-center text-[12.5px] leading-[1.5] text-muted-foreground">
          No file in the system draws an icon yet.
        </div>
      ) : (
        <div className="grid gap-2 pt-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}>
          {icons.map((i) => (
            <IconCell key={i.name} name={i.name} />
          ))}
        </div>
      )}
    </>
  )
}

function IconCell({ name }: { name: string }): React.ReactElement {
  const glyph = hasIcon(name)
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 rounded-[8px] border px-2 py-3">
      {glyph ? (
        <NamedIcon name={name} className="size-5" />
      ) : (
        <span aria-hidden className="size-5 rounded-[4px] border border-dashed border-danger" />
      )}
      <code
        className={cn('max-w-full truncate font-mono text-[11.5px] leading-[1.45]', glyph ? 'text-muted-foreground' : 'text-danger')}
        title={name}
      >
        {name}
      </code>
    </div>
  )
}


// ---------------------------------------------------------------------------
// One file: a component family, a pattern or a screen
// ---------------------------------------------------------------------------

const KIND_CRUMB = { component: 'Components', pattern: 'Patterns', screen: 'Screens' } as const

const KIND_ICON: Record<OutlineFile['kind'], LucideIcon> = {
  component: ComponentIcon,
  pattern: LayoutTemplate,
  screen: Monitor
}

function estimateSpecimens(f: OutlineFile): number {
  return Math.max(120, f.artboards.reduce((h, a) => h + (typeof a.height === 'number' ? Math.min(a.height, 720) : 360) + 16, 0))
}

function FilePage({
  sys,
  file,
  mode,
  narrow,
  onOpenFile,
  onJump
}: {
  sys: LoadedSystem
  file: OutlineFile
  mode: string | undefined
  narrow: boolean
  onOpenFile: (rel: string, artboard?: string) => void
  onJump: (id: string) => void
}): React.ReactElement {
  const [picked, setPicked] = useState(0)
  const component = file.components[picked] ?? file.components[0]
  // "Patterns › Patterns" says nothing twice; a group that only repeats the
  // kind is left off.
  const group = file.meta?.group && file.meta.group !== KIND_CRUMB[file.kind] ? file.meta.group : null
  const crumb = [KIND_CRUMB[file.kind], group].filter((c): c is string => !!c)
  const description = file.meta?.description ?? component?.description
  const usage = file.meta?.usage
  const specimen = file.kind === 'component'
  return (
    <>
      <PageHeader
        crumb={crumb}
        title={file.name}
        narrow={narrow}
        lead={description}
        status={
          <>
            {file.meta?.status && (
              <Tag tone={file.meta.status === 'ready' ? 'success' : 'warning'}>{file.meta.status === 'ready' ? 'Ready' : 'Draft'}</Tag>
            )}
            {file.olderFormat && <Tag tone="info">Format v{file.olderFormat}</Tag>}
          </>
        }
        action={
          <Button
            variant="outline"
            onClick={() => onOpenFile(file.rel)}
            className="h-auto gap-2 rounded-[8px] border-border-strong px-3 py-1 text-[12.5px] leading-[1.5] font-[550]"
          >
            <Frame className="size-[13px] text-muted-foreground" />
            Open on canvas
          </Button>
        }
      />
      {file.error && <p className="pt-2 text-[12.5px] leading-[1.5] text-danger">This file does not parse: {file.error}</p>}

      {file.components.length > 1 && (
        <div className="mt-5 flex flex-col">
          <div className="flex items-end gap-5">
            <div role="tablist" aria-label={`${file.name} components`} className="flex items-end gap-5">
              {file.components.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  role="tab"
                  aria-selected={i === picked}
                  onClick={() => setPicked(i)}
                  className={cn(
                    'flex shrink-0 flex-col gap-2 text-[12.5px] leading-[1.5]',
                    i === picked ? 'font-[550] text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {c.name}
                  <span className={cn('h-0.5 rounded-full', i === picked ? 'bg-design-accent' : 'bg-transparent')} />
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <code className="min-w-0 truncate pb-2 font-mono text-[11.5px] leading-[1.45] text-muted-foreground" title={file.path}>
              {file.rel}
            </code>
          </div>
          <div className="h-px bg-border" />
        </div>
      )}

      {specimen ? (
        <SubHead
          title="Variants and states"
          hint={file.artboards.length > 1 ? "Drawn live from the file's specimen artboards." : "Drawn live from the file's specimen artboard."}
        />
      ) : (
        <SubHead title="Specimens" hint={file.artboards.length > 1 ? "Drawn live from the file's artboards." : "Drawn live from the file's artboard."} />
      )}
      <Lazy estimate={estimateSpecimens(file)}>
        {() => <Specimens sys={sys} file={file} mode={mode} sunken={!specimen} />}
      </Lazy>

      {component && component.props.length > 0 && (
        <>
          <SubHead title="Props" hint="Read from the component's definition, so this can't go stale." />
          <div className="overflow-hidden rounded-[8px] border">
            <div className="flex gap-3 bg-muted px-3 py-2 text-[11.5px] leading-[1.4] font-medium text-muted-foreground">
              <span className="w-[84px] shrink-0">prop</span>
              <span className="w-[176px] shrink-0">type</span>
              <span className="w-16 shrink-0">default</span>
            </div>
            {component.props.map((p) => (
              <div key={p.name} className="flex items-start gap-3 border-t px-3 py-2">
                <code className="w-[84px] shrink-0 font-mono text-[12.5px] leading-[1.5] [overflow-wrap:anywhere]">{p.name}</code>
                <code className="w-[176px] shrink-0 font-mono text-[11.5px] leading-[1.45] text-design-accent">
                  {p.type === 'enum' && p.of ? p.of.join(' · ') : p.type}
                </code>
                <code className="w-16 shrink-0 font-mono text-[11.5px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">
                  {p.type === 'slot' ? 'empty' : p.default === undefined ? '—' : String(p.default)}
                </code>
                <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-muted-foreground">{p.description ?? ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!!(usage?.do?.length || usage?.dont?.length) && (
        <>
          <SubHead title="Usage" hint="Written in the file, next to the component." />
          <div className={cn('flex gap-3', narrow && 'flex-col')}>
            {(['do', 'dont'] as const).map((k) =>
              usage?.[k]?.length ? (
                <div key={k} className="flex min-w-0 flex-auto flex-col gap-2 rounded-[8px] border p-3 text-[12.5px] leading-[1.5]">
                  <p className="flex items-center gap-2 font-[550]">
                    {k === 'do' ? <CircleCheck className="size-3.5 text-success" /> : <CircleX className="size-3.5 text-danger" />}
                    {k === 'do' ? 'Do' : "Don't"}
                  </p>
                  <ul className="flex flex-col gap-2 text-muted-foreground">
                    {usage[k]!.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
          </div>
        </>
      )}

      {component && <UsedIn sys={sys} name={component.name} onJump={onJump} />}
    </>
  )
}

const article = (name: string): string => (/^[aeiou]/i.test(name) ? 'an' : 'a')

function UsedIn({ sys, name, onJump }: { sys: LoadedSystem; name: string; onJump: (id: string) => void }): React.ReactElement | null {
  const users = useMemo(() => usedIn(sys, name), [sys, name])
  if (users.length === 0) return null
  return (
    <>
      <SubHead
        title="Used in"
        hint={`Every file in the system that draws ${article(name)} ${name}, directly or through another component.`}
      />
      <div className="flex flex-wrap gap-2">
        {users.map(({ file, count }) => {
          const Icon = KIND_ICON[file.kind]
          return (
            <button
              key={file.rel}
              type="button"
              onClick={() => onJump(fileSection(file.rel))}
              className="flex items-center gap-2 rounded-[4px] border px-2 py-1 hover:bg-accent"
            >
              <Icon className="size-[13px] shrink-0 text-muted-foreground" />
              <span className="text-[12.5px] leading-[1.5]">{file.name}</span>
              <span className="text-[11.5px] leading-[1.4] font-medium text-muted-foreground tabular-nums">{count}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/** The file's artboards, compiled with the system and drawn live. */
function Specimens({
  sys,
  file,
  mode,
  sunken
}: {
  sys: LoadedSystem
  file: OutlineFile
  mode: string | undefined
  /** A pattern or screen sits on a sunken well; a component's specimen in a frame. */
  sunken: boolean
}): React.ReactElement | null {
  const [out, setOut] = useState<CompileOutcome | null>(null)
  const [width, setWidth] = useState(640)
  const box = useRef<HTMLDivElement | null>(null)
  // Recompiled when anything in the system changes: a component edit in
  // another file can change what this one draws.
  const key = `${sys.stamp}::${mode ?? ''}`
  useEffect(() => {
    const text = systemFileText(sys.entry, file.rel)
    if (text === null) return
    let cancelled = false
    void compileOffThread(text, compileContextFor(sys, file.rel, mode)).then((r) => {
      if (!cancelled) setOut(r)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, file.rel])
  useEffect(() => {
    const node = box.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const boards = out?.ok ? out.doc.artboards : []
  // A name says which is which; with one artboard there is nothing to tell apart.
  const named = boards.length > 1
  return (
    <div ref={box} className={cn('flex flex-col gap-4', sunken && 'rounded-[8px] bg-muted p-4')}>
      {out === null ? (
        <div className={cn('h-24 animate-pulse rounded-[8px]', sunken ? 'bg-background' : 'bg-muted')} />
      ) : !out.ok ? (
        <pre className="overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive">
          {out.issues.length ? out.issues.slice(0, 6).map((i) => `${i.code}: ${i.message}`).join('\n') : out.message}
        </pre>
      ) : (
        // Fitted to the column's width only: a tall specimen capped by height
        // came out a third of the page wide, with nothing beside it. The page
        // scrolls.
        boards.map((a) => (
          <figure key={a.id} className="flex flex-col gap-2">
            {named && <figcaption className="text-[11.5px] leading-[1.4] font-medium text-muted-foreground">{a.name}</figcaption>}
            {sunken ? (
              <ScaledArtboard artboard={a} theme={out.theme} maxWidth={Math.max(200, width)} maxHeight={Infinity} />
            ) : (
              <div className="overflow-hidden rounded-[8px] border">
                <ScaledArtboard artboard={a} theme={out.theme} maxWidth={Math.max(200, width - 2)} maxHeight={Infinity} />
              </div>
            )}
          </figure>
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One guideline
// ---------------------------------------------------------------------------

function GuidePage({ guide, narrow }: { guide: Guideline; narrow: boolean }): React.ReactElement {
  // The title is the file's own `# heading`; the header already shows it.
  const body = useMemo(() => guide.text.replace(/^#\s+.+$\n*/m, ''), [guide.text])
  return (
    <>
      <PageHeader crumb={['Guidelines']} title={guide.title} narrow={narrow} />
      <Lazy estimate={240}>
        {() => (
          <div className="prose-sm max-w-none pt-4 text-sm">
            <MarkdownRenderer>{body}</MarkdownRenderer>
          </div>
        )}
      </Lazy>
    </>
  )
}
