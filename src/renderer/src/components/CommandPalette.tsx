import React, { useEffect, useMemo, useState } from 'react'
import { Frame, GitBranch, History, MessageSquare, SwatchBook } from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from './ui/command'
import { useUiStore } from '../store/ui'
import { useSessionsStore } from '../store/sessions'
import { collectPromptHistory, searchSessions } from '../lib/search'
import { COMMANDS, runCommand } from '../commands/registry'
import { fuzzyFilter } from '../lib/fuzzy'
import { CommandKbd } from './ui/kbd'
import { openDesignInPanel, openSystemInPanel } from '../lib/openFile'
import { basename } from '../lib/paths'
import type { DesignEntry, SystemEntry } from '../lib/api-types'

/** A design or design system, as the palette lists it. */
type DesignHit = { key: string; name: string; project: string; system: boolean; open: () => void }

/**
 * One search surface instead of three.
 *
 * This replaces SessionSearch and HistorySearch, which were separate modals with
 * separate shortcuts and separate ideas about keyboard handling. Chats, past
 * prompts and the app's own actions all answer the same question — "take me to
 * the thing I mean" — so they belong behind one input.
 */
export default function CommandPalette(): React.JSX.Element {
  const open = useUiStore((s) => s.paletteOpen)
  const mode = useUiStore((s) => s.paletteMode)
  const closePalette = useUiStore((s) => s.closePalette)
  const ui = useUiStore.getState
  const sessions = useSessionsStore((s) => s.sessions)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open) setQuery('')
  }, [open, mode])

  const matches = useMemo(() => searchSessions(sessions, query).slice(0, 8), [sessions, query])
  const history = useMemo(() => {
    const all = collectPromptHistory(sessions)
    const q = query.trim().toLowerCase()
    const filtered = q ? all.filter((i) => i.text.toLowerCase().includes(q)) : all
    return filtered.slice(0, mode === 'history' ? 20 : 5)
  }, [sessions, query, mode])

  const run = (fn: () => void) => () => {
    closePalette()
    // Let the dialog unmount before anything steals focus back.
    setTimeout(fn, 0)
  }

  // The palette used to keep its own copy of this list, with its own hardcoded
  // ⌘-glyph strings beside four of the entries. Both are the registry's job now,
  // so a rebind shows up here without anyone remembering to update it.
  //
  // Matched on `id` as well as `label`, and fuzzily: "gtf" should reach "Go to
  // file", and typing the id you half-remember should work too. The old filter
  // was `label.includes(query)` with no ranking at all, so registry order
  // decided which of several matches you saw first.
  const actions = useMemo(() => {
    const all = COMMANDS.filter((c) => c.palette)
    return fuzzyFilter(all, query, (c) => `${c.label} ${c.id}`).map((r) => r.item)
  }, [query])

  // Every design Nyra knows, in any project, read when the palette opens:
  // "billing" should reach the Billing design without knowing where it lives.
  const [designs, setDesigns] = useState<{ systems: SystemEntry[]; drafts: DesignEntry[] }>({ systems: [], drafts: [] })
  useEffect(() => {
    if (!open || mode !== 'all') return
    let live = true
    void Promise.all([window.api.designSystem.list(), window.api.design.list()]).then(([systems, drafts]) => {
      if (live) setDesigns({ systems, drafts })
    })
    return () => {
      live = false
    }
  }, [open, mode])
  const designHits = useMemo(() => {
    if (!query.trim()) return []
    const all: DesignHit[] = [
      ...designs.systems.map((s) => ({
        key: s.id,
        name: s.name,
        project: basename(s.project),
        system: true,
        open: () => void openSystemInPanel(s.id)
      })),
      ...designs.drafts.map((d) => ({
        key: d.id,
        name: d.name,
        project: basename(d.project),
        system: false,
        open: () => void openDesignInPanel(d.path)
      }))
    ]
    return fuzzyFilter(all, query, (d) => `${d.name} ${d.project}`, 6).map((r) => r.item)
  }, [designs, query])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => !next && closePalette()}
      title="Command palette"
      description="Search chats and past prompts, or run an action"
      className="max-w-xl"
    >
      {/* CommandDialog drops its children straight into the dialog, so the
          cmdk root is ours to supply — which is also where filtering is turned
          off. cmdk's fuzzy filter would fight searchSessions, which already
          ranks title matches above transcript ones. */}
      <Command shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={mode === 'history' ? 'Search your past prompts…' : 'Search chats, designs and actions…'}
      />
      <CommandList>
        <CommandEmpty>Nothing matches that.</CommandEmpty>

        {mode === 'all' && (
          <CommandGroup heading="Actions">
            {actions
              .map((action) => {
                const Icon = action.icon!
                return (
                  <CommandItem key={action.id} value={action.id} onSelect={run(() => void runCommand(action.id))}>
                    <Icon className="size-4" />
                    {action.label}
                    <CommandShortcut>
                      <CommandKbd id={action.id} />
                    </CommandShortcut>
                  </CommandItem>
                )
              })}
          </CommandGroup>
        )}

        {mode === 'all' && matches.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              {matches.map(({ session, matchSource, snippet }) => (
                <CommandItem
                  key={session.id}
                  value={`chat-${session.id}`}
                  onSelect={run(() => useSessionsStore.getState().setActiveSession(session.id))}
                >
                  {session.worktree ? (
                    <GitBranch className="size-4" />
                  ) : (
                    <MessageSquare className="size-4" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{session.title}</span>
                    {matchSource === 'message' && (
                      <span className="block truncate text-muted-foreground">{snippet}</span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {mode === 'all' && designHits.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Designs">
              {designHits.map((d) => (
                <CommandItem key={d.key} value={`design-${d.key}`} onSelect={run(d.open)}>
                  {d.system ? <SwatchBook className="size-4" /> : <Frame className="size-4" />}
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {d.system ? 'Design system' : 'Design'} · {d.project}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {history.length > 0 && (
          <>
            {mode === 'all' && <CommandSeparator />}
            <CommandGroup heading="Past prompts">
              {history.map((item, i) => (
                <CommandItem
                  key={`${item.timestamp}-${i}`}
                  value={`history-${i}`}
                  onSelect={run(() => useUiStore.getState().prefillInput(item.text))}
                >
                  <History className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  )
}
