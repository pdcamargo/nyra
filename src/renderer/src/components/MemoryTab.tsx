import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, FileText, RefreshCw, Search } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { installMonacoEnvironment } from '../lib/monacoEnv'
import { useSessionsStore } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { useMonacoNyraTheme } from '../hooks/useMonacoNyraTheme'
import MarkdownRenderer from './MarkdownRenderer'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

installMonacoEnvironment()

const SOURCE_ORDER: MemorySource[] = ['project-memory', 'project-claude', 'global-claude', 'subagent-claude']
const SOURCE_LABEL: Record<MemorySource, string> = {
  'project-memory': 'PROJECT MEMORY',
  'project-claude': 'CLAUDE.MD',
  'global-claude': 'CLAUDE.MD',
  'subagent-claude': 'SUBAGENTS'
}

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

export default function MemoryTab(): React.JSX.Element {
  const cwd = useSessionsStore(
    (s) => s.sessions.find((sess) => sess.id === s.activeSessionId)?.cwd ?? ''
  )

  const [files, setFiles] = useState<MemoryFile[]>([])
  const [memoryDir, setMemoryDir] = useState('')
  const [selected, setSelected] = useState<MemoryFile | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const pendingFilePath = useUiStore((s) => s.pendingMemoryFilePath)
  const consumePendingFile = useUiStore((s) => s.consumePendingMemoryFile)

  const refresh = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    try {
      const result = await window.api.memory.list(cwd)
      setFiles(result.files ?? [])
      setMemoryDir(result.projectMemoryDir ?? '')
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Honor cross-tab "open this memory file" requests.
  useEffect(() => {
    if (!pendingFilePath) return
    const match = files.find((f) => f.filePath === pendingFilePath)
    if (match) {
      setSelected(match)
      consumePendingFile()
    } else if (files.length > 0) {
      // File not in list yet — synthesize a placeholder so the editor still opens.
      const name = pendingFilePath.split('/').pop() ?? pendingFilePath
      setSelected({
        filePath: pendingFilePath,
        source: 'subagent-claude',
        name,
        exists: true
      })
      consumePendingFile()
    }
  }, [pendingFilePath, files, consumePendingFile])

  if (!cwd) {
    return (
      <div className="flex-1 p-3">
        <p className="text-[11px] text-muted-foreground/70 text-center mt-4">No active session</p>
      </div>
    )
  }

  if (selected) {
    return (
      <MemoryEditor
        file={selected}
        cwd={cwd}
        onBack={() => {
          setSelected(null)
          refresh()
        }}
        onDelete={async () => {
          await window.api.memory.delete(selected.filePath, cwd)
          setSelected(null)
          refresh()
        }}
      />
    )
  }

  const filtered = files.filter((f) => {
    if (!query) return true
    const q = query.toLowerCase()
    return (
      f.name.toLowerCase().includes(q) ||
      (f.description?.toLowerCase().includes(q) ?? false)
    )
  })

  const grouped = SOURCE_ORDER.map((source) => ({
    source,
    files: filtered.filter((f) => f.source === source)
  }))

  return (
    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
      <div className="flex items-center gap-1.5 rounded-md bg-muted/40 border border-border/55 px-2 py-1.5">
        <Search className="size-3 text-muted-foreground/70 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          className="flex-1 bg-transparent text-[11px] text-foreground/80 placeholder:text-muted-foreground/70 outline-hidden font-mono"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={refresh}
              className="p-0.5 rounded-sm hover:bg-accent/50 text-muted-foreground/70 hover:text-muted-foreground"
              aria-label="Reload"
            >
              <RefreshCw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Reload</TooltipContent>
        </Tooltip>
      </div>

      {loading && files.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70 text-center mt-4">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState onCreate={() => setSelected(makeNewMemoryDraft(memoryDir))} />
      ) : (
        grouped.map((group, idx) => {
          if (group.files.length === 0) return null
          const showHeader =
            idx === 0 ||
            SOURCE_LABEL[group.source] !== SOURCE_LABEL[grouped[idx - 1]?.source]
          return (
            <div key={group.source} className="flex flex-col gap-1.5">
              {showHeader && (
                <div className="flex items-center justify-between px-1">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {SOURCE_LABEL[group.source]}
                  </p>
                  {group.source === 'project-memory' && (
                    <button
                      onClick={() => setSelected(makeNewMemoryDraft(memoryDir))}
                      className="text-[9px] font-semibold tracking-wider text-info/70 hover:text-info"
                    >
                      + NEW
                    </button>
                  )}
                </div>
              )}
              {group.files.map((file) => (
                <MemoryRow key={file.filePath} file={file} onSelect={() => setSelected(file)} />
              ))}
            </div>
          )
        })
      )}
    </div>
  )
}

function makeNewMemoryDraft(memoryDir: string): MemoryFile {
  return {
    filePath: `${memoryDir}/new_memory.md`,
    source: 'project-memory',
    name: 'new_memory.md',
    exists: false
  }
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-12 text-center">
      <div className="h-10 w-10 rounded-full bg-muted/40 border border-border/55 flex items-center justify-center text-muted-foreground">
        <FileText className="size-4" />
      </div>
      <p className="text-xs text-foreground/80">No memories yet</p>
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed max-w-[200px]">
        Memories appear here when Claude records learnings across sessions.
      </p>
      <button
        onClick={onCreate}
        className="mt-2 px-2.5 py-1 rounded-sm bg-accent/50 hover:bg-accent border border-border/55 text-[10px] font-medium text-foreground/80 hover:text-foreground transition-colors"
      >
        + New memory
      </button>
    </div>
  )
}

function MemoryRow({
  file,
  onSelect
}: {
  file: MemoryFile
  onSelect: () => void
}): React.JSX.Element {
  if (file.source === 'project-memory' && !file.isIndex) {
    return <MemoryEntryRow file={file} onSelect={onSelect} />
  }
  return <FileAnchorRow file={file} onSelect={onSelect} />
}

function MemoryEntryRow({
  file,
  onSelect
}: {
  file: MemoryFile
  onSelect: () => void
}): React.JSX.Element {
  const tone = file.memoryType ? TYPE_TONE[file.memoryType] : null
  const displayName = file.name.replace(/\.md$/, '').replace(/^(project|feedback|user|reference)_/, '').replace(/_/g, ' ')
  return (
    <button
      onClick={onSelect}
      className="text-left rounded-md px-2 py-1.5 bg-muted/40 hover:bg-accent/50 border border-border/55 hover:border-border transition-colors"
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        {tone && (
          <span className={`px-1 py-px rounded-sm text-[8px] font-semibold ${tone.fg} ${tone.bg}`}>
            {file.memoryType}
          </span>
        )}
        <span className="text-[11px] text-foreground/80 truncate">{displayName}</span>
      </div>
      {file.description && (
        <p className="text-[9px] text-muted-foreground/70 leading-snug line-clamp-2">{file.description}</p>
      )}
    </button>
  )
}

function FileAnchorRow({
  file,
  onSelect
}: {
  file: MemoryFile
  onSelect: () => void
}): React.JSX.Element {
  const labels: Record<MemorySource, { primary: string; secondary: (f: MemoryFile) => string }> = {
    'project-memory': { primary: 'MEMORY.md (index)', secondary: () => 'project memory index' },
    'project-claude': { primary: 'Project · ./CLAUDE.md', secondary: (f) => f.exists ? formatMeta(f) : 'missing — click to create' },
    'global-claude': { primary: 'Global · ~/.claude/CLAUDE.md', secondary: (f) => f.exists ? formatMeta(f) : 'missing — click to create' },
    'subagent-claude': { primary: file.name, secondary: () => '.claude/agents/' }
  }
  const { primary, secondary } = labels[file.source]
  return (
    <button
      onClick={onSelect}
      className="text-left rounded-md px-2 py-1.5 hover:bg-accent/50 transition-colors flex items-center gap-2"
    >
      <span className="text-muted-foreground/70 shrink-0">
        <FileText className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-foreground/80 truncate">{primary}</p>
        <p className="text-[9px] text-muted-foreground/70 truncate font-mono">{secondary(file)}</p>
      </div>
    </button>
  )
}

function formatMeta(file: MemoryFile): string {
  const parts: string[] = []
  if (file.mtime) parts.push(`edited ${formatRelative(file.mtime)}`)
  if (file.size) parts.push(`${(file.size / 1024).toFixed(1)} KB`)
  return parts.join(' · ')
}

function MemoryEditor({
  file,
  cwd,
  onBack,
  onDelete
}: {
  file: MemoryFile
  cwd: string
  onBack: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [content, setContent] = useState<string>('')
  const [original, setOriginal] = useState<string>('')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { defined: themeDefined, theme } = useMonacoNyraTheme()

  const dirty = content !== original

  useEffect(() => {
    let cancelled = false
    const init = async (): Promise<void> => {
      if (!file.exists) {
        const seed = file.source === 'project-memory'
          ? "---\nname: \ndescription: \ntype: \n---\n\n"
          : ''
        if (!cancelled) {
          setContent(seed)
          setOriginal(seed)
          setLoaded(true)
        }
        return
      }
      const result = await window.api.memory.read(file.filePath, cwd)
      if (cancelled) return
      if (result.error) {
        setError(result.error)
      } else {
        setContent(result.content ?? '')
        setOriginal(result.content ?? '')
      }
      setLoaded(true)
    }
    init()
    return () => {
      cancelled = true
    }
  }, [file, cwd])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    const result = await window.api.memory.write(file.filePath, content, cwd)
    setSaving(false)
    if (result.error) {
      setError(result.error)
    } else {
      setOriginal(content)
    }
  }, [file, content, cwd])

  const canDelete = file.source === 'project-memory' && !file.isIndex && file.exists

  const headerLabel = useMemo(() => file.name, [file])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-2 border-b border-border/55">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onBack}
              className="p-0.5 rounded-sm hover:bg-accent/50 text-foreground/80 hover:text-foreground"
              aria-label="Back"
            >
              <ChevronLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>
        <span className="text-[11px] font-medium text-foreground truncate flex-1" title={file.filePath}>
          {headerLabel}
        </span>
        {dirty && <span className="text-[9px] text-warning/70 shrink-0">●</span>}
      </div>

      <div className="flex items-center justify-between gap-2 px-3">
        <div className="flex bg-muted/40 border border-border/55 rounded-sm p-0.5 gap-0.5">
          <button
            onClick={() => setMode('edit')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              mode === 'edit' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground/80'
            }`}
          >
            Edit
          </button>
          <button
            onClick={() => setMode('preview')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              mode === 'preview' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground/80'
            }`}
          >
            Preview
          </button>
        </div>
        <div className="flex items-center gap-1">
          {canDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onDelete}
                  className="px-1.5 py-0.5 rounded-sm hover:bg-danger/10 text-muted-foreground/70 hover:text-danger text-[10px] font-medium transition-colors"
                >
                  Delete
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete memory</TooltipContent>
            </Tooltip>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              !dirty || saving
                ? 'bg-accent/50 text-muted-foreground/70 cursor-not-allowed'
                : 'bg-info text-info-foreground hover:bg-info'
            }`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 px-2 py-1 rounded-sm bg-danger/10 border border-danger/20 text-[10px] text-danger/80 font-mono">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 px-3 pb-3 overflow-hidden">
        {!loaded ? (
          <p className="text-[11px] text-muted-foreground/70 text-center mt-4">Loading…</p>
        ) : mode === 'edit' ? (
          <div className="h-full rounded-sm border border-border/55 overflow-hidden">
            {themeDefined && (
              <Editor
                value={content}
                onChange={(v) => setContent(v ?? '')}
                language="markdown"
                theme={theme}
                options={{
                  fontSize: 12,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  folding: false,
                  glyphMargin: false,
                  lineDecorationsWidth: 0,
                  lineNumbersMinChars: 3,
                  overviewRulerBorder: false,
                  scrollbar: {
                    vertical: 'auto',
                    horizontal: 'auto',
                    verticalScrollbarSize: 4,
                    horizontalScrollbarSize: 4
                  }
                }}
              />
            )}
          </div>
        ) : (
          <div className="h-full overflow-auto rounded-sm border border-border/55 bg-card p-3">
            <MarkdownRenderer>{content || '*(empty)*'}</MarkdownRenderer>
          </div>
        )}
      </div>
    </div>
  )
}
