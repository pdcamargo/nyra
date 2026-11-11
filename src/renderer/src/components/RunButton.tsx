import React, { useEffect, useState } from 'react'
import { GitBranch, Globe, Play, Radio, RotateCw, Square, SquareTerminal } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { useSessionsStore, activeSession as activeSessionSelector, findProject } from '../store/sessions'
import { useProcessesStore } from '../store/processes'
import {
  useScriptsStore,
  runIdFor,
  startRunScript,
  stopRunScript,
  restartRunScript,
  showRunTerminal,
  tailLines
} from '../store/scripts'
import { detectRunCommand, resolveScripts, REPO_SCRIPTS_FILE } from '../lib/projectScripts'
import { formatElapsed } from '../lib/sidebarStatus'
import { basename } from '../lib/paths'
import { openPort } from './PortChips'

/** What the popover is showing: the Run, or the question before the first one. */
type Asking = { suggested: string; found: string | null; repoFile: string | null }

/**
 * The title bar's Run: starts the project's Run script in the active chat's
 * folder, so each worktree chat gets its own server. Running, it shows the
 * port it bound and opens onto the output and the controls; with no Run
 * script set, the first click asks for one.
 */
export default function RunButton(): React.JSX.Element | null {
  const session = useSessionsStore(activeSessionSelector)
  const project = useSessionsStore((s) => findProject(s, session?.projectId))
  const sessionId = session?.id ?? null
  const run = useScriptsStore((s) => (sessionId ? s.runs[sessionId] : undefined))
  const ports = useProcessesStore((s) =>
    sessionId ? s.bySession[sessionId]?.find((p) => p.shellId === runIdFor(sessionId))?.ports : undefined
  )
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [error, setError] = useState<string | null>(null)

  const running = run?.status === 'running'
  const failed = run?.status === 'exited' && run.exitCode !== 0 && !run.stopped

  const start = async (): Promise<void> => {
    if (!sessionId || !session) return
    setError(null)
    const result = await startRunScript(sessionId)
    if (result.ok) return
    if (result.reason === 'no-command') {
      const scripts = await resolveScripts(session.cwd, project)
      const found = scripts.source === 'repo' ? null : await detectRunCommand(session.cwd)
      setAsking({ suggested: found?.command ?? '', found: found?.script ?? null, repoFile: scripts.file ?? null })
      setOpen(true)
      return
    }
    setError(result.error ?? 'Could not start')
    setOpen(true)
  }

  const onClick = (): void => {
    if (running || failed) {
      setAsking(null)
      setOpen((o) => !o)
    } else if (open) {
      setOpen(false)
    } else {
      void start()
    }
  }

  // The palette's Run command, for the chat on screen.
  const onClickRef = React.useRef(onClick)
  onClickRef.current = onClick
  useEffect(() => {
    const handler = (): void => onClickRef.current()
    window.addEventListener('nyra:run-toggle', handler)
    return () => window.removeEventListener('nyra:run-toggle', handler)
  }, [])

  // A chat outside any project has nowhere to keep a Run script, and one whose
  // worktree is not made yet would start in the wrong folder.
  if (!session || !project || session.pendingWorktree) return null

  const port = ports?.[0]
  const label = running ? (port ? `:${port}` : 'Running') : 'Run'

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setAsking(null)
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                onClick()
              }}
              aria-label={running ? `Running ${run.command}` : 'Run'}
              className={`mr-1 flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors ${
                running
                  ? 'border-success/25 bg-success/10 text-success hover:bg-success/15'
                  : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground'
              }`}
              data-testid="run-button"
            >
              {running ? <Radio className="size-3.5" /> : <Play className="size-3.5" />}
              <span className={running && port ? 'font-mono' : undefined}>{label}</span>
              {failed && <span className="size-1.5 rounded-full bg-danger" aria-label="Last run failed" />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {running ? run.command : failed ? `Exited ${run.exitCode}` : `Run in ${basename(session.cwd)}`}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-[400px] gap-3 p-3">
        {asking ? (
          <AskForCommand
            projectName={project.name}
            asking={asking}
            onCancel={() => setOpen(false)}
            onSave={(command) => {
              useSessionsStore.getState().setProjectScripts(project.id, { run: command })
              setAsking(null)
              setOpen(false)
              void start()
            }}
          />
        ) : run ? (
          <RunDetails
            sessionId={session.id}
            where={session.worktree?.branch ?? basename(session.cwd)}
            inWorktree={!!session.worktree}
            port={port}
            error={error}
            onDone={() => setOpen(false)}
          />
        ) : (
          error && <p className="text-xs text-danger">{error}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

function AskForCommand({
  projectName,
  asking,
  onCancel,
  onSave
}: {
  projectName: string
  asking: Asking
  onCancel: () => void
  onSave: (command: string) => void
}): React.JSX.Element {
  const [command, setCommand] = useState(asking.suggested)

  // The repo's file wins whole, so a command kept in Nyra would never run.
  if (asking.repoFile) {
    return (
      <p className="text-xs text-muted-foreground">
        This project’s <code className="font-mono text-foreground">{REPO_SCRIPTS_FILE}</code> has no{' '}
        <code className="font-mono text-foreground">run</code>. Add one there and Run will start it.
      </p>
    )
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (command.trim()) onSave(command.trim())
      }}
    >
      <p className="text-xs font-medium text-foreground">What should Run start in {projectName}?</p>
      <Input
        autoFocus
        aria-label="Run command"
        value={command}
        placeholder="npm run dev"
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        className="h-8 font-mono text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        {asking.found ? (
          <>
            Found <code className="font-mono">{asking.found}</code> in package.json.{' '}
          </>
        ) : null}
        Change it any time in Project settings.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!command.trim()}>
          <Play data-icon="inline-start" />
          Save and run
        </Button>
      </div>
    </form>
  )
}

function RunDetails({
  sessionId,
  where,
  inWorktree,
  port,
  error,
  onDone
}: {
  sessionId: string
  where: string
  inWorktree: boolean
  port: number | undefined
  error: string | null
  onDone: () => void
}): React.JSX.Element | null {
  const run = useScriptsStore((s) => s.runs[sessionId])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  if (!run) return null

  const running = run.status === 'running'
  const lines = tailLines(run.output, 4)
  const status = running
    ? `Running ${formatElapsed(now - run.startedAt)}`
    : run.stopped
      ? 'Stopped'
      : `Exited ${run.exitCode ?? ''}`.trim()

  return (
    <>
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${running ? 'bg-success' : run.stopped ? 'bg-muted-foreground' : 'bg-danger'}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={run.command}>
          {run.command.split('\n')[0]}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{status}</span>
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {inWorktree && <GitBranch className="size-3 shrink-0" />}
        <span className="truncate font-mono text-[11px]">{where}</span>
      </div>
      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md border border-border bg-code px-2.5 py-2">
          {lines.map((line, i) => (
            <span key={i} className="truncate font-mono text-[11px] text-muted-foreground" title={line}>
              {line}
            </span>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        {running && port !== undefined && (
          <Button
            onClick={() => {
              openPort(sessionId, port)
              onDone()
            }}
          >
            <Globe data-icon="inline-start" />
            Open :{port}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => {
            showRunTerminal(sessionId)
            onDone()
          }}
        >
          <SquareTerminal data-icon="inline-start" />
          Terminal
        </Button>
        <div className="flex-1" />
        {running ? (
          <>
            <Button variant="ghost" onClick={() => void restartRunScript(sessionId)}>
              <RotateCw data-icon="inline-start" />
              Restart
            </Button>
            <Button variant="ghost" onClick={() => void stopRunScript(sessionId)}>
              <Square data-icon="inline-start" />
              Stop
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => void startRunScript(sessionId)}>
            <Play data-icon="inline-start" />
            Run again
          </Button>
        )}
      </div>
    </>
  )
}
