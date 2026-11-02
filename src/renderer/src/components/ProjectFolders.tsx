import React, { useState } from 'react'
import { FolderOpen, FolderSymlink, MessageSquareText, Pencil, Plus, Unlink } from 'lucide-react'
import { useSessionsStore, type Project } from '../store/sessions'
import { linkProblem, saveLinkedFolder, unlinkFolder } from '../lib/linkedFolders'
import { basename, samePath } from '../lib/paths'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** What the form is doing: linking a folder just picked, or editing one. */
type Editing = { mode: 'add'; path: string } | { mode: 'edit'; path: string }

/**
 * Project settings' Folders section: the main folder, where chats start, and
 * the ones linked to it.
 *
 * Linking is picker first, then an inline form for the optional note, so a
 * folder is never half-added: until Link folder is pressed nothing is saved.
 */
export default function ProjectFolders({ project }: { project: Project }): React.JSX.Element {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const linked = project.linkedFolders ?? []

  const pick = (then: (folder: string) => void): void => {
    void window.api.dialog.pickFolder().then((folder) => {
      if (folder) then(folder)
    })
  }

  const startLinking = (): void =>
    pick((folder) => {
      const why = linkProblem(project, folder)
      setProblem(why)
      if (!why) setEditing({ mode: 'add', path: folder })
    })

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between px-1 pt-1">
        <p className="text-[0.85em] text-muted-foreground">Folders</p>
        {linked.length > 0 && <p className="text-[0.8em] text-muted-foreground">Chats start in main</p>}
      </div>

      <FolderRow
        icon={FolderOpen}
        name={basename(project.path) || project.path}
        path={project.path}
        main
        trailing={
          <button
            type="button"
            className="shrink-0 text-[0.92em] font-medium text-info hover:underline"
            onClick={() =>
              pick((folder) => useSessionsStore.getState().setProjectPath(project.id, folder))
            }
          >
            Change…
          </button>
        }
      />

      {linked.map((folder) =>
        editing?.mode === 'edit' && samePath(editing.path, folder.path) ? (
          <LinkedFolderForm
            key={folder.path}
            project={project}
            path={folder.path}
            note={folder.note ?? ''}
            mode="edit"
            onDone={() => setEditing(null)}
          />
        ) : (
          <FolderRow
            key={folder.path}
            icon={FolderSymlink}
            name={basename(folder.path) || folder.path}
            path={folder.path}
            note={folder.note}
            trailing={
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/folder:opacity-100 group-focus-within/folder:opacity-100">
                <RowAction label="Edit note" onClick={() => setEditing({ mode: 'edit', path: folder.path })}>
                  <Pencil className="size-3.5" />
                </RowAction>
                <RowAction label="Unlink" onClick={() => unlinkFolder(project.id, folder.path)}>
                  <Unlink className="size-3.5" />
                </RowAction>
              </span>
            }
          />
        )
      )}

      {editing?.mode === 'add' ? (
        <LinkedFolderForm
          project={project}
          path={editing.path}
          note=""
          mode="add"
          onChangePath={(path) => setEditing({ mode: 'add', path })}
          onDone={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          onClick={startLinking}
          className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-2 py-1.5 text-left text-[0.92em] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-4 shrink-0" />
          Link a folder…
        </button>
      )}
      {problem && <p className="px-1 text-[0.85em] text-warning">{problem}</p>}
    </div>
  )
}

function FolderRow({
  icon: Icon,
  name,
  path,
  note,
  main = false,
  trailing
}: {
  icon: React.ComponentType<{ className?: string }>
  name: string
  path: string
  note?: string
  main?: boolean
  trailing: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group/folder flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[0.92em] font-medium text-foreground">{name}</span>
          {main && <MainChip />}
        </div>
        <p className="truncate font-mono text-[0.85em] text-muted-foreground" title={path}>
          {path}
        </p>
        {note && (
          <p className="mt-1 flex items-start gap-1.5 text-[0.85em] text-muted-foreground" title={note}>
            <MessageSquareText className="mt-[0.2em] size-3 shrink-0" />
            <span className="line-clamp-2">{note}</span>
          </p>
        )}
      </div>
      {trailing}
    </div>
  )
}

export function MainChip(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-sm bg-info/10 px-1.5 font-mono text-[0.8em] text-info">main</span>
  )
}

function RowAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="rounded-at-4 p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The note for a linked folder, and the buttons that commit it. `add` saves a
 * new link; `edit` rewrites the note and can unlink.
 */
export function LinkedFolderForm({
  project,
  path,
  note: initialNote,
  mode,
  onChangePath,
  onDone
}: {
  project: Project
  path: string
  note: string
  mode: 'add' | 'edit'
  /** Offered while adding: pick a different folder before linking. */
  onChangePath?: (path: string) => void
  onDone: () => void
}): React.JSX.Element {
  const [note, setNote] = useState(initialNote)
  const [problem, setProblem] = useState<string | null>(null)

  const save = (): void => {
    saveLinkedFolder(project.id, path, note, mode === 'edit' ? path : undefined)
    onDone()
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-strong bg-muted/40 p-3">
      <div className="flex items-start gap-2">
        <FolderSymlink className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.92em] font-medium text-foreground">{basename(path) || path}</p>
          <p className="truncate font-mono text-[0.85em] text-muted-foreground" title={path}>
            {path}
          </p>
        </div>
        {mode === 'add' && onChangePath && (
          <button
            type="button"
            className="shrink-0 text-[0.92em] font-medium text-info hover:underline"
            onClick={() =>
              void window.api.dialog.pickFolder().then((folder) => {
                if (!folder) return
                const why = linkProblem(project, folder)
                setProblem(why)
                if (!why) onChangePath(folder)
              })
            }
          >
            Change…
          </button>
        )}
      </div>
      {problem && <p className="-mt-1 text-[0.85em] text-warning">{problem}</p>}

      <label className="flex flex-col gap-1">
        <span className="text-[0.85em] text-foreground">
          Note for the agent <span className="text-muted-foreground">· optional</span>
        </span>
        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            // The sidebar's own shortcuts must not fire while typing a note.
            e.stopPropagation()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            }
          }}
          placeholder="What is this folder, and what may the agent do in it? e.g. Shared tokens — read them, don't edit."
          className="min-h-[4.5rem] bg-background text-[0.92em] md:text-[0.92em]"
        />
        <span className="text-[0.8em] text-muted-foreground">
          Sent with the folder's path at the start of every chat in this project.
        </span>
      </label>

      <div className="flex items-center gap-2">
        {mode === 'edit' && (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:text-danger"
            onClick={() => {
              unlinkFolder(project.id, path)
              onDone()
            }}
          >
            Unlink
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={save}>
          {mode === 'add' ? 'Link folder' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
