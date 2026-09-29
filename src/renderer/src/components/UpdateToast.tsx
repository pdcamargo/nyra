import React, { useEffect, useState } from 'react'
import { ArrowDownToLine, CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useUpdatesStore, type UpdatePhase } from '../store/updates'

const PRIMARY = 'bg-info text-info-foreground hover:bg-info/85'

const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(1)

/**
 * A new version, pinned bottom-right where it can be seen and acted on.
 *
 * It replaced a badge above the sidebar tabs that was easy to miss. Later and ×
 * both hide it until the next launch; Settings → About still has the version
 * and the button. A background download (Update automatically) shows nothing
 * until it is ready — the user did not ask to watch it.
 */
export default function UpdateToast(): React.JSX.Element | null {
  const phase = useUpdatesStore((s) => s.phase)
  const dismissed = useUpdatesStore((s) => s.dismissed)
  const [current, setCurrent] = useState('')

  useEffect(() => {
    void window.api.updates.version().then(setCurrent).catch(() => setCurrent(''))
  }, [])

  if (phase.kind === 'idle') return null
  if (phase.kind === 'downloading' && phase.mode === 'stage') return null
  // Installing is the one state you cannot wave away: the restart is coming.
  if (phase.kind !== 'downloading' && dismissed === phase.version) return null

  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-40 flex w-[340px] flex-col gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-panel data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2"
      data-open=""
    >
      <Body phase={phase} current={current} />
    </div>
  )
}

function Body({ phase, current }: { phase: UpdatePhase; current: string }): React.JSX.Element | null {
  const { install, dismiss, retry } = useUpdatesStore.getState()

  switch (phase.kind) {
    case 'available':
      return (
        <>
          <Top
            icon={<ArrowDownToLine />}
            title={`Nyra ${phase.version} is available`}
            detail={
              current ? (
                <>
                  You&apos;re on <span className="font-mono">{current}</span>. Nyra restarts to
                  finish.
                </>
              ) : (
                'Nyra restarts to finish.'
              )
            }
            onClose={dismiss}
          />
          <Actions>
            <Button variant="ghost" onClick={dismiss}>
              Later
            </Button>
            <Button className={PRIMARY} onClick={() => void install()}>
              Update and restart
            </Button>
          </Actions>
        </>
      )

    case 'downloading': {
      const fraction = phase.total ? Math.min(1, phase.received / phase.total) : null
      return (
        <>
          <Top
            icon={<LoaderCircle className="animate-spin" />}
            title={phase.version ? `Downloading Nyra ${phase.version}` : 'Downloading the update'}
            detail={
              phase.total
                ? `${mb(phase.received)} of ${mb(phase.total)} MB · restarts when done`
                : 'Restarts when done'
            }
          />
          <div className="h-1 overflow-hidden rounded-full bg-border">
            <div
              className={cn(
                'h-full rounded-full bg-info transition-[width] duration-200',
                fraction === null && 'w-1/3 animate-pulse'
              )}
              style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
            />
          </div>
        </>
      )
    }

    case 'ready':
      return (
        <>
          <Top
            icon={<CircleCheck />}
            title={`Nyra ${phase.version} is ready`}
            detail="Installs when you quit, or restart now."
            onClose={dismiss}
          />
          <Actions>
            <Button variant="ghost" onClick={dismiss}>
              Later
            </Button>
            <Button className={PRIMARY} onClick={() => void install()}>
              Restart now
            </Button>
          </Actions>
        </>
      )

    case 'failed':
      return (
        <>
          <Top
            tone="danger"
            icon={<CircleAlert />}
            title={phase.version ? `Couldn't update to ${phase.version}` : "Couldn't update"}
            detail={<span className="line-clamp-2 font-mono break-words">{phase.message}</span>}
            onClose={dismiss}
          />
          <Actions>
            <Button variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          </Actions>
        </>
      )

    default:
      return null
  }
}

function Top({
  icon,
  title,
  detail,
  tone = 'info',
  onClose
}: {
  icon: React.ReactNode
  title: string
  detail: React.ReactNode
  tone?: 'info' | 'danger'
  onClose?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-[15px]',
          tone === 'info' ? 'bg-info/12 text-info' : 'bg-danger/12 text-danger'
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      {onClose && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClose}
              aria-label="Dismiss"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function Actions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex justify-end gap-2">{children}</div>
}
