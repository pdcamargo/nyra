import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, Keyboard, SquareTerminal, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { parseInstallCommand, type InstallCommand, type InstallKind } from '../../lib/installCommand'
import { announceLibraryChange } from '../../lib/libraryWatch'
import { homedir } from '../../lib/homedir'
import { isWithin, relativeTo } from '../../lib/paths'
import type { ConfigDir } from '../../lib/api-types'

/** One thing a list holds, keyed so a before-and-after diff can find the new ones. */
export type Installed = {
  key: string
  /** What to call it: `/make-interfaces-feel-better`, `frontend-design`. */
  label: string
  /** Where it went: "This project", "Every project". */
  where: string
}

type Run =
  | { state: 'idle'; error?: string }
  | { state: 'running'; command: InstallCommand }
  | { state: 'done'; command: InstallCommand; exitCode: number; added: Installed[] }

function tildify(path: string): string {
  const home = homedir()
  if (!home || !isWithin(home, path)) return path
  const rel = relativeTo(home, path).replace(/\\/g, '/')
  return rel ? `~/${rel}` : '~'
}

/**
 * Paste what a README says to type, press Add, answer its questions here.
 *
 * `npx skills add` and `claude plugin install` both ask things — which skills,
 * which scope, whether to trust a plugin's command — so the command runs in a
 * real terminal that opens under the field rather than in a dialog over the
 * list: the list is what changes, and it stays in view. What was added is read
 * off the list itself, before and after, not guessed from the CLI's output.
 */
export default function InstallFromCommand({
  context,
  cwd,
  configDir,
  snapshot,
  onUse,
  onFinished
}: {
  context: InstallKind
  /** Where the command runs, and so where a project-scoped install lands. */
  cwd: string
  configDir: ConfigDir
  snapshot: () => Promise<Installed[]>
  onUse?: (item: Installed) => void
  onFinished?: (added: Installed[]) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const [showOutput, setShowOutput] = useState(false)
  /** A fresh panel per run, so each one mounts its own terminal. */
  const [runId, setRunId] = useState(0)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  /** Output that arrived before the terminal mounted. */
  const pendingRef = useRef('')
  const unsubRef = useRef<(() => void)[]>([])

  const stopListening = (): void => {
    for (const off of unsubRef.current) off()
    unsubRef.current = []
  }

  const teardown = useCallback((): void => {
    stopListening()
    if (idRef.current) void window.api.terminal.kill(idRef.current)
    idRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    pendingRef.current = ''
  }, [])

  useEffect(() => teardown, [teardown])

  const start = async (): Promise<void> => {
    if (run.state === 'running') return
    const parsed = parseInstallCommand(value, context)
    if (!parsed.ok) {
      setRun({ state: 'idle', error: parsed.error })
      return
    }
    teardown()
    const { command } = parsed
    const id = `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    idRef.current = id
    const before = await snapshot().catch(() => [] as Installed[])
    // Dimmed, so the line reads as what was run rather than as output.
    pendingRef.current = `\x1b[2m$ ${command.display}\x1b[0m\r\n`

    unsubRef.current = [
      window.api.terminal.onData((event) => {
        if (event.id !== id) return
        if (termRef.current) termRef.current.write(event.data)
        else pendingRef.current += event.data
      }),
      window.api.terminal.onExit((event) => {
        if (event.id !== id) return
        stopListening()
        idRef.current = null
        void finish(command, event.exitCode, before)
      })
    ]

    setShowOutput(true)
    setRunId((n) => n + 1)
    setRun({ state: 'running', command })
    const result = await window.api.library
      .installStart(id, cwd, command.program, command.args, configDir)
      .catch((e: unknown) => ({ error: String(e) }))
    if (result.error) {
      stopListening()
      idRef.current = null
      setRun({ state: 'idle', error: result.error })
    }
  }

  const finish = async (command: InstallCommand, exitCode: number, before: Installed[]): Promise<void> => {
    const known = new Set(before.map((i) => i.key))
    const after = await snapshot().catch(() => [] as Installed[])
    const added = after.filter((i) => !known.has(i.key))
    // The watcher says this too; saying it here means the lists never wait on it.
    announceLibraryChange(command.kind === 'skill' ? ['skills'] : ['plugins'])
    setRun({ state: 'done', command, exitCode, added })
    // Keep the output open when something went wrong — it is the explanation.
    setShowOutput(exitCode !== 0)
    if (exitCode === 0) setValue('')
    onFinished?.(added)
  }

  const cancel = (): void => {
    teardown()
    setRun({ state: 'idle' })
  }

  // The terminal, once its box exists. Same palette as the login terminal: the
  // CLIs colour their prompts for a dark background.
  useEffect(() => {
    if (!container || termRef.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'Fira Code Variable', 'SF Mono', Menlo, monospace",
      theme: { background: '#0d0d0d', foreground: '#e5e5e5', cursor: '#e5e5e5' },
      allowTransparency: true,
      scrollback: 2000,
      convertEol: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    fit.fit()
    if (pendingRef.current) term.write(pendingRef.current)
    pendingRef.current = ''
    term.onData((data) => {
      if (idRef.current) void window.api.terminal.write(idRef.current, data)
    })
    term.onResize(({ cols, rows }) => {
      if (idRef.current) void window.api.terminal.resize(idRef.current, cols, rows)
    })
    termRef.current = term
    fitRef.current = fit
    setTimeout(() => {
      try {
        fit.fit()
        if (idRef.current) void window.api.terminal.resize(idRef.current, term.cols, term.rows)
        term.focus()
      } catch {
        /* ignore */
      }
    }, 50)
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [container])

  // Re-fit when the output is shown again after being folded away.
  useEffect(() => {
    if (showOutput) setTimeout(() => fitRef.current?.fit(), 0)
  }, [showOutput])

  const running = run.state === 'running'
  const where = tildify(cwd)
  const noun = context === 'skill' ? 'skill' : 'plugin'

  return (
    <div className="mb-7">
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 focus-within:border-info">
          <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={value}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value)
              if (run.state === 'idle' && run.error) setRun({ state: 'idle' })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void start()
            }}
            placeholder={
              context === 'skill'
                ? 'Paste npx skills add … or owner/repo'
                : 'Paste claude plugin install … or plugin@marketplace'
            }
            aria-label={`Install a ${noun} from a command`}
            className="min-w-0 flex-1 bg-transparent font-mono text-c-sm text-foreground outline-hidden placeholder:text-muted-foreground disabled:text-muted-foreground"
          />
        </label>
        <button
          type="button"
          onClick={() => void start()}
          disabled={running || !value.trim()}
          aria-label="Add from command"
          className={
            value.trim() && !running
              ? 'shrink-0 rounded-md bg-info/90 px-3 py-1.5 text-c-md font-medium text-info-foreground transition-colors hover:bg-info'
              : 'shrink-0 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-c-md font-medium text-muted-foreground'
          }
        >
          Add
        </button>
      </div>

      {run.state === 'idle' &&
        (run.error ? (
          <p className="mt-2 flex items-start gap-1.5 text-c-sm text-danger">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{run.error}</span>
          </p>
        ) : (
          <p className="mt-2 text-c-sm text-muted-foreground">
            {context === 'skill' ? (
              <>
                Paste an <code className="font-mono">npx skills add</code> command or an{' '}
                <code className="font-mono">owner/repo</code>.
              </>
            ) : (
              <>
                Paste a <code className="font-mono">claude plugin install</code> or{' '}
                <code className="font-mono">/plugin marketplace add</code> command.
              </>
            )}{' '}
            It runs in a terminal here, so you can answer its questions.
          </p>
        ))}

      {run.state !== 'idle' && (
        <div key={runId} className="mt-2 overflow-hidden rounded-md border border-border bg-background">
          {run.state === 'running' ? (
            <div className="flex items-center gap-2 py-1 pl-3 pr-1.5">
              <Keyboard className="size-3.5 shrink-0 text-info" />
              <span className="min-w-0 flex-1 truncate text-c-sm text-foreground">
                Running. Answer any questions below{' '}
                <span className="text-muted-foreground">· in {where}</span>
              </span>
              <button
                type="button"
                onClick={cancel}
                className="shrink-0 rounded-md px-2.5 py-1 text-c-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                Cancel
              </button>
            </div>
          ) : (
            <DoneHeader run={run} noun={noun} onUse={onUse} onClose={cancel} />
          )}

          {run.state === 'done' && (
            <button
              type="button"
              onClick={() => setShowOutput((v) => !v)}
              aria-expanded={showOutput}
              className="flex w-full items-center gap-1 border-t border-border bg-muted/40 px-3 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${showOutput ? 'rotate-90' : ''}`} />
              <span className="flex-1 text-c-sm text-muted-foreground">Terminal output</span>
              <span className="font-mono text-c-xs text-muted-foreground">exited {run.exitCode}</span>
            </button>
          )}

          {/* Kept mounted once there is a run, folded or not, so the scrollback
              survives folding it away and opening it again. */}
          <div className={`border-t border-border bg-[#0d0d0d] p-2 ${showOutput ? '' : 'hidden'}`}>
            <div ref={setContainer} className="h-56 w-full" />
          </div>
        </div>
      )}
    </div>
  )
}

function DoneHeader({
  run,
  noun,
  onUse,
  onClose
}: {
  run: Extract<Run, { state: 'done' }>
  noun: string
  onUse?: (item: Installed) => void
  onClose: () => void
}): React.JSX.Element {
  const failed = run.exitCode !== 0
  const close = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Dismiss</TooltipContent>
    </Tooltip>
  )

  if (failed || run.added.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
        {failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-danger" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-c-sm text-foreground">
          {failed
            ? `It stopped before finishing, with exit code ${run.exitCode}.`
            : `Finished. No new ${noun} showed up — it may have been there already.`}
        </span>
        {close}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {run.added.map((item, i) => (
        <div key={item.key} className={`flex items-center gap-2 py-1.5 pl-3 pr-1.5 ${i > 0 ? 'border-t border-border' : ''}`}>
          <CircleCheck className="size-3.5 shrink-0 text-success" />
          <span className="min-w-0 flex-1 truncate text-c-sm text-foreground">
            Added <span className="font-medium">{item.label}</span>{' '}
            <span className="text-muted-foreground">· {item.where}</span>
          </span>
          {onUse && (
            <button
              type="button"
              onClick={() => onUse(item)}
              className="shrink-0 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-c-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Use
            </button>
          )}
          {i === 0 ? close : <span className="w-[26px] shrink-0" />}
        </div>
      ))}
    </div>
  )
}
