import React from 'react'
import { Globe, Loader2, Plus, X } from 'lucide-react'
import type { BrowserTab } from '../../lib/api-types'

/**
 * The tab strip Codex's browser does not have.
 *
 * Their in-app browser is a single surface — navigating replaces the page, and
 * openai/codex#23314 is the open request for exactly this. Worth having: an
 * agent checking a change against a dev server, a GitHub issue and the docs at
 * once is the normal case, not the exotic one.
 */
export default function BrowserTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCreate
}: {
  tabs: BrowserTab[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onCreate: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border/55 px-1.5 py-1">
      {tabs.map((tab) => {
        const active = tab.tabId === activeTabId
        return (
          <div
            key={tab.tabId}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onSelect(tab.tabId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(tab.tabId)
            }}
            title={tab.url}
            className={`group flex min-w-0 max-w-[150px] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground/80'
            }`}
          >
            {tab.loading ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="size-3 shrink-0 text-muted-foreground/70" />
            )}
            <span className="truncate">{tab.title || hostOf(tab.url) || 'New tab'}</span>
            <button
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.tabId)
              }}
              // Always present for the active tab, on hover for the rest —
              // otherwise the strip twitches as the pointer crosses it.
              className={`-mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground ${
                active ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <X className="size-2.5" />
            </button>
          </div>
        )
      })}
      <button
        aria-label="New tab"
        onClick={onCreate}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
