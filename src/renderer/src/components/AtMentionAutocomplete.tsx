import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { FolderRoot } from '../lib/folderRoots'
import { joinPath, separatorOf, trimTrailingSep } from '../lib/paths'

export type MentionItem = {
  path: string
  type: 'file' | 'folder' | 'url' | 'agent'
  label?: string
  meta?: string
  /** The linked folder it came from; unset for the chat's own. */
  root?: string
}

const NO_ROOTS: readonly FolderRoot[] = []

/** A path the user is walking themselves — `@~/dev`, `@../api`, `@/tmp` —
 *  which means one place, not one per linked folder. */
function isBrowse(query: string): boolean {
  return /^(?:[~/\\.]|[a-zA-Z]:[\\/])/.test(query)
}

/** Each list is best-first already, so taking them in turns keeps every
 *  folder's best match near the top without inventing a shared score. */
function interleave(lists: MentionItem[][]): MentionItem[] {
  const out: MentionItem[] = []
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i])
  }
  return out
}

/**
 * The files and folders an @ could name. Nothing for a bare `@` — the popup
 * waits for a letter — unless `everything` asks for it (Ctrl+Space), when an
 * empty query lists the top of the project, and each linked folder.
 *
 * A linked folder's matches are inserted whole: relative to the chat's own
 * directory they would name nothing.
 */
export function useAtMentionItems(
  query: string | null,
  cwd: string,
  everything = false,
  linked: readonly FolderRoot[] = NO_ROOTS
): MentionItem[] {
  const [items, setItems] = useState<MentionItem[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (query === null || (query.length === 0 && !everything)) {
      setItems([])
      return
    }

    // Check if it looks like a URL
    if (/^https?:\/\//i.test(query)) {
      setItems([{ path: query, type: 'url' }])
      return
    }

    clearTimeout(debounceRef.current)
    let cancelled = false
    debounceRef.current = setTimeout(() => {
      const own = window.api.fs
        .listFiles(cwd, query)
        .then((results) => results.map((r): MentionItem => ({ path: r.path, type: r.type })))
      const others = isBrowse(query)
        ? []
        : linked.map((root) =>
            query === ''
              ? Promise.resolve<MentionItem[]>([
                  { path: `${trimTrailingSep(root.path)}${separatorOf(root.path)}`, type: 'folder', label: root.name, root: root.name }
                ])
              : window.api.fs
                  .listFiles(root.path, query)
                  .then((results) =>
                    results.map((r): MentionItem => ({ path: joinPath(root.path, r.path), type: r.type, label: r.path, root: root.name }))
                  )
                  .catch(() => [] as MentionItem[])
          )
      void Promise.all([own, ...others]).then((lists) => {
        if (cancelled) return
        // Ctrl+Space on a bare `@`: the chat's own top level, then each linked
        // folder as one more place to browse into.
        setItems(query === '' ? lists.flat() : interleave(lists))
      })
    }, 80)

    return () => {
      cancelled = true
      clearTimeout(debounceRef.current)
    }
  }, [query, cwd, everything, linked])

  return items
}

type Props = {
  items: MentionItem[]
  selectedIndex: number
  onSelect: (item: MentionItem) => void
  onHover: (index: number) => void
  anchorLeft: number
}

const TYPE_STYLES: Record<string, string> = {
  file: 'bg-info/20 text-info',
  folder: 'bg-info/20 text-info',
  url: 'bg-success/20 text-success',
  agent: 'bg-warning/20 text-warning'
}

export default function AtMentionAutocomplete({
  items,
  selectedIndex,
  onSelect,
  onHover,
  anchorLeft
}: Props): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
      <div
        ref={listRef}
        className="mx-3 rounded-lg border border-border-strong bg-popover shadow-xl overflow-y-auto"
        style={{ maxHeight: '320px' }}
      >
        {items.map((item, i) => (
          <button
            key={`${item.type}-${item.path}`}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(item)
            }}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
              i === selectedIndex ? 'bg-accent' : 'hover:bg-muted/40'
            }`}
          >
            <span className="text-xs text-foreground font-mono truncate flex-1" title={item.root ? item.path : undefined}>
              {item.label ?? item.path}
            </span>
            {item.root && (
              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {item.root}
              </span>
            )}
            <span
              className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm shrink-0 ${TYPE_STYLES[item.type] ?? ''}`}
            >
              {item.meta ?? item.type}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
