import React, { useEffect, useState } from 'react'
import { Check, Folder, GitBranch, Laptop, Plus, Search } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { useSessionsStore, findProject } from '../store/sessions'
import { newPendingWorktree } from '../lib/worktrees'

/**
 * Where this chat will run, offered above the composer before it starts.
 *
 * Codex puts this here and shapes it as three chips — project, environment,
 * branch — because isolation has to be decided up front: a Claude process is
 * spawned with a fixed working directory and cannot be moved afterwards, and it
 * runs under bypassPermissions, so by the time a write is observed it has
 * already landed in the main checkout.
 */
function Chip({
  icon,
  label,
  muted
}: {
  icon: React.ReactNode
  label: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <span
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ${
        muted ? 'text-muted-foreground' : 'text-foreground'
      }`}
    >
      {icon}
      <span className="max-w-[180px] truncate">{label}</span>
    </span>
  )
}

const TRIGGER =
  'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-accent/50 aria-expanded:bg-accent'

export default function NewChatEnvironment({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  const project = useSessionsStore((s) => findProject(s, session?.projectId))
  const [branches, setBranches] = useState<string[]>([])
  const [isRepo, setIsRepo] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [currentBranch, setCurrentBranch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pending = session?.pendingWorktree ?? null

  useEffect(() => {
    let cancelled = false
    if (!project?.path) {
      setIsRepo(false)
      return
    }
    void window.api.git.isRepo(project.path).then((repo) => {
      if (!cancelled) setIsRepo(repo)
    })
    void window.api.git.branchList(project.path).then((list) => {
      if (!cancelled) setBranches(list)
    })
    void window.api.git.branch(project.path).then((b) => {
      if (!cancelled) setCurrentBranch(b)
    })
    return () => {
      cancelled = true
    }
  }, [project?.path])

  // Only a git project can offer isolation, and only before the chat has run.
  if (!session || !project || !isRepo || session.worktree || session.messages.length > 0) return null

  const setPending = useSessionsStore.getState().setPendingWorktree
  const isWorktree = pending !== null
  const baseRef = isWorktree
    ? pending.baseRef || currentBranch || 'current branch'
    : currentBranch || 'current branch'

  /**
   * In a worktree the branch is what to fork from, so picking one is just state.
   * Locally there is nothing to fork — the chat runs in the checkout you are in —
   * so picking one has to actually move the checkout.
   */
  const pickBranch = async (branch: string): Promise<void> => {
    setError(null)
    if (isWorktree && pending) {
      setPending(sessionId, { ...pending, baseRef: branch })
      return
    }
    const res = await window.api.git.checkout(project.path, branch)
    if (res.success) setCurrentBranch(branch)
    else setError(res.error ?? 'Could not switch branch')
  }

  const createBranch = async (): Promise<void> => {
    const name = newBranch.trim()
    if (!name) return
    setError(null)
    if (isWorktree && pending) {
      // Nothing to create yet: the worktree and its branch appear together on
      // the first message.
      setPending(sessionId, { ...pending, branch: name })
      setNewBranch('')
      return
    }
    const res = await window.api.git.checkout(project.path, name, true)
    if (res.success) {
      setCurrentBranch(name)
      setBranches((prev) => [name, ...prev.filter((b) => b !== name)])
      setNewBranch('')
    } else {
      setError(res.error ?? 'Could not create branch')
    }
  }
  const shownBranches = branchQuery
    ? branches.filter((b) => b.toLowerCase().includes(branchQuery.toLowerCase()))
    : branches

  return (
    // Docked to the top of the composer, so it reads as part of it.
    <div className="-mb-3 ml-4 flex w-fit items-center gap-0.5 rounded-t-lg border border-b-0 border-border bg-background px-2 pb-4 pt-1 dark:border-muted dark:bg-muted">
      <Chip icon={<Folder className="size-3.5 text-muted-foreground" />} label={project.name} />

      <DropdownMenu>
        <DropdownMenuTrigger className={TRIGGER} aria-label="Where this chat runs">
          <Laptop className="size-3.5 text-muted-foreground" />
          {isWorktree ? 'Worktree' : 'Local'}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuLabel>Work in</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setPending(sessionId, null)}>
            <Laptop />
            Local
            {!isWorktree && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPending(sessionId, newPendingWorktree())}>
            <GitBranch />
            New local worktree
            {isWorktree && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
          {isWorktree && pending && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Worktree branch</DropdownMenuLabel>
              <div className="px-1 pb-1">
                <input
                  value={pending.branch}
                  onChange={(e) => setPending(sessionId, { ...pending, branch: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
              </div>
              <DropdownMenuCheckboxItem
                checked={pending.seed}
                onCheckedChange={(checked) =>
                  setPending(sessionId, { ...pending, seed: checked === true })
                }
              >
                Carry uncommitted changes
              </DropdownMenuCheckboxItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu onOpenChange={(open) => !open && setBranchQuery('')}>
        <DropdownMenuTrigger className={TRIGGER} aria-label="Base branch">
          <GitBranch className="size-3.5 text-muted-foreground" />
          <span className="max-w-[180px] truncate">{baseRef}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72 p-0">
          <div className="flex items-center gap-2 border-b px-2.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={branchQuery}
              onChange={(e) => setBranchQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={`Search ${project.name} branches`}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Branches</p>
            {shownBranches.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No branches match</p>
            )}
            {shownBranches.map((b) => (
              <button
                key={b}
                onClick={() => void pickBranch(b)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50"
              >
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono text-foreground">{b}</span>
                {baseRef === b && <Check className="ml-auto size-3.5 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t p-1">
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') void createBranch()
                }}
                placeholder="Create and checkout new branch…"
                className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
              {newBranch.trim() && (
                <button
                  onClick={() => void createBranch()}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-foreground transition-colors hover:bg-accent/50"
                >
                  Create
                </button>
              )}
            </div>
            {error && <p className="px-2 pb-1 text-xs text-danger">{error}</p>}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

    </div>
  )
}
