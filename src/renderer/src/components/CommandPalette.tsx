import React, { useEffect, useMemo, useState } from 'react'
import {
  Eraser,
  FolderPlus,
  GitBranch,
  History,
  LogIn,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  Receipt,
  Settings,
  ShieldCheck,
  SquareTerminal,
  TextQuote,
  Workflow
} from 'lucide-react'
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
import { useSessionsStore, createSiblingSession, openFolderAsProject } from '../store/sessions'
import { useWorkflowStore } from '../store/workflow'
import { collectPromptHistory, searchSessions } from '../lib/search'

type Action = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  shortcut?: string
  run: () => void
}

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

  const actions: Action[] = [
    {
      id: 'new-chat',
      label: 'New chat',
      icon: Plus,
      shortcut: '⌘N',
      run: () => createSiblingSession()
    },
    {
      id: 'add-project',
      label: 'Add project…',
      icon: FolderPlus,
      run: () =>
        void window.api.dialog.pickFolder().then((folder) => {
          if (folder) openFolderAsProject(folder)
        })
    },
    {
      id: 'clear',
      label: 'Clear conversation',
      icon: Eraser,
      run: () => {
        const { activeSessionId, clearMessages } = useSessionsStore.getState()
        if (activeSessionId) clearMessages(activeSessionId)
      }
    },
    {
      id: 'projects',
      label: 'Toggle projects panel',
      icon: PanelLeft,
      run: () => ui().toggleProjectsPanel()
    },
    {
      id: 'workspace',
      label: 'Toggle workspace panel',
      icon: PanelRight,
      run: () => ui().toggleRightPanel()
    },
    { id: 'summary', label: 'Toggle summary', icon: TextQuote, run: () => ui().toggleSummary() },
    {
      id: 'terminal',
      label: 'Toggle terminal',
      icon: SquareTerminal,
      shortcut: '⌘J',
      run: () => ui().toggleBottomPanel()
    },
    {
      id: 'canvas',
      label: 'Toggle workflow canvas',
      icon: Workflow,
      shortcut: '⌘⇧W',
      run: () => {
        const { isCanvasOpen, openCanvas, closeCanvas } = useWorkflowStore.getState()
        if (isCanvasOpen) closeCanvas()
        else openCanvas()
      }
    },
    { id: 'settings', label: 'Settings', icon: Settings, run: () => ui().setSettingsOpen(true) },
    {
      id: 'permissions',
      label: 'Tool permissions',
      icon: ShieldCheck,
      run: () => window.dispatchEvent(new Event('nyra:open-permissions'))
    },
    {
      id: 'stats',
      label: 'Usage and cost',
      icon: Receipt,
      run: () => window.dispatchEvent(new Event('nyra:open-stats'))
    },
    {
      id: 'login',
      label: 'Switch account',
      icon: LogIn,
      run: () => window.dispatchEvent(new Event('nyra:open-login'))
    }
  ]

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => !next && closePalette()}
      title="Command palette"
      description="Search chats and past prompts, or run an action"
    >
      {/* CommandDialog drops its children straight into the dialog, so the
          cmdk root is ours to supply — which is also where filtering is turned
          off. cmdk's fuzzy filter would fight searchSessions, which already
          ranks title matches above transcript ones. */}
      <Command shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={mode === 'history' ? 'Search your past prompts…' : 'Search chats and actions…'}
      />
      <CommandList>
        <CommandEmpty>Nothing matches that.</CommandEmpty>

        {mode === 'all' && (
          <CommandGroup heading="Actions">
            {actions
              .filter((a) => a.label.toLowerCase().includes(query.trim().toLowerCase()))
              .map((action) => (
                <CommandItem key={action.id} value={action.id} onSelect={run(action.run)}>
                  <action.icon className="size-4" />
                  {action.label}
                  {action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
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
