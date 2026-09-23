import React, { useState, useEffect, useRef, useCallback } from 'react'
import { noteCustomCommands, noteSkills, slashCommands } from '../lib/slashCommands'

export type AutocompleteItem = {
  name: string
  description: string
  type: 'skill' | 'command'
}

/** Reads one scope of a scoped list, or nothing when the backend is not up. */
const read = async <T,>(fn: () => Promise<{ global: T[]; project: T[] }>): Promise<T[]> => {
  try {
    const list = await fn()
    return [...list.project, ...list.global]
  } catch {
    return []
  }
}

/**
 * The completable commands, filtered by what has been typed after the slash.
 *
 * The list is `lib/slashCommands`' index — built-ins, the CLI's own report,
 * skills and custom commands in one place — and this hook is what keeps it in
 * step with the disk. Nodes are re-read when the popup opens and whenever
 * something says a skill or a command changed, so one added a moment ago
 * completes without a restart.
 */
export function useSlashItems(query: string, cwd: string): AutocompleteItem[] {
  // The index is module state, not React state, so its revision is what a
  // re-render hangs off. The number itself is never read.
  const [, setRevision] = useState(0)
  const live = useRef(true)

  const refresh = useCallback((): void => {
    void Promise.all([
      read(() => window.api.skills.list(cwd)),
      read(() => window.api.commands.list(cwd))
    ]).then(([skills, commands]) => {
      if (!live.current) return
      noteSkills(skills)
      noteCustomCommands(commands)
      setRevision((n) => n + 1)
    })
  }, [cwd])

  // Re-fetch skills each time the autocomplete opens (query becomes non-empty)
  // so newly created skills appear without needing a restart
  useEffect(() => {
    if (query) refresh()
  }, [query !== '', refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    live.current = true
    refresh()
    const onChanged = (): void => refresh()
    window.addEventListener('nyra:skills-changed', onChanged)
    window.addEventListener('nyra:commands-changed', onChanged)
    return () => {
      live.current = false
      window.removeEventListener('nyra:skills-changed', onChanged)
      window.removeEventListener('nyra:commands-changed', onChanged)
    }
  }, [refresh])

  const q = query.toLowerCase()
  return slashCommands()
    .filter((c) => c.name.slice(1).toLowerCase().includes(q))
    .map((c) => ({
      name: c.name.slice(1),
      description: c.description,
      type: c.kind
    }))
}

type Props = {
  items: AutocompleteItem[]
  selectedIndex: number
  onSelect: (item: AutocompleteItem) => void
  onHover: (index: number) => void
}

export default function SlashAutocomplete({ items, selectedIndex, onSelect, onHover }: Props): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll selected item into view
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
            key={`${item.type}-${item.name}`}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(item)
            }}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
              i === selectedIndex ? 'bg-accent' : 'hover:bg-muted/40'
            }`}
          >
            <span className="text-xs text-foreground font-medium shrink-0">/{item.name}</span>
            <span
              className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                item.type === 'skill'
                  ? 'bg-info/20 text-info'
                  : 'bg-accent/50 text-muted-foreground'
              }`}
            >
              {item.type === 'skill' ? 'skill' : 'cmd'}
            </span>
            <span className="text-[11px] text-muted-foreground truncate">{item.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
