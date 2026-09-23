import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  BadgeCheck,
  Boxes,
  Check,
  ExternalLink,
  Package,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2
} from 'lucide-react'
import Modal from '../Modal'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Checkbox } from '../ui/checkbox'
import { SegmentedControl, Select, TextField } from '../settings/primitives'
import { DialogAction, EmptyNote, SectionHeading } from './Library'
import { activeProjectCwd, useSessionsStore } from '../../store/sessions'
import { isSessionRunning, useRunningStore } from '../../store/running'
import type { AvailablePlugin, InstalledPlugin, PluginActionRequest } from '../../lib/api-types'
import {
  PLUGIN_SCOPES,
  PLUGIN_SORTS,
  alwaysOnTokens,
  asComponentNames,
  componentSummary,
  countOfKind,
  filterPlugins,
  formatInstalls,
  pluginName,
  sortPlugins,
  type PluginComponentNames,
  type PluginScope,
  type PluginSort
} from '../../lib/plugins'

/**
 * Claude Code's plugin marketplace, as a page.
 *
 * The whole catalog arrives in one call — 300-odd plugins with their categories,
 * component counts and install counts already resolved by Claude Code itself —
 * so the page is a filter over data it already has rather than a series of
 * round trips. Installing is the only thing that talks back.
 *
 * Three tabs, one page. Discover is the catalog; Installed is what is on this
 * machine and what state each plugin is in; Marketplaces is where the catalogs
 * themselves come from, because a plugin you cannot find is usually a
 * marketplace you have not added.
 */

type Tab = 'discover' | 'installed' | 'marketplaces'

type Notice = { tone: 'info' | 'danger' | 'success'; text: string }

/** How many cards a section shows before "Show all". */
const PREVIEW_COUNT = 9

export default function PluginsView(): React.JSX.Element {
  const cwd = useSessionsStore(activeProjectCwd)
  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  const running = useRunningStore((state) =>
    activeSessionId ? state.running[activeSessionId] === true : false
  )

  const [tab, setTab] = useState<Tab>('discover')
  const [catalog, setCatalog] = useState<
    | { installed: InstalledPlugin[]; available: AvailablePlugin[]; marketplaces: CatalogMarketplace[]; categories: CatalogCategory[] }
    | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [publicLogos, setPublicLogos] = useState<Record<string, string>>({})

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<PluginSort>('recommended')
  const [chosenCategories, setChosenCategories] = useState<string[]>([])
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})

  const [open, setOpen] = useState<AvailablePlugin | null>(null)
  const [scope, setScope] = useState<PluginScope>('user')
  const [details, setDetails] = useState<PluginComponentNames | null>(null)
  const [confirm, setConfirm] = useState<{
    request: PluginActionRequest
    command: string
    sha256: string | null
    message: string
  } | null>(null)

  const [marketplaceSource, setMarketplaceSource] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.plugins.catalog(cwd || undefined)
      if (result.ok) {
        setCatalog({
          installed: result.installed,
          available: result.available,
          marketplaces: result.marketplaces,
          categories: result.categories
        })
        setError(null)
      } else {
        setError(result.error)
      }
    } catch (thrown) {
      setError(String(thrown))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    let live = true
    void window.api.plugins.publicLogos().then((logos) => {
      if (live) setPublicLogos(logos)
    }).catch(() => {})
    return () => { live = false }
  }, [])

  const logoFor = (plugin: AvailablePlugin): string | undefined =>
    plugin.kind === 'integration' && plugin.marketplace === 'claude-plugins-official'
      ? publicLogos[plugin.name.toLowerCase()]
      : undefined

  /**
   * Every mutation goes through here, so none of them can forget the two things
   * that matter: a marketplace-declared command is a question, not a failure to
   * retry, and anything that changes what Claude loads needs a restart to take
   * effect.
   */
  const run = useCallback(
    async (
      request: PluginActionRequest,
      options?: {
        confirmation?: { command: string; sha256: string | null }
        /** Set by a dialog, which closes on success so the result is visible:
         *  a banner behind an open modal is a banner nobody reads. */
        fromDialog?: boolean
      }
    ) => {
      setBusy(true)
      setNotice(null)
      try {
        const confirmation = options?.confirmation
        const result = await window.api.plugins.action(
          confirmation ? { ...request, acceptCommand: confirmation.sha256 ?? undefined } : request
        )
        if (!result.ok) {
          if ('needsConfirmation' in result) {
            setConfirm({
              request,
              command: result.command,
              sha256: result.sha256,
              message: result.message
            })
            return
          }
          setNotice({ tone: 'danger', text: result.error })
          return
        }
        setConfirm(null)
        setNotice({
          tone: 'success',
          text: request.action === 'install' ? 'Installed.' : 'Done.'
        })
        setRestartNeeded(true)
        if (options?.fromDialog) setOpen(null)
        await reload()
      } catch (thrown) {
        setNotice({ tone: 'danger', text: String(thrown) })
      } finally {
        setBusy(false)
      }
    },
    [reload]
  )

  // The full inventory of whatever is open. The catalog carries counts for
  // every plugin; names only come from asking, so it happens once, on open.
  useEffect(() => {
    if (!open) {
      setDetails(null)
      return
    }
    let live = true
    void window.api.plugins
      .action({ action: 'details', id: open.id, cwd: cwd || undefined })
      .then((result) => {
        if (live && result.ok) setDetails(asComponentNames(result.components))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [open, cwd])

  const available = catalog?.available ?? []
  const installed = catalog?.installed ?? []

  const filtered = useMemo(
    () => filterPlugins(available, query, chosenCategories),
    [available, query, chosenCategories]
  )
  const integrations = useMemo(() => sortPlugins(
    filtered.filter((plugin) => plugin.kind === 'integration'),
    sort
  ), [filtered, sort])
  const plugins = useMemo(
    () => sortPlugins(
      filtered.filter((plugin) => plugin.kind === 'plugin'),
      sort
    ),
    [filtered, sort]
  )

  const toggleCategory = (id: string): void =>
    setChosenCategories((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    )

  const section = (
    key: 'integration' | 'plugin',
    title: string,
    list: AvailablePlugin[]
  ): React.JSX.Element => {
    const expanded = showAll[key] ?? false
    const shown = expanded ? list : list.slice(0, PREVIEW_COUNT)
    return (
      <section className="mb-8">
        <SectionHeading
          trailing={
            list.length > PREVIEW_COUNT ? (
              <button
                type="button"
                onClick={() => setShowAll((current) => ({ ...current, [key]: !expanded }))}
                className="text-c-md text-muted-foreground transition-colors hover:text-foreground"
              >
                {expanded ? 'Show less' : `Show all ${list.length}`}
              </button>
            ) : undefined
          }
        >
          {title}
        </SectionHeading>
        {shown.length > 0 ? (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                logoUrl={logoFor(plugin)}
                onOpen={() => setOpen(plugin)}
              />
            ))}
          </div>
        ) : (
          <EmptyNote>
            {query || chosenCategories.length > 0
              ? 'Nothing matches here.'
              : `No ${title.toLowerCase()} in this catalog yet.`}
          </EmptyNote>
        )}
      </section>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-6xl shrink-0 px-8 pt-8">
        <header className="mb-6 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[1.6em] font-semibold tracking-tight text-foreground">
              <Boxes className="size-5 shrink-0 text-muted-foreground" />
              Plugins
            </h1>
            <p className="mt-1 text-c-md text-muted-foreground">
              What Claude Code can load, from the marketplaces you have added.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void reload()}
            className="shrink-0 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-c-md font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            Refresh
          </button>
        </header>

        <div className="mb-5 w-fit">
          <SegmentedControl
            value={tab}
            onChange={(next) => setTab(next as Tab)}
            options={[
              { value: 'discover', label: 'Discover' },
              { value: 'installed', label: `Installed${installed.length ? ` (${installed.length})` : ''}` },
              { value: 'marketplaces', label: `Marketplaces${catalog?.marketplaces.length ? ` (${catalog.marketplaces.length})` : ''}` }
            ]}
          />
        </div>

        {notice && (
          <p
            className={`mb-4 text-c-md ${notice.tone === 'danger' ? 'text-danger' : notice.tone === 'success' ? 'text-success' : 'text-muted-foreground'}`}
          >
            {notice.text}
          </p>
        )}

        {restartNeeded && <RestartBanner running={running} onDone={() => setRestartNeeded(false)} />}

        {tab === 'discover' && !error && (!loading || catalog) && (
          <div className="mb-5 flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search plugins"
                aria-label="Search plugins"
                className="w-full rounded-full border border-border bg-muted/40 py-2 pl-9 pr-3 text-c-md text-foreground outline-hidden placeholder:text-muted-foreground focus:border-border-strong"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-c-md text-muted-foreground">Sort</span>
              <Select
                value={sort}
                onChange={(next) => setSort(next as PluginSort)}
                options={PLUGIN_SORTS}
              />
            </div>
          </div>
        )}
      </div>

      <div className="scroll-auto-hide min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-8 pb-10">

        {error ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-px size-4 shrink-0 text-danger" />
              <p className="min-w-0 flex-1 text-c-md text-danger">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void reload()}
              className="mt-2 flex items-center gap-1 text-c-md text-foreground/80 transition-colors hover:text-foreground"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          </div>
        ) : loading && !catalog ? (
          <p className="text-c-md text-muted-foreground">Reading the catalog…</p>
        ) : tab === 'discover' ? (
          <>
            <div className="flex items-start gap-8">
              <CategoryRail
                categories={catalog?.categories ?? []}
                chosen={chosenCategories}
                onToggle={toggleCategory}
                onClear={() => setChosenCategories([])}
              />
              <div className="min-w-0 flex-1">
                {section('integration', 'Top integrations', integrations)}
                {section('plugin', 'Top plugins', plugins)}
              </div>
            </div>
          </>
        ) : tab === 'installed' ? (
          <InstalledTab
            installed={installed}
            available={available}
            busy={busy}
            confirming={confirmUninstall}
            onConfirm={setConfirmUninstall}
            onAction={run}
            onOpen={(plugin) => {
              setOpen(plugin)
              setScope((plugin.installedScope as PluginScope) ?? 'user')
            }}
          />
        ) : (
          <MarketplacesTab
            marketplaces={catalog?.marketplaces ?? []}
            source={marketplaceSource}
            scope={scope}
            busy={busy}
            confirming={confirmRemove}
            onSource={setMarketplaceSource}
            onScope={setScope}
            onConfirm={setConfirmRemove}
            onAction={run}
          />
        )}
        </div>
      </div>

      {/* One dialog at a time: the command confirmation replaces the plugin's
          own dialog rather than stacking on top of it, which is also what the
          focus trap wants. */}
      {open && !confirm && (
        <PluginDialog
          plugin={open}
          logoUrl={logoFor(open)}
          scope={scope}
          details={details}
          busy={busy}
          notice={notice}
          onScope={setScope}
          onClose={() => {
            setOpen(null)
            setConfirm(null)
          }}
          onAction={(request) => void run(request, { fromDialog: true })}
        />
      )}

      {confirm && (
        <CommandDialog
          command={confirm.command}
          sha256={confirm.sha256}
          message={confirm.message}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onAccept={() =>
            void run(confirm.request, {
              confirmation: { command: confirm.command, sha256: confirm.sha256 },
              fromDialog: true
            })
          }
        />
      )}
    </div>
  )
}

type CatalogMarketplace = { name: string; source: string; location: string; official: boolean; pluginCount: number }
type CatalogCategory = { id: string; label: string; count: number }

/** The category filter, on the left where a catalog's filters belong. */
function CategoryRail({
  categories,
  chosen,
  onToggle,
  onClear
}: {
  categories: CatalogCategory[]
  chosen: string[]
  onToggle: (id: string) => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <aside className="scrollbar-none sticky top-0 hidden max-h-[calc(100dvh-250px)] w-48 shrink-0 self-start overflow-y-auto lg:block">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-c-md font-medium text-foreground">Category</span>
        {chosen.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-c-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {categories.length === 0 ? (
        <p className="text-c-sm text-muted-foreground">No categories in this catalog.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {categories.map((category) => (
            <li key={category.id}>
              <label className="flex cursor-pointer items-center gap-2 py-0.5">
                <Checkbox
                  aria-label={category.label}
                  checked={chosen.includes(category.id)}
                  onCheckedChange={() => onToggle(category.id)}
                />
                <span className="min-w-0 flex-1 truncate text-c-md text-foreground/80">
                  {category.label}
                </span>
                <span className="shrink-0 font-mono text-c-xs text-muted-foreground">
                  {category.count}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

/**
 * One catalog entry.
 *
 * The tile carries the plugin's initial rather than a logo we do not have —
 * two rows of letters read as a catalog, and an invented icon per plugin would
 * be a lie with a colour. Selecting the card opens its detail; the plus is the
 * same destination, because installing needs the scope question answered first.
 */
function PluginCard({
  plugin,
  logoUrl,
  onOpen
}: {
  plugin: AvailablePlugin
  logoUrl?: string
  onOpen: () => void
}): React.JSX.Element {
  const name = pluginName(plugin)
  const [logoFailed, setLogoFailed] = useState(false)

  return (
    <div className="flex h-[96px] min-w-0 items-stretch gap-2 overflow-hidden rounded-lg border border-border/55 bg-muted/40 p-2.5">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
        <span
          className={`grid size-8 shrink-0 place-items-center overflow-hidden rounded-md font-mono text-c-md font-semibold ring-1 ring-border/60 ${
            logoUrl && !logoFailed
              ? 'bg-white text-foreground'
              : plugin.kind === 'integration'
                ? 'bg-info/10 text-info'
                : 'bg-background/70 text-muted-foreground'
          }`}
        >
          {logoUrl && !logoFailed ? (
            <img
              src={logoUrl}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setLogoFailed(true)}
              className="block size-full object-cover"
            />
          ) : name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate text-c-md font-medium text-foreground">{name}</span>
            {plugin.verified && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span aria-label="From the published catalog" className="shrink-0">
                    <BadgeCheck className="size-3.5 text-info" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Published by Anthropic&rsquo;s own catalog</TooltipContent>
              </Tooltip>
            )}
          </span>
          <span className="mt-1 block max-h-[2.6em] overflow-hidden text-c-sm leading-[1.3] text-muted-foreground">
            {plugin.description || 'No description'}
          </span>
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label={plugin.installed ? `${name} is installed` : `Install ${name}`}
            className={`grid size-6 shrink-0 place-items-center self-center rounded-md border border-border/70 transition-colors ${
              plugin.installed
                ? 'text-success'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {plugin.installed ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{plugin.installed ? 'Installed — open to manage' : 'Install'}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function InstalledTab({
  installed,
  available,
  busy,
  confirming,
  onConfirm,
  onAction,
  onOpen
}: {
  installed: InstalledPlugin[]
  available: AvailablePlugin[]
  busy: boolean
  confirming: string | null
  onConfirm: (id: string | null) => void
  onAction: (request: PluginActionRequest) => void
  onOpen: (plugin: AvailablePlugin) => void
}): React.JSX.Element {
  if (installed.length === 0) {
    return <EmptyNote>Nothing installed yet. Discover has the catalog.</EmptyNote>
  }

  return (
    <ul className="flex flex-col">
      {installed.map((plugin) => {
        const row = available.find((entry) => entry.id === plugin.id)
        const updating = row?.installed && row.version && row.installedVersion && row.version !== row.installedVersion
        return (
          <li
            key={plugin.id}
            className="flex flex-wrap items-center gap-2 border-b border-separator py-2.5 last:border-b-0"
          >
            <button
              type="button"
              disabled={!row}
              onClick={() => row && onOpen(row)}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background/70 font-mono text-c-md font-semibold text-muted-foreground ring-1 ring-border/60">
                {plugin.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-c-md font-medium text-foreground">
                  {plugin.name}
                </span>
                <span className="block truncate text-c-sm text-muted-foreground">
                  {[plugin.marketplace, plugin.version && `v${plugin.version}`, plugin.scope]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>

            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-c-xs font-medium ${
                plugin.enabled ? 'bg-success/15 text-success' : 'bg-accent text-muted-foreground'
              }`}
            >
              {plugin.enabled ? 'Enabled' : 'Disabled'}
            </span>

            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-c-sm text-muted-foreground">
                {componentSummary(plugin.components)}
              </span>
              {updating && (
                <span className="rounded-full bg-info/15 px-1.5 py-0.5 text-c-xs font-medium text-info">
                  v{plugin.version} available
                </span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void onAction({ action: 'update', id: plugin.id })}
                className="rounded-md border border-border bg-muted/40 px-2 py-1 text-c-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                Update
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void onAction({
                    action: plugin.enabled ? 'disable' : 'enable',
                    id: plugin.id
                  })
                }
                className="rounded-md border border-border bg-muted/40 px-2 py-1 text-c-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {plugin.enabled ? 'Disable' : 'Enable'}
              </button>
              {confirming === plugin.id ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onConfirm(null)
                      void onAction({ action: 'uninstall', id: plugin.id })
                    }}
                    className="rounded-md bg-danger/15 px-2 py-1 text-c-sm font-medium text-danger transition-colors hover:bg-danger/25"
                  >
                    Uninstall
                  </button>
                  <button
                    type="button"
                    onClick={() => onConfirm(null)}
                    className="text-c-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onConfirm(plugin.id)}
                      aria-label={`Uninstall ${plugin.name}`}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/15 hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Uninstall</TooltipContent>
                </Tooltip>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function MarketplacesTab({
  marketplaces,
  source,
  scope,
  busy,
  confirming,
  onSource,
  onScope,
  onConfirm,
  onAction
}: {
  marketplaces: CatalogMarketplace[]
  source: string
  scope: PluginScope
  busy: boolean
  confirming: string | null
  onSource: (value: string) => void
  onScope: (value: PluginScope) => void
  onConfirm: (name: string | null) => void
  onAction: (request: PluginActionRequest) => void
}): React.JSX.Element {
  return (
    <>
      <section className="mb-8 rounded-lg border border-border/55 bg-muted/40 p-3">
        <p className="mb-2 text-c-md text-muted-foreground">
          Add a marketplace from a GitHub repo, a URL, or a folder on this machine.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              value={source}
              onChange={onSource}
              mono
              placeholder="owner/repo, https://github.com/owner/repo, or /path/to/marketplace"
            />
          </div>
          <Select
            value={scope}
            onChange={(next) => onScope(next as PluginScope)}
            options={PLUGIN_SCOPES}
          />
          <button
            type="button"
            disabled={busy || !source.trim()}
            onClick={() => void onAction({ action: 'marketplace.add', source, scope })}
            className="rounded-md bg-info/90 px-3 py-1.5 text-c-md font-medium text-info-foreground transition-colors hover:bg-info disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </section>

      <SectionHeading trailing={`${marketplaces.length} configured`}>Sources</SectionHeading>
      {marketplaces.length === 0 ? (
        <EmptyNote>No marketplaces configured.</EmptyNote>
      ) : (
        <ul className="flex flex-col">
          {marketplaces.map((marketplace) => (
            <li
              key={marketplace.name}
              className="flex flex-wrap items-center gap-2 border-b border-separator py-2.5 last:border-b-0"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background/70 ring-1 ring-border/60">
                <Plug className="size-3.5 text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-c-md font-medium text-foreground">
                    {marketplace.name}
                  </span>
                  {marketplace.official && (
                    <span className="shrink-0 rounded-full bg-info/15 px-1.5 py-0.5 text-c-xs font-medium text-info">
                      Official
                    </span>
                  )}
                </span>
                <span
                  className="block truncate font-mono text-c-sm text-muted-foreground"
                  title={marketplace.location}
                >
                  {marketplace.source}
                </span>
              </span>
              <span className="shrink-0 font-mono text-c-xs text-muted-foreground">
                {marketplace.pluginCount} plugins
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onAction({ action: 'marketplace.update', id: marketplace.name })}
                  className="rounded-md border border-border bg-muted/40 px-2 py-1 text-c-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  Update
                </button>
                {confirming === marketplace.name ? (
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        onConfirm(null)
                        void onAction({ action: 'marketplace.remove', id: marketplace.name, scope })
                      }}
                      className="rounded-md bg-danger/15 px-2 py-1 text-c-sm font-medium text-danger transition-colors hover:bg-danger/25"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirm(null)}
                      className="text-c-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onConfirm(marketplace.name)}
                        aria-label={`Remove ${marketplace.name}`}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/15 hover:text-danger"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Remove this marketplace</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** One plugin, in full, with the scope question and the action it leads to. */
function PluginDialog({
  plugin,
  logoUrl,
  scope,
  details,
  busy,
  notice,
  onScope,
  onClose,
  onAction
}: {
  plugin: AvailablePlugin
  logoUrl?: string
  scope: PluginScope
  details: PluginComponentNames | null
  busy: boolean
  notice: Notice | null
  onScope: (value: PluginScope) => void
  onClose: () => void
  onAction: (request: PluginActionRequest) => void
}): React.JSX.Element {
  const name = pluginName(plugin)
  const [logoFailed, setLogoFailed] = useState(false)
  const installs = formatInstalls(plugin.installCount)
  const cost = alwaysOnTokens(plugin.tokens)
  const groups: [string, string[]][] = details
    ? [
        ['MCP servers', details.mcpServers],
        ['Skills', details.skills],
        ['Commands', details.commands],
        ['Agents', details.agents],
        ['Hooks', details.hooks],
        ['LSP servers', details.lspServers]
      ]
    : []

  return (
    <Modal open onClose={onClose} title={name} showCloseButton focusContentOnOpen className="sm:max-w-2xl">
      <div className="flex max-h-[calc(85vh-2rem)] min-h-0 w-full min-w-0 flex-col">
        <header className="min-w-0 shrink-0 px-6 pb-4 pt-5">
          <h2 className="flex min-w-0 items-center gap-2 text-c-xl font-semibold text-foreground">
            {logoUrl && !logoFailed && (
              <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-white">
                <img
                  src={logoUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={() => setLogoFailed(true)}
                  className="block size-full object-cover"
                />
              </span>
            )}
            <span className="min-w-0 truncate">{name}</span>
            {plugin.verified && <BadgeCheck className="size-4 shrink-0 text-info" />}
            {plugin.installed && (
              <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-c-xs font-medium text-success">
                Installed
              </span>
            )}
          </h2>
          <p className="mt-1 text-c-md text-muted-foreground">
            {[plugin.author, plugin.marketplace, plugin.category, plugin.version && `v${plugin.version}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>

        <div className="scroll-auto-hide mx-6 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-border/55 bg-black/[0.06] px-4 py-3 dark:bg-black/25">
          {notice && (
            <p
              className={`mb-2 text-c-md ${notice.tone === 'danger' ? 'text-danger' : notice.tone === 'success' ? 'text-success' : 'text-muted-foreground'}`}
            >
              {notice.text}
            </p>
          )}
          <p className="text-c-md text-foreground/90">{plugin.description || 'No description'}</p>

          <dl className="mt-3 flex flex-col gap-1">
            <DetailRow label="Source">
              <span className="font-mono text-c-sm text-muted-foreground" title={plugin.source}>
                {plugin.source}
              </span>
            </DetailRow>
            {installs && <DetailRow label="Installs">{installs}</DetailRow>}
            {cost && (
              <DetailRow label="Cost">
                ~{cost.toLocaleString('en-US')} tokens in every session
              </DetailRow>
            )}
            <DetailRow label="Adds">{componentSummary(plugin.components)}</DetailRow>
          </dl>

          {details ? (
            <div className="mt-4 flex flex-col gap-2">
              {groups
                .filter(([, list]) => list.length > 0)
                .map(([label, list]) => (
                  <div key={label}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {label} · {list.length}
                    </p>
                    <p className="font-mono text-c-sm text-muted-foreground">{list.join(', ')}</p>
                  </div>
                ))}
            </div>
          ) : (
            <p className="mt-4 text-c-sm text-muted-foreground">
              This one installs from a remote source, so its exact contents are resolved when it
              is fetched.
            </p>
          )}

          {plugin.homepage && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void window.api.system.openExternal(plugin.homepage!)}
                  className="mt-3 flex max-w-full items-center gap-1.5 text-left text-c-sm text-info transition-colors hover:underline"
                >
                  <ExternalLink className="size-3 shrink-0" />
                  <span className="truncate">
                    {plugin.homepage.includes('github.com/') ? 'View source on GitHub' : 'Open plugin homepage'}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm break-all font-mono text-[10px]">
                {plugin.homepage}
              </TooltipContent>
            </Tooltip>
          )}

          {plugin.marketplace === 'claude-plugins-official' && (
            <button
              type="button"
              onClick={() => void window.api.system.openExternal(
                `https://claude.com/marketplace/plugins/${encodeURIComponent(plugin.name)}`
              )}
              className="mt-2 flex items-center gap-1 text-c-sm text-info transition-colors hover:underline"
            >
              <ExternalLink className="size-3" />
              Read full listing on Claude Marketplace
            </button>
          )}

        </div>

        <footer className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5 px-6 py-4">
          <span className="mr-1 text-c-xs font-medium text-muted-foreground">Install to</span>
          <SegmentedControl
            value={scope}
            onChange={(next) => onScope(next as PluginScope)}
            options={PLUGIN_SCOPES}
          />
          {plugin.installed && (
            <>
              <DialogAction
                onClick={() =>
                  void onAction({
                    action: plugin.enabled ? 'disable' : 'enable',
                    id: plugin.id,
                    scope
                  })
                }
              >
                {plugin.enabled ? 'Disable' : 'Enable'}
              </DialogAction>
              <DialogAction onClick={() => void onAction({ action: 'uninstall', id: plugin.id })}>
                Uninstall
              </DialogAction>
            </>
          )}
          <DialogAction
            primary
            onClick={() =>
              void onAction({
                action: plugin.installed ? 'update' : 'install',
                id: plugin.id,
                scope
              })
            }
          >
            {busy ? 'Working…' : plugin.installed ? 'Update' : 'Install'}
          </DialogAction>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-c-md text-muted-foreground transition-colors hover:text-foreground"
          >
            Close
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function DetailRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-20 shrink-0 text-c-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-c-sm text-foreground/85">{children}</dd>
    </div>
  )
}

/**
 * A marketplace that installs by declaring a command gets to say so, and the
 * command is shown in full with the hash that authorises exactly it. This is
 * the only path in the page that can run something the catalog wrote, and it
 * runs only after somebody has read it here.
 */
function CommandDialog({
  command,
  sha256,
  message,
  busy,
  onCancel,
  onAccept
}: {
  command: string
  sha256: string | null
  message: string
  busy: boolean
  onCancel: () => void
  onAccept: () => void
}): React.JSX.Element {
  return (
    <Modal open onClose={onCancel} title="This marketplace runs a command" showCloseButton className="sm:max-w-xl">
      <div className="flex flex-col gap-3 px-6 py-5">
        <p className="text-c-md text-foreground/90">{message}</p>
        <pre className="scroll-auto-hide overflow-x-auto rounded-md border border-border/55 bg-black/[0.06] px-3 py-2 font-mono text-c-sm text-foreground/90 dark:bg-black/25">
          {command}
        </pre>
        {sha256 && (
          <p className="break-all font-mono text-c-xs text-muted-foreground">sha256 {sha256}</p>
        )}
        <p className="text-c-sm text-muted-foreground">
          Allowing runs exactly this command, for exactly this plugin and catalog. If either
          changes, it is shown again.
        </p>
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-c-md text-muted-foreground transition-colors hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onAccept}
            className="rounded-md bg-info/90 px-3 py-1.5 text-c-md font-medium text-info-foreground transition-colors hover:bg-info disabled:opacity-50"
          >
            {busy ? 'Running…' : 'Run it and install'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Claude loads plugins at session start, so an install does not take effect
 * until the process that would load it restarts. Saying that here is the
 * difference between a feature that works and one that looks broken.
 */
function RestartBanner({
  running,
  onDone
}: {
  running: boolean
  onDone: () => void
}): React.JSX.Element {
  const restart = useCallback(async () => {
    const sessionId = useSessionsStore.getState().activeSessionId
    if (!sessionId) return
    if (isSessionRunning(sessionId)) return
    await window.api.claude.dispose(sessionId)
    onDone()
  }, [onDone])

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2">
      <RefreshCw className="size-3.5 shrink-0 text-info" />
      <p className="min-w-0 flex-1 text-c-md text-foreground/90">
        {running
          ? 'Claude loads plugins when it starts. This chat is mid-turn, so restart when it finishes.'
          : 'Claude loads plugins when it starts. Restart this chat for the change to apply.'}
      </p>
      <button
        type="button"
        onClick={() => void restart()}
        disabled={running}
        className="shrink-0 rounded-md bg-info/90 px-2.5 py-1 text-c-sm font-medium text-info-foreground transition-colors hover:bg-info disabled:opacity-50"
      >
        Restart Claude
      </button>
      <button
        type="button"
        onClick={onDone}
        className="shrink-0 text-c-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  )
}
