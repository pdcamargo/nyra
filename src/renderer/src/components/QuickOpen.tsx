import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from './ui/command'
import { useUiStore } from '../store/ui'
import { useSessionsStore, activeCwd, activeProjectCwd } from '../store/sessions'
import { openFileInPanel } from '../lib/openFile'
import { fuzzyFilter, highlightSegments } from '../lib/fuzzy'

/**
 * Go to a file by typing part of its name.
 *
 * ⌘P used to append a blank file tab with an "Open file" empty state, which is
 * the one thing a quick-open makes unnecessary — you pressed it because you knew
 * which file you wanted. Now it asks.
 *
 * The whole list is fetched once per open and filtered in the renderer. The
 * alternative was `fs_search_tree` per keystroke, which spawns `git ls-files`
 * each time; on a repo this size that is a process per character to rank a list
 * that has not changed since the modal opened. It also could not do the ranking
 * we want — that scorer is substring-based, so "cmdpal" finds nothing.
 *
 * It fetches through `fs_list_files`, not `fs_search_tree` with an empty query:
 * search treats an empty needle as "nothing matches" and returns an empty list,
 * so asking it for everything reliably got nothing and the picker opened empty
 * in a repository full of files.
 */
const MAX_ROWS = 50

/** The filename, bolded where the query hit; the directory stays quiet behind it. */
function Row({ path, positions }: { path: string; positions: number[] }): React.JSX.Element {
  const cut = path.lastIndexOf('/') + 1
  const dir = path.slice(0, cut)
  const name = path.slice(cut)

  // Positions index the whole path, so the name's runs need rebasing onto it.
  const nameHits = positions.filter((i) => i >= cut).map((i) => i - cut)
  const dirHits = positions.filter((i) => i < cut)

  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 truncate">
        {highlightSegments(name, nameHits).map((seg, i) => (
          <span key={i} className={seg.match ? 'font-semibold text-info' : undefined}>
            {seg.text}
          </span>
        ))}
      </span>
      {dir && (
        <span className="min-w-0 flex-1 truncate text-right text-c-sm text-muted-foreground">
          {highlightSegments(dir, dirHits).map((seg, i) => (
            <span key={i} className={seg.match ? 'text-info' : undefined}>
              {seg.text}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

export default function QuickOpen(): React.JSX.Element {
  const open = useUiStore((s) => s.quickOpenOpen)
  const closeQuickOpen = useUiStore((s) => s.closeQuickOpen)
  const [query, setQuery] = useState('')
  const [paths, setPaths] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [isRepo, setIsRepo] = useState(true)

  // A stale response from the previous open must not land in this one.
  const runRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    const run = ++runRef.current
    // The chat's own directory when it has one, otherwise the project it sits
    // in. Opening the picker from a chat that has not chosen a directory yet
    // should still find the project's files rather than nothing at all.
    const state = useSessionsStore.getState()
    const cwd = activeCwd(state) || activeProjectCwd(state)
    if (!cwd) {
      setPaths([])
      setIsRepo(false)
      return
    }
    setLoading(true)
    // `git ls-files --cached --others --exclude-standard`, so .gitignore is
    // already applied and untracked files are in.
    void window.api.fs
      .listProjectFiles(cwd, 20000)
      .then((res) => {
        if (run !== runRef.current) return
        setPaths(res.paths)
        setTruncated(res.truncated)
        setIsRepo(res.isRepo)
      })
      .catch(() => {
        if (run === runRef.current) {
          setPaths([])
          setIsRepo(false)
        }
      })
      .finally(() => {
        if (run === runRef.current) setLoading(false)
      })
  }, [open])

  const results = useMemo(
    () => fuzzyFilter(paths, query, (p) => p, MAX_ROWS),
    [paths, query]
  )

  const choose = (path: string) => (): void => {
    closeQuickOpen()
    // Let the dialog unmount before the panel takes focus.
    setTimeout(() => openFileInPanel(path), 0)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => !next && closeQuickOpen()}
      title="Go to file"
      description="Find a file in this project by name"
      className="max-w-xl"
    >
      {/* Ours to supply, and ours to switch off: cmdk's own filter is substring
          over the rendered value, which is the thing `fuzzy.ts` exists to beat. */}
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Go to file…"
        />
        <CommandList>
          {/* Three different silences, and they are not interchangeable: still
              reading, nothing to read, and nothing matching what you typed. The
              middle one used to claim the chat was not in a git repository,
              which was both wrong and the only explanation on offer. */}
          <CommandEmpty>
            {loading
              ? 'Reading files…'
              : !isRepo
                ? 'Quick-open lists files from git, and this folder is not a repository.'
                : paths.length === 0
                  ? 'This project has no files yet.'
                  : `Nothing matches “${query}”.`}
          </CommandEmpty>

          {/* Inside a group even though there is only one and it has no heading.
              cmdk registers items through the group context; rendered bare in
              the list they all came back `data-selected`, so nothing highlighted
              and the arrow keys had no current row to move from. */}
          <CommandGroup>
            {results.map(({ item, positions }) => (
              <CommandItem key={item} value={item} onSelect={choose(item)}>
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <Row path={item} positions={positions} />
              </CommandItem>
            ))}
          </CommandGroup>

          {/* Say so rather than quietly ranking a subset: on a repo past the cap
              the file you want may genuinely not be in the list. */}
          {truncated && (
            <p className="px-3 py-2 text-c-sm text-muted-foreground">
              Showing the first 20,000 files in this project.
            </p>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
