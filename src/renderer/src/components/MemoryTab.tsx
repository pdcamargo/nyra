import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { useUiStore } from '../store/ui'
import { openFileInPanel } from '../lib/openFile'
import type { ScopedList } from '../lib/api-types'
import type { LibraryItem } from './views/Library'
import {
  DialogAction,
  EmptyNote,
  LibraryCard,
  LibraryGrid,
  LibrarySearch,
  ProjectTabs,
  PreviewDialog,
  SectionHeading,
  matches,
  useScopedLibrary
} from './views/Library'

const TYPE_TONE: Record<NonNullable<MemoryType>, { fg: string; bg: string }> = {
  project: { fg: 'text-info/80', bg: 'bg-info/15' },
  feedback: { fg: 'text-warning/80', bg: 'bg-warning/15' },
  user: { fg: 'text-info/80', bg: 'bg-info/15' },
  reference: { fg: 'text-success/80', bg: 'bg-success/15' }
}

function formatRelative(mtime?: number): string {
  if (!mtime) return ''
  const diff = Date.now() - mtime
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  if (diff < min) return 'just now'
  if (diff < hr) return `${Math.floor(diff / min)}m ago`
  if (diff < day) return `${Math.floor(diff / hr)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  const d = new Date(mtime)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** The one file that belongs to nobody's project. */
const isGlobal = (f: MemoryFile): boolean => f.source === 'global-claude'

export default function MemoryTab(): React.JSX.Element {
  // The hook asks each project in turn; this is where each answer's memory
  // directory lands, because a new memory is written into the directory of the
  // project whose tab is open, not of the chat that happens to be running.
  const dirs = useRef<Record<string, string>>({})

  const listMemory = useCallback(async (cwd: string): Promise<ScopedList<MemoryFile>> => {
    const result = await window.api.memory.list(cwd)
    dirs.current[cwd] = result.projectMemoryDir ?? ''
    const files = result.files ?? []
    return { global: files.filter(isGlobal), project: files.filter((f) => !isGlobal(f)) }
  }, [])

  const { global, byProject, projects, activeId, setActiveId, reload } =
    useScopedLibrary(listMemory)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MemoryFile | null>(null)
  const pendingFilePath = useUiStore((s) => s.pendingMemoryFilePath)
  const consumePendingFile = useUiStore((s) => s.consumePendingMemoryFile)

  const activeProject = projects.find((p) => p.id === activeId)
  const cwd = activeProject?.path ?? ''
  const memoryDir = dirs.current[cwd] ?? ''

  const everything = useMemo(
    () => [...global, ...Object.values(byProject).flat()],
    [global, byProject]
  )

  // Honour cross-view "open this memory file" requests.
  useEffect(() => {
    if (!pendingFilePath) return
    const match = everything.find((f) => f.filePath === pendingFilePath)
    if (match) {
      setSelected(match)
      consumePendingFile()
    } else if (everything.length > 0) {
      // Not in the list yet — synthesize a placeholder so the editor still opens.
      const name = pendingFilePath.split('/').pop() ?? pendingFilePath
      setSelected({ filePath: pendingFilePath, source: 'subagent-claude', name, exists: true })
      consumePendingFile()
    }
  }, [pendingFilePath, everything, consumePendingFile])

  const card = (file: MemoryFile): React.JSX.Element => {
    const { name, description } = cardFor(file)
    const tone = file.memoryType ? TYPE_TONE[file.memoryType] : null
    return (
      <LibraryCard
        key={file.filePath}
        name={name}
        description={description}
        Icon={FileText}
        badge={
          tone ? (
            <span
              className={`shrink-0 rounded-sm px-1 py-px text-[0.62em] font-semibold ${tone.fg} ${tone.bg}`}
            >
              {file.memoryType}
            </span>
          ) : undefined
        }
        onClick={() => setSelected(file)}
      />
    )
  }

  const globalFiles = matches(global.map(withSearchText), query).map((f) => f.file)
  const projectFiles = matches(
    (activeId ? (byProject[activeId] ?? []) : []).map(withSearchText),
    query
  ).map((f) => f.file)

  return (
    <>
      <LibrarySearch value={query} onChange={setQuery} placeholder="Search memories" />

      <section className="mb-8">
        <SectionHeading trailing="~/.claude/CLAUDE.md">Global</SectionHeading>
        {globalFiles.length > 0 ? (
          <LibraryGrid>{globalFiles.map(card)}</LibraryGrid>
        ) : (
          <EmptyNote>{query ? 'Nothing matches here.' : 'Nothing global yet.'}</EmptyNote>
        )}
      </section>

      <section>
        <SectionHeading trailing={memoryDir || undefined}>By project</SectionHeading>
        <ProjectTabs projects={projects} activeId={activeId} onSelect={setActiveId} />
        {projects.length === 0 ? (
          <EmptyNote>Add a project and what Claude remembers about it shows up here.</EmptyNote>
        ) : projectFiles.length > 0 ? (
          <LibraryGrid>{projectFiles.map(card)}</LibraryGrid>
        ) : (
          <EmptyNote>
            {query
              ? 'Nothing matches here.'
              : 'Nothing yet. Memories appear as Claude records what it learns across sessions.'}
          </EmptyNote>
        )}
      </section>

      {selected && (
        <PreviewDialog
          open
          onClose={() => setSelected(null)}
          name={cardFor(selected).name}
          description={cardFor(selected).description}
          filePath={selected.filePath}
          kind="Memory"
          // Only a memory entry. The CLAUDE.md anchors are files someone wrote
          // on purpose and the index is generated from the entries; neither is
          // something to remove from a preview by accident.
          onDelete={
            selected.source === 'project-memory' && !selected.isIndex && selected.exists
              ? async () => {
                  await window.api.memory.delete(selected.filePath, cwd)
                  reload()
                }
              : undefined
          }
          actions={
            <DialogAction
              onClick={() => {
                openFileInPanel(selected.filePath)
                setSelected(null)
              }}
            >
              Open file
            </DialogAction>
          }
        />
      )}
    </>
  )
}

/** `matches` filters on name and description, and a memory file's own `name` is
 *  a filename — so it is filtered on what the card actually shows. */
function withSearchText(file: MemoryFile): LibraryItem & { file: MemoryFile } {
  const { name, description } = cardFor(file)
  return { name, description, filePath: file.filePath, file }
}

/**
 * How a memory file reads on a card.
 *
 * A memory entry has frontmatter, so it has a real description. The CLAUDE.md
 * anchors and the index do not — they are files, and what is worth knowing about
 * them is when they were last written and whether they exist at all.
 */
function cardFor(file: MemoryFile): { name: string; description: string } {
  if (file.source === 'project-memory' && !file.isIndex) {
    return {
      name: file.name
        .replace(/\.md$/, '')
        .replace(/^(project|feedback|user|reference)_/, '')
        .replace(/_/g, ' '),
      description: file.description || formatMeta(file)
    }
  }
  const anchors: Record<MemorySource, { name: string; description: string }> = {
    'project-memory': {
      name: 'MEMORY.md',
      description: 'The index Claude reads at the start of a session'
    },
    'project-claude': {
      name: './CLAUDE.md',
      description: file.exists ? formatMeta(file) : 'Missing — open to create it'
    },
    'global-claude': {
      name: '~/.claude/CLAUDE.md',
      description: file.exists ? formatMeta(file) : 'Missing — open to create it'
    },
    'subagent-claude': { name: file.name, description: '.claude/agents/' }
  }
  return anchors[file.source]
}

function formatMeta(file: MemoryFile): string {
  const parts: string[] = []
  if (file.mtime) parts.push(`edited ${formatRelative(file.mtime)}`)
  if (file.size) parts.push(`${(file.size / 1024).toFixed(1)} KB`)
  return parts.join(' · ')
}
