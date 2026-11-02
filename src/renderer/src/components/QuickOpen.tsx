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
import { useSessionsStore, activeCwd, activeProject, activeProjectCwd } from '../store/sessions'
import { openFileInPanel } from '../lib/openFile'
import { fuzzyFilter, highlightSegments } from '../lib/fuzzy'
import { basename, joinPath } from '../lib/paths'
import { folderRoots, type FolderRoot } from '../lib/folderRoots'

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

/** A file and the folder it was listed under; `path` is relative to it. */
type Entry = { root: FolderRoot; path: string }

/** `design-system/colors` searches only that linked folder, for `colors`. */
function scopeOf(roots: FolderRoot[], query: string): { root: FolderRoot; query: string } | null {
  const q = query.trimStart().toLowerCase()
  const root = roots.find((r) => !r.main && q.startsWith(`${r.name.toLowerCase()}/`))
  return root ? { root, query: query.trimStart().slice(root.name.length + 1) } : null
}

/** The filename, bolded where the query hit; the directory stays quiet behind it. */
function Row({ path, positions }: { path: string; positions: number[] }): React.JSX.Element {
  const cut = path.length - basename(path).length
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
  const [roots, setRoots] = useState<FolderRoot[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
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
    // Every folder of the project, the chat's own first so its files lead
    // the unfiltered list.
    const found = folderRoots(cwd, activeProject(state)?.linkedFolders)
    setRoots(found)
    if (!cwd) {
      setEntries([])
      setIsRepo(false)
      return
    }
    setLoading(true)
    // `git ls-files --cached --others --exclude-standard`, so .gitignore is
    // already applied and untracked files are in. A folder outside git is
    // walked instead.
    void Promise.all(
      found.map((root) =>
        window.api.fs
          .listProjectFiles(root.path, 20000)
          .then((res) => ({ root, res }))
          .catch(() => ({ root, res: { paths: [], truncated: false, isRepo: false } }))
      )
    )
      .then((lists) => {
        if (run !== runRef.current) return
        setEntries(lists.flatMap(({ root, res }) => res.paths.map((path) => ({ root, path }))))
        setTruncated(lists.some(({ res }) => res.truncated))
        setIsRepo(lists[0]?.res.isRepo ?? false)
      })
      .finally(() => {
        if (run === runRef.current) setLoading(false)
      })
  }, [open])

  const scope = useMemo(() => scopeOf(roots, query), [roots, query])
  const results = useMemo(
    () =>
      fuzzyFilter(
        scope ? entries.filter((e) => e.root === scope.root) : entries,
        scope ? scope.query : query,
        (e) => e.path,
        MAX_ROWS
      ),
    [entries, query, scope]
  )

  const choose = (entry: Entry) => (): void => {
    closeQuickOpen()
    // The chat's own files stay relative, as they always were; a linked
    // folder's are only meaningful whole.
    const path = entry.root.main ? entry.path : joinPath(entry.root.path, entry.path)
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
              : entries.length === 0 && !isRepo
                ? 'Quick-open lists files from git, and this folder is not a repository.'
                : entries.length === 0
                  ? 'This project has no files yet.'
                  : `Nothing matches “${query}”.`}
          </CommandEmpty>

          {/* Inside a group even though there is only one and it has no heading.
              cmdk registers items through the group context; rendered bare in
              the list they all came back `data-selected`, so nothing highlighted
              and the arrow keys had no current row to move from. */}
          <CommandGroup>
            {results.map(({ item, positions }) => (
              <CommandItem
                key={`${item.root.path}\0${item.path}`}
                value={`${item.root.path}\0${item.path}`}
                onSelect={choose(item)}
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <Row path={item.path} positions={positions} />
                {!item.root.main && (
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 font-mono text-c-sm text-muted-foreground">
                    {item.root.name}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>

          {/* Say so rather than quietly ranking a subset: on a repo past the cap
              the file you want may genuinely not be in the list. */}
          {truncated && (
            <p className="px-3 py-2 text-c-sm text-muted-foreground">
              Showing the first 20,000 files in each folder.
            </p>
          )}
        </CommandList>
        {roots.length > 1 && (
          <p className="border-t border-border/55 px-3 py-2 text-c-sm text-muted-foreground">
            {scope ? (
              <>Searching {scope.root.name} only</>
            ) : (
              <>
                Start with{' '}
                <span className="font-mono text-foreground">{roots.find((r) => !r.main)?.name}/</span> to search one
                folder
              </>
            )}
          </p>
        )}
      </Command>
    </CommandDialog>
  )
}
