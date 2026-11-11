import React, { useEffect, useState } from 'react'
import { ArrowRight, CircleX, FastForward, LoaderCircle, RotateCw, X } from 'lucide-react'
import { Button } from './ui/button'
import { useScriptsStore, tailLines, dismissSetup, retrySetup } from '../store/scripts'
import { formatElapsed } from '../lib/sidebarStatus'

/**
 * A new worktree's Setup, where the reply will be: what it is running, the
 * last of its output, and — while a send waits on it — a way to go ahead
 * without it. Gone once it succeeds, which is when Claude starts.
 */
export default function SetupCard({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const setup = useScriptsStore((s) => s.setups[sessionId])
  const [now, setNow] = useState(() => Date.now())
  const running = setup?.status === 'running'
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  if (!setup) return null

  const failed = !running
  const elapsed = formatElapsed((setup.endedAt ?? now) - setup.startedAt)
  const lines = tailLines(setup.output, 4)

  return (
    <div
      className={`flex flex-col gap-2.5 rounded-lg border bg-background px-3.5 py-3 ${
        failed ? 'border-danger/40' : 'border-border'
      }`}
      data-testid="setup-card"
    >
      <div className="flex items-center gap-2">
        {failed ? (
          <CircleX className="size-4 shrink-0 text-danger" />
        ) : (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-info" />
        )}
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {failed ? (
            <>
              Setup failed <span className="font-mono font-normal text-danger">exit {setup.exitCode}</span>
            </>
          ) : (
            <>
              Setting up worktree
              {setup.branch && <span className="ml-1.5 font-mono font-normal text-muted-foreground">{setup.branch}</span>}
            </>
          )}
        </p>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{elapsed}</span>
      </div>

      <div className="flex flex-col gap-0.5 rounded-md border border-border bg-code px-2.5 py-2">
        {lines.length === 0 ? (
          <span className="truncate font-mono text-[11px] text-foreground">$ {setup.command.split('\n')[0]}</span>
        ) : (
          lines.map((line, i) => (
            <span
              key={i}
              className={`truncate font-mono text-[11px] ${failed ? 'text-danger' : 'text-muted-foreground'}`}
              title={line}
            >
              {line}
            </span>
          ))
        )}
      </div>

      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {!setup.blocking
            ? failed
              ? 'The worktree is there either way.'
              : 'Runs the project’s setup script in the restored worktree.'
            : failed
              ? 'Claude hasn’t started. The worktree is there either way.'
              : 'Claude starts when setup finishes.'}
        </p>
        {running && setup.blocking && (
          <Button variant="ghost" onClick={() => dismissSetup(sessionId)}>
            <FastForward data-icon="inline-start" />
            Start now
          </Button>
        )}
        {failed && (
          <>
            <Button variant="ghost" onClick={() => dismissSetup(sessionId)}>
              {setup.blocking ? <ArrowRight data-icon="inline-start" /> : <X data-icon="inline-start" />}
              {setup.blocking ? 'Start anyway' : 'Dismiss'}
            </Button>
            <Button variant="outline" onClick={() => retrySetup(sessionId)}>
              <RotateCw data-icon="inline-start" />
              Retry
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
