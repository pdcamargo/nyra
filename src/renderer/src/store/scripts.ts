import { create } from 'zustand'
import { configDirForSession, findProject, newMessageId, useSessionsStore, workspaceIdForSession } from './sessions'
import { useTerminalsStore, terminalBucket } from './terminals'
import { useUiStore } from './ui'
import { resolveScripts } from '../lib/projectScripts'

/**
 * The project scripts running right now: each chat's Run, and the Setup a new
 * worktree gets before Claude starts in it.
 *
 * Both are PTYs of their own, not terminal tabs — the terminal panel kills its
 * shells when it closes, and ⌘J must not take a dev server with it. Their
 * output is kept here, bounded, for the run popover, the setup card, and a
 * terminal tab that attaches to a Run to show the rest.
 */
export type ScriptProcess = {
  /** The PTY id. A Run keeps one per chat across restarts; a Setup gets a new one per attempt. */
  id: string
  command: string
  /** The branch a Setup is preparing, for the card. */
  branch?: string
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  /** Ended by Stop rather than on its own, so not a failure. */
  stopped?: boolean
  /** The tail of what it printed, ANSI and all. */
  output: string
}

export type SetupProcess = ScriptProcess & {
  /** A send is waiting on it. Off for a restored worktree, where nothing is. */
  blocking: boolean
}

/** What a send that waits on a Setup goes on to do. */
export type SetupOutcome = 'continue' | 'abort'

/** Enough for any dev server's banner and the errors after it; an attached
 *  terminal replays this much. */
const OUTPUT_LIMIT = 64 * 1024

interface ScriptsState {
  runs: Record<string, ScriptProcess>
  setups: Record<string, SetupProcess>
}

export const useScriptsStore = create<ScriptsState>(() => ({ runs: {}, setups: {} }))

export function runIdFor(sessionId: string): string {
  return `run:${sessionId}`
}

// ---- output ----

/** PTY id → the chat and the kind, so one listener routes every script. */
const owners = new Map<string, { sessionId: string; kind: 'run' | 'setup' }>()
const exitWaiters = new Map<string, () => void>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  window.api.terminal.onData(({ id, data }) => {
    const owner = owners.get(id)
    if (!owner) return
    const key = owner.kind === 'run' ? 'runs' : 'setups'
    useScriptsStore.setState((s) => {
      const proc = s[key][owner.sessionId]
      if (!proc || proc.id !== id) return s
      const output = (proc.output + data).slice(-OUTPUT_LIMIT)
      return { [key]: { ...s[key], [owner.sessionId]: { ...proc, output } } } as Partial<ScriptsState>
    })
  })
  window.api.terminal.onExit(({ id, exitCode }) => {
    const owner = owners.get(id)
    exitWaiters.get(id)?.()
    exitWaiters.delete(id)
    if (!owner) return
    if (owner.kind === 'setup') owners.delete(id)
    if (owner.kind === 'run') markExited('runs', owner.sessionId, id, exitCode)
    else setupExited(owner.sessionId, id, exitCode)
  })
}

function markExited(key: 'runs' | 'setups', sessionId: string, id: string, exitCode: number): void {
  useScriptsStore.setState((s) => {
    const proc = s[key][sessionId]
    if (!proc || proc.id !== id) return s
    return {
      [key]: { ...s[key], [sessionId]: { ...proc, status: 'exited', exitCode, endedAt: Date.now() } }
    } as Partial<ScriptsState>
  })
}

/** Resolves when `id` exits, or after `ms` regardless. */
function exited(id: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    exitWaiters.set(id, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * The last `n` lines as a person would see them: escape sequences out, and a
 * line redrawn with `\r` — a progress bar — down to its final state.
 */
export function tailLines(raw: string, n: number): string[] {
  const plain = raw
    // OSC (titles, hyperlinks), then CSI (colour, cursor), then lone escapes.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
  const lines: string[] = []
  for (const line of plain.split('\n')) {
    const parts = line.split('\r').filter((p) => p.length > 0)
    const shown = (parts[parts.length - 1] ?? '').trimEnd()
    if (shown) lines.push(shown)
  }
  return lines.slice(-n)
}

// ---- where a chat's scripts run ----

function sessionContext(sessionId: string) {
  const state = useSessionsStore.getState()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return null
  const project = findProject(state, session.projectId)
  return {
    session,
    project,
    cwd: session.cwd,
    root: project?.path ?? session.cwd,
    configDir: configDirForSession(state, sessionId)
  }
}

// ---- Run ----

export type StartRunResult = { ok: true } | { ok: false; reason: 'no-command' | 'error'; error?: string }

/** Start this chat's Run script, in its own folder. Asks for nothing: with no
 *  command set it says so, and the button asks. */
export async function startRunScript(sessionId: string): Promise<StartRunResult> {
  const ctx = sessionContext(sessionId)
  if (!ctx) return { ok: false, reason: 'error', error: 'No such chat' }
  const { run } = await resolveScripts(ctx.cwd, ctx.project)
  if (!run) return { ok: false, reason: 'no-command' }

  const id = runIdFor(sessionId)
  const current = useScriptsStore.getState().runs[sessionId]
  if (current?.status === 'running') return { ok: true }

  listen()
  owners.set(id, { sessionId, kind: 'run' })
  // A restart keeps what the last run printed above a rule, so an attached
  // terminal reads as one log.
  const carried = current ? `${current.output}\r\n\x1b[90m── restarted ──\x1b[0m\r\n` : ''
  useScriptsStore.setState((s) => ({
    runs: {
      ...s.runs,
      [sessionId]: {
        id,
        command: run,
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        output: carried.slice(-OUTPUT_LIMIT)
      }
    }
  }))
  const result = await window.api.scripts
    .spawn(id, ctx.cwd, run, ctx.root, ctx.configDir, sessionId)
    .catch((e: unknown) => ({ error: String(e) }) as { pid?: number; error?: string })
  if (result.error) {
    markExited('runs', sessionId, id, -1)
    return { ok: false, reason: 'error', error: result.error }
  }
  return { ok: true }
}

export async function stopRunScript(sessionId: string): Promise<void> {
  const run = useScriptsStore.getState().runs[sessionId]
  if (!run || run.status !== 'running') return
  useScriptsStore.setState((s) => ({ runs: { ...s.runs, [sessionId]: { ...run, stopped: true } } }))
  const done = exited(run.id, 5000)
  await window.api.scripts.stop(run.id)
  await done
}

export async function restartRunScript(sessionId: string): Promise<StartRunResult> {
  await stopRunScript(sessionId)
  return startRunScript(sessionId)
}

/** Open the Run's output in the terminal panel, as a tab attached to it. */
export function showRunTerminal(sessionId: string): void {
  const state = useSessionsStore.getState()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return
  const workspaceId = workspaceIdForSession(state, sessionId)
  const bucket = terminalBucket(session.projectId, workspaceId)
  const id = runIdFor(sessionId)
  const terminals = useTerminalsStore.getState()
  const tabs = terminals.byProject[bucket]?.tabs ?? []
  if (!tabs.some((t) => t.id === id)) {
    terminals.setTabs(bucket, [...tabs, { id, title: `Run · ${session.title}`, workspaceId, attach: true }])
  }
  terminals.setActiveTab(bucket, id)
  useUiStore.getState().setBottomPanelOpen(true)
}

/** Whether a terminal id belongs to a Run, which its tab must not kill. */
export function isRunTerminal(id: string): boolean {
  return id.startsWith('run:')
}

// ---- Setup ----

/** The send waiting on each chat's Setup, if one is. */
const setupWaiters = new Map<string, (outcome: SetupOutcome) => void>()
let setupCounter = 0

async function spawnSetup(sessionId: string, script: string, blocking: boolean, branch?: string): Promise<void> {
  const ctx = sessionContext(sessionId)
  if (!ctx) return
  setupCounter += 1
  const id = `setup:${sessionId}:${setupCounter}`
  listen()
  owners.set(id, { sessionId, kind: 'setup' })
  useScriptsStore.setState((s) => ({
    setups: {
      ...s.setups,
      [sessionId]: {
        id,
        command: script,
        branch,
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        output: '',
        blocking
      }
    }
  }))
  const result = await window.api.scripts
    .spawn(id, ctx.cwd, script, ctx.root, ctx.configDir, null)
    .catch((e: unknown) => ({ error: String(e) }) as { pid?: number; error?: string })
  if (result.error) {
    owners.delete(id)
    useScriptsStore.setState((s) => {
      const proc = s.setups[sessionId]
      if (!proc || proc.id !== id) return s
      return {
        setups: {
          ...s.setups,
          [sessionId]: { ...proc, status: 'exited', exitCode: -1, endedAt: Date.now(), output: `${result.error}\n` }
        }
      }
    })
  }
}

function clearSetup(sessionId: string): void {
  useScriptsStore.setState((s) => {
    if (!s.setups[sessionId]) return s
    const setups = { ...s.setups }
    delete setups[sessionId]
    return { setups }
  })
}

function settle(sessionId: string, outcome: SetupOutcome): void {
  setupWaiters.get(sessionId)?.(outcome)
  setupWaiters.delete(sessionId)
}

function setupExited(sessionId: string, id: string, exitCode: number): void {
  const proc = useScriptsStore.getState().setups[sessionId]
  if (proc && proc.id !== id) return
  if (!proc) {
    // Started-now and left to finish on its own: only a failure is news.
    if (exitCode !== 0) {
      useSessionsStore.getState().addMessage(sessionId, {
        id: newMessageId(),
        role: 'error',
        text: `The worktree's setup script failed (exit ${exitCode}).`
      })
    }
    return
  }
  if (exitCode === 0) {
    clearSetup(sessionId)
    settle(sessionId, 'continue')
    return
  }
  markExited('setups', sessionId, id, exitCode)
}

/**
 * Run the project's Setup in the chat's freshly made worktree.
 *
 * Blocking, for a first send: resolves `continue` once it succeeds, or when
 * Start now / Start anyway is chosen, and `abort` when the turn is stopped.
 * With no Setup it resolves at once. Not blocking, for a restored worktree:
 * the card shows while it runs and stays only if it fails.
 */
export async function runWorktreeSetup(
  sessionId: string,
  { blocking, branch }: { blocking: boolean; branch?: string }
): Promise<SetupOutcome> {
  const ctx = sessionContext(sessionId)
  if (!ctx) return 'continue'
  const { setup } = await resolveScripts(ctx.cwd, ctx.project)
  if (!setup) return 'continue'
  const outcome = blocking
    ? new Promise<SetupOutcome>((resolve) => setupWaiters.set(sessionId, resolve))
    : Promise.resolve<SetupOutcome>('continue')
  await spawnSetup(sessionId, setup, blocking, branch)
  return outcome
}

/**
 * Start now, while it runs: Claude goes ahead and Setup carries on behind it,
 * heard from again only if it fails. Start anyway after a failure, or Dismiss
 * on a card nothing waits on, are the same step.
 */
export function dismissSetup(sessionId: string): void {
  clearSetup(sessionId)
  settle(sessionId, 'continue')
}

export function retrySetup(sessionId: string): void {
  const proc = useScriptsStore.getState().setups[sessionId]
  if (!proc || proc.status === 'running') return
  void spawnSetup(sessionId, proc.command, proc.blocking, proc.branch)
}

/** The turn was stopped while its Setup ran: end it, and the send with it. */
export function cancelSetup(sessionId: string): boolean {
  const proc = useScriptsStore.getState().setups[sessionId]
  if (!proc) return false
  if (proc.status === 'running') {
    owners.delete(proc.id)
    void window.api.scripts.stop(proc.id)
  }
  clearSetup(sessionId)
  settle(sessionId, 'abort')
  return true
}
