import React, { useState } from 'react'
import { ChevronLeft, ChevronRight, HardDrive, RefreshCw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
import { useSessionsStore, cwdForSession } from '../store/sessions'
import type { VersionView } from '../lib/versions'

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
 * screen. Switching versions swaps the transcript; nothing rewinds the files.
 */
export function DiskNote({
  view,
  disabled,
  onShow
}: {
  view: VersionView
  disabled?: boolean
  onShow: (key: string, index: number) => void
}): React.JSX.Element | null {
  if (view.ranElsewhere === null) return null
  const ran = view.ranElsewhere
  return (
    <div className="mt-0.5 flex items-center gap-1.5 px-1.5 text-c-xs text-muted-foreground/80">
      <HardDrive className="size-3" />
      <span>Files on disk are from version {ran + 1}.</span>
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

const actionClass =
  'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-c-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent/50 data-[state=open]:text-foreground'

/**
 * Regenerate, in a reply's action row.
 *
 * A turn that only read goes straight away. One that edited files asks first:
 * the conversation rewinds, the working tree does not, so the new attempt
 * starts from the old one's edits.
 */
export function RegenerateButton({
  sessionId,
  files,
  onRegenerate
}: {
  sessionId: string
  files: string[]
  onRegenerate: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const cwd = useSessionsStore((s) => cwdForSession(s, sessionId))

  if (files.length === 0) {
    return (
      <button type="button" onClick={onRegenerate} className={actionClass}>
        <RefreshCw className="size-3.5" />
        Regenerate
      </button>
    )
  }

  const shown = (path: string): string => {
    const root = cwd.replace(/[\\/]+$/, '')
    return root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, '') : path
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
          Regenerating rewinds the conversation, not the files. The new attempt will start from the files as they
          are now.
        </p>
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto font-mono text-c-xs text-muted-foreground">
          {files.map((path) => (
            <li key={path} className="truncate" title={path}>
              {shown(path)}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false)
              onRegenerate()
            }}
          >
            Regenerate
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
