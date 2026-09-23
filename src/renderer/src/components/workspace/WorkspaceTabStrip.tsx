import React, { useState } from 'react'
import { Bot, FileDiff, FileText, Frame, Globe, ListChecks, Loader2, X } from 'lucide-react'
import NewTabMenu from './NewTabMenu'
import type { NewTabKind } from './tabs'
import { tabKey, type WorkspaceTab } from '../../store/workspace'
import type { BrowserPhase } from '../../store/browser'
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
 *
 * The interaction is the one every editor taught: a click on a file lands in the
 * chat's single replaceable slot, drawn italic; a double click keeps a tab of its
 * own. A middle click closes whatever it lands on, preview or not.
 */
export default function WorkspaceTabStrip({
  tabs,
  activeKey,
  browserTabs,
  browserPhase,
  onSelect,
  onClose,
  onPin,
  onReorder,
  onNew
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  /** The sidecar's mirror, for the browser rows' titles and spinners. */
  browserTabs: BrowserTab[]
  /** Only the provisional row reads this: a browser that failed to start should
   *  stop claiming to be loading. */
  browserPhase: BrowserPhase
  onSelect: (key: string) => void
  onClose: (key: string) => void
  /** Keep a preview row open — a double click on its tab. */
  onPin: (key: string) => void
  /** Put `fromKey` immediately before `beforeKey`, or last when null. */
  onReorder: (fromKey: string, beforeKey: string | null) => void
  onNew: (kind: NewTabKind) => void
}): React.JSX.Element {
  const [dragKey, setDragKey] = useState<string | null>(null)
  /** The key the dragged tab would land in front of; `END` for past the last. */
  const [dropAt, setDropAt] = useState<string | null>(null)

  const endDrag = (): void => {
    setDragKey(null)
    setDropAt(null)
  }

  return (
    <div
      role="tablist"
      className="flex items-center gap-0.5 overflow-x-auto border-b border-border/55 px-1.5 py-1"
    >
      {tabs.map((tab, i) => {
        const key = tabKey(tab)
        const live = tab.kind === 'browser' ? browserTabs.find((t) => t.tabId === tab.tabId) : null
        const label =
          tab.kind === 'browser'
            ? live?.title || hostOf(live?.url ?? '') || 'New tab'
            : tab.kind === 'changes'
              ? 'Changes'
              : tab.kind === 'plan'
                ? 'Plan'
                : tab.kind === 'subagents'
                  ? 'Subagents'
                  : tab.kind === 'design'
                    ? 'Design'
                    : (basename(tab.path) ?? 'Open file')
        const hint =
          tab.kind === 'browser'
            ? live?.url
            : tab.kind === 'changes'
              ? "This chat's changes"
              : tab.kind === 'plan'
                ? 'The plan under review'
                : tab.kind === 'subagents'
                  ? "This chat's subagents"
                  : tab.kind === 'design'
                    ? 'The design canvas'
                    : tab.preview
                      ? `${tab.path ?? 'No file open'} — double-click to keep it open`
                      : (tab.path ?? 'No file open')
        const waking = tab.kind === 'browser' && tab.provisional === true
        /** A boot that failed is no longer loading, and a spinner that never
         *  stops is a lie about the state of the world. */
        const stuck = waking && (browserPhase === 'needs-chromium' || browserPhase === 'error')
        // A provisional row has no url to show yet; what it has is a reason to be
        // on screen, which is the honest thing to say in its tooltip — and once
        // the boot has failed, that reason changes.
        const title = waking
          ? stuck
            ? 'The browser could not start'
            : 'Starting the browser…'
          : hint

        return (
          <div
            key={key}
            role="tab"
            aria-selected={key === activeKey}
            tabIndex={0}
            draggable
            onDragStart={(e) => {
              setDragKey(key)
              // Firefox refuses to start a drag without payload, and the strip
              // is not a drop target for anything from outside.
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', key)
            }}
            onDragEnd={endDrag}
            onDragOver={(e) => {
              if (!dragKey) return
              e.preventDefault()
              // Which side of this tab the pointer is on. Without it the last
              // position is unreachable, since every drop would insert before
              // something.
              const box = e.currentTarget.getBoundingClientRect()
              const after = e.clientX > box.left + box.width / 2
              const next = after ? (tabs[i + 1] ? tabKey(tabs[i + 1]) : END) : key
              if (next !== dropAt) setDropAt(next)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragKey && dropAt) onReorder(dragKey, dropAt === END ? null : dropAt)
              endDrag()
            }}
            onClick={() => onSelect(key)}
            onDoubleClick={() => {
              if (tab.kind === 'file') onPin(key)
            }}
            // Middle click closes, on every kind of row. `auxclick` rather than
            // `mouseup` so it is the button's own event and not a modifier of a
            // left click.
            onAuxClick={(e) => {
              if (e.button !== 1) return
              e.preventDefault()
              onClose(key)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(key)
            }}
            title={title}
            className={`group relative flex min-w-0 max-w-[150px] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
              key === activeKey
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground/80'
            } ${dragKey === key ? 'opacity-40' : ''}`}
          >
            {dropAt === key && dragKey !== key && <DropMark side="left" />}
            {dropAt === END && i === tabs.length - 1 && dragKey !== key && <DropMark side="right" />}
            {/* A loading tab keeps its own icon and shimmers its label: the
                icon says what the tab is, which does not stop being true while
                it loads. */}
            {tab.kind === 'browser' ? (
              waking && !stuck ? (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Globe className="size-3 shrink-0 text-muted-foreground" />
              )
            ) : tab.kind === 'changes' ? (
              <FileDiff className="size-3 shrink-0 text-muted-foreground" />
            ) : tab.kind === 'plan' ? (
              <ListChecks className="size-3 shrink-0 text-muted-foreground" />
            ) : tab.kind === 'subagents' ? (
              <Bot className="size-3 shrink-0 text-muted-foreground" />
            ) : tab.kind === 'design' ? (
              <Frame className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span
              className={`truncate ${live?.loading || (waking && !stuck) ? 'nyra-shimmer' : ''} ${
                tab.kind === 'file' && tab.preview ? 'italic' : ''
              }`}
            >
              {label}
            </span>
            <button
              aria-label="Close tab"
              draggable={false}
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

/** Past the last tab. A key cannot collide with it — every real one is prefixed
 *  `browser:` or `file:`. */
const END = 'end'

function DropMark({ side }: { side: 'left' | 'right' }): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={`absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-info ${
        side === 'left' ? '-left-px' : '-right-px'
      }`}
    />
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
