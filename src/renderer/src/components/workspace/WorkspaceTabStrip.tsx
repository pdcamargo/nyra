import React from 'react'
import { FileText, Globe, Loader2, X } from 'lucide-react'
import NewTabMenu from './NewTabMenu'
import type { NewTabKind } from './tabs'
import { tabKey, type WorkspaceTab } from '../../store/workspace'
import type { BrowserTab } from '../../lib/api-types'

/**
 * The tab strip Codex's browser does not have.
 *
 * Their in-app browser is a single surface — navigating replaces the page, and
 * openai/codex#23314 is the open request for exactly this. Worth having: an
 * agent checking a change against a dev server, a GitHub issue and the docs at
 * once is the normal case, not the exotic one.
 *
 * It holds file tabs now too, which is why a row's label comes from a join
 * rather than from the row: a browser tab's title belongs to the sidecar and
 * changes on every navigation, and only the title should re-render when it does.
 */
export default function WorkspaceTabStrip({
  tabs,
  activeKey,
  browserTabs,
  onSelect,
  onClose,
  onNew
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  /** The sidecar's mirror, for the browser rows' titles and spinners. */
  browserTabs: BrowserTab[]
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onNew: (kind: NewTabKind) => void
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      className="flex items-center gap-0.5 overflow-x-auto border-b border-border/55 px-1.5 py-1"
    >
      {tabs.map((tab) => {
        const key = tabKey(tab)
        const live = tab.kind === 'browser' ? browserTabs.find((t) => t.tabId === tab.tabId) : null
        const label =
          tab.kind === 'browser'
            ? live?.title || hostOf(live?.url ?? '') || 'New tab'
            : (basename(tab.path) ?? 'Open file')
        const hint = tab.kind === 'browser' ? live?.url : (tab.path ?? 'No file open')

        return (
          <div
            key={key}
            role="tab"
            aria-selected={key === activeKey}
            tabIndex={0}
            onClick={() => onSelect(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(key)
            }}
            title={hint}
            className={`group flex min-w-0 max-w-[150px] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
              key === activeKey
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground/80'
            }`}
          >
            {live?.loading ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : tab.kind === 'browser' ? (
              <Globe className="size-3 shrink-0 text-muted-foreground/70" />
            ) : (
              <FileText className="size-3 shrink-0 text-muted-foreground/70" />
            )}
            <span className="truncate">{label}</span>
            <button
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                onClose(key)
              }}
              // Always present for the active tab, on hover for the rest —
              // otherwise the strip twitches as the pointer crosses it.
              className={`-mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground ${
                key === activeKey ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <X className="size-2.5" />
            </button>
          </div>
        )
      })}
      <NewTabMenu onPick={onNew} />
    </div>
  )
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The label a file tab wears. Null until a file is picked. */
export function basename(path: string | null): string | null {
  if (!path) return null
  return path.split('/').filter(Boolean).pop() ?? null
}
