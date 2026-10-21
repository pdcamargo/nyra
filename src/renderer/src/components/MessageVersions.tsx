import React, { useState } from 'react'
import { ChevronLeft, ChevronRight, CircleAlert, HardDrive, LoaderCircle, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
import { useSessionsStore, cwdForSession } from '../store/sessions'
import type { VersionView } from '../lib/versions'
import type { RestoreReport } from '../store/restores'

/**
 * The ‹ n / m › switcher under an edited prompt or a regenerated reply.
 *
 * Shown whether or not the message is hovered: the versions behind it are the
 * one thing in the transcript you could not otherwise know were there.
 */
export function VersionSwitch({
  view,
  disabled,
  onShow
}: {
  view: VersionView
  disabled?: boolean
  onShow: (key: string, index: number) => void
}): React.JSX.Element {
  const step = (by: number): void => onShow(view.key, view.index + by)
  const arrow =
    'rounded-md p-1 text-muted-foreground transition-colors enabled:hover:bg-accent/50 enabled:hover:text-foreground disabled:opacity-35'
  return (
    <span className="flex items-center">
      <button
        type="button"
        className={arrow}
        disabled={disabled || view.index === 0}
        onClick={() => step(-1)}
        aria-label="Previous version"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="font-mono text-c-sm tabular-nums text-muted-foreground">
        {view.index + 1} / {view.total}
      </span>
      <button
        type="button"
        className={arrow}
        disabled={disabled || view.index === view.total - 1}
        onClick={() => step(1)}
        aria-label="Next version"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </span>
  )
}

/**
 * Says so when the files on disk belong to another version than the one on
 * screen, and offers to put this one's back. Switching versions swaps the
 * transcript only; the files change when this is clicked, never on their own.
 */
export function DiskNote({
  view,
  disabled,
  restoring,
  onShow,
  onRestore
}: {
  view: VersionView
  disabled?: boolean
  restoring?: boolean
  onShow: (key: string, index: number) => void
  onRestore?: (key: string) => void
}): React.JSX.Element | null {
  if (view.ranElsewhere === null) return null
  const ran = view.ranElsewhere
  if (restoring) {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 px-1.5 text-c-xs text-muted-foreground/80">
        <LoaderCircle className="size-3 animate-spin" />
        <span>Restoring version {view.index + 1}&apos;s files…</span>
      </div>
    )
  }
  return (
    <div className="mt-0.5 flex items-center gap-1.5 px-1.5 text-c-xs text-muted-foreground/80">
      <HardDrive className="size-3" />
      <span>Files on disk are from version {ran + 1}.</span>
      {view.restorable && onRestore && (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRestore(view.key)}
            className="font-medium text-foreground transition-colors enabled:hover:text-foreground/80"
          >
            Restore version {view.index + 1}&apos;s files
          </button>
          <span aria-hidden>·</span>
        </>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onShow(view.key, ran)}
        className="font-medium text-muted-foreground transition-colors enabled:hover:text-foreground"
      >
        Go to version {ran + 1}
      </button>
    </div>
  )
}

/**
 * What a restore could not bring back, under the message it was asked from.
 * Silent when everything came back; the note it replaces just goes.
 */
export function RestoreNote({
  report,
  shown,
  onDismiss
}: {
  report: RestoreReport
  /** A path as the user knows it: relative to the chat's folder. */
  shown: (path: string) => string
  onDismiss: () => void
}): React.JSX.Element {
  const whose = report.version === null ? 'The files' : `Version ${report.version}'s files`
  const count = report.overwritten.length + report.commands.length
  const kept = report.savedWith === null ? 'a copy is kept' : `a copy is kept with version ${report.savedWith}`
  const ranIn = report.version === null ? 'this turn' : report.savedWith === null ? 'that version' : `version ${report.savedWith}`
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <CircleAlert className="size-3.5 shrink-0 text-warning" />
        <span className="grow text-c-sm font-medium text-foreground">
          {report.error
            ? `Couldn't restore ${whose.toLowerCase()}`
            : `${whose} are back, with ${count === 1 ? 'one exception' : `${count} exceptions`}`}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {report.error && <p className="pl-5.5 text-c-xs text-muted-foreground">{report.error} Nothing on disk was changed.</p>}
      {report.overwritten.map((path) => (
        <div key={path} className="flex flex-col gap-px pl-5.5">
          <span className="truncate font-mono text-c-xs text-foreground" title={path}>
            {shown(path)}
          </span>
          <span className="text-c-xs text-muted-foreground">
            Had changes Claude&apos;s edits don&apos;t account for, by hand or by a shell command. They were replaced;{' '}
            {kept}.
          </span>
        </div>
      ))}
      {report.commands.map((command, i) => (
        <div key={`${i}:${command}`} className="flex flex-col gap-px pl-5.5">
          <span className="truncate font-mono text-c-xs text-foreground" title={command}>
            {command}
          </span>
          <span className="text-c-xs text-muted-foreground">
            A shell command in {ranIn}. Whatever it changed is still on disk; nothing tracks which files it touched.
          </span>
        </div>
      ))}
    </div>
  )
}

const actionClass =
  'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-c-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent/50 data-[state=open]:text-foreground'

/** A path relative to `cwd` when it is under it, as it reads in the transcript. */
export function shownPath(cwd: string, path: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  return root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, '') : path
}

/**
 * Regenerate, in a reply's action row.
 *
 * A turn that only read goes straight away. One that edited files asks first,
 * whether to put them back before the new attempt or let it start from the old
 * one's edits. A turn from before checkpoints existed can only do the latter,
 * and says so.
 */
export function RegenerateButton({
  sessionId,
  files,
  commands,
  canRestore,
  onRegenerate
}: {
  sessionId: string
  files: string[]
  commands: string[]
  canRestore: boolean
  onRegenerate: (restore: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const cwd = useSessionsStore((s) => cwdForSession(s, sessionId))

  if (files.length === 0) {
    return (
      <button type="button" onClick={() => onRegenerate(false)} className={actionClass}>
        <RefreshCw className="size-3.5" />
        Regenerate
      </button>
    )
  }

  const go = (restore: boolean): void => {
    setOpen(false)
    onRegenerate(restore)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={actionClass}>
          <RefreshCw className="size-3.5" />
          Regenerate
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 p-4">
        <div className="text-c-md font-medium text-foreground">
          This turn edited {files.length === 1 ? '1 file' : `${files.length} files`}
        </div>
        <p className="text-c-sm text-muted-foreground">
          {canRestore
            ? "Restore them to how they were before this turn, or regenerate on top of the edits. Either way, this version's files are kept with it."
            : 'Regenerating rewinds the conversation, not the files. The new attempt will start from the files as they are now.'}
        </p>
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto font-mono text-c-xs text-muted-foreground">
          {files.map((path) => (
            <li key={path} className="truncate" title={path}>
              {shownPath(cwd, path)}
            </li>
          ))}
        </ul>
        {canRestore && commands.length > 0 && (
          <p className="flex items-start gap-2 text-c-xs text-muted-foreground/80">
            <SquareTerminal className="mt-px size-3 shrink-0" />
            {commands.length === 1
              ? 'It also ran a shell command. Whatever that changed stays as it is.'
              : `It also ran ${commands.length} shell commands. Whatever those changed stays as it is.`}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {canRestore ? (
            <>
              <Button variant="outline" size="sm" onClick={() => go(false)}>
                Regenerate
              </Button>
              <Button size="sm" onClick={() => go(true)}>
                Restore files and regenerate
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => go(false)}>
                Regenerate
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
