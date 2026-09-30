import React, { useEffect, useRef, useState } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import Modal from './Modal'
import WorkspaceAvatar from './WorkspaceAvatar'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_WORKSPACE_ID, configDirOf, useWorkspacesStore } from '../store/workspaces'
import { accountLabel, useAccountsStore } from '../store/accounts'
import { useSettingsStore } from '../store/settings'

type LoginStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

// Heuristic — `claude /login` prints "Login successful" on success. Not a bare
// "logged in": that is also the tail of "Not logged in".
function detectSuccess(buffer: string): boolean {
  return /login successful|logged in as|authentication successful/i.test(buffer)
}

/** How long "Signed in as …" stays up before the window closes itself. */
const CLOSE_AFTER_MS = 1500

/**
 * `claude /login` in a terminal, for one workspace.
 *
 * Opened by `nyra:open-login` with `{ workspaceId }` — the active workspace
 * when none is given. The CLI runs with that workspace's `CLAUDE_CONFIG_DIR`,
 * so the login lands in its config and nowhere else, and the header says whose
 * account this is so signing in a second one is never a guess.
 */
export default function LoginModal(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<LoginStatus>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string>(DEFAULT_WORKSPACE_ID)
  // State, not a ref: the dialog portals its content in a render after `open`
  // flips, so an effect keyed on `open` alone ran before the container existed,
  // found nothing, and never ran again — the terminal was never drawn.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const bufferRef = useRef<string>('')
  const dataUnsubRef = useRef<(() => void) | null>(null)
  const exitUnsubRef = useRef<(() => void) | null>(null)
  const successDetectedRef = useRef(false)
  /** Which sign-in this is, so a close scheduled by one never closes the next. */
  const runRef = useRef(0)

  const workspace = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? s.workspaces[0]
  )
  const account = useAccountsStore((s) => s.byWorkspace[workspaceId])

  // Listen for global trigger
  useEffect(() => {
    const handler = (event: Event): void => {
      const requested = (event as CustomEvent<{ workspaceId?: string } | undefined>).detail?.workspaceId
      const target = requested ?? useWorkspacesStore.getState().activeId
      runRef.current += 1
      setWorkspaceId(target)
      setOpen(true)
      setStatus('running')
      setErrorMsg(null)
      bufferRef.current = ''
      successDetectedRef.current = false

      // Listening before the CLI starts, so nothing it prints first is lost to a
      // terminal that has not mounted yet: it is kept and written on mount.
      dataUnsubRef.current?.()
      exitUnsubRef.current?.()
      dataUnsubRef.current = window.api.login.onData(({ data }) => {
        bufferRef.current += data
        termRef.current?.write(data)
        if (!successDetectedRef.current && detectSuccess(bufferRef.current)) {
          successDetectedRef.current = true
          void confirmSignedIn(target)
        }
      })
      // Rarely the way a sign-in ends: after "Login successful" the CLI sits at
      // its own prompt and never exits by itself — `confirmSignedIn` ends it. An
      // exit that comes first, before any success, is a login that did not happen.
      exitUnsubRef.current = window.api.login.onExit(() => {
        setStatus((current) =>
          current === 'cancelled' || current === 'success' || successDetectedRef.current ? current : 'failed'
        )
      })

      window.api.login.start(configDirOf(target)).then((res) => {
        if (res.error) {
          setErrorMsg(res.error)
          setStatus('failed')
        }
      })
    }
    window.addEventListener('nyra:open-login', handler)
    return () => window.removeEventListener('nyra:open-login', handler)
  }, [])

  /**
   * The CLI said it signed in: believe it once the workspace's own `auth status`
   * agrees, then say whose account it is, close, and end the `claude` that
   * /login left sitting at its prompt.
   */
  const confirmSignedIn = async (target: string): Promise<void> => {
    const binary = useSettingsStore.getState().claudeBinaryPath
    const status = await window.api.claude.accountStatus(binary, configDirOf(target)).catch(() => null)
    if (!status?.loggedIn) {
      // Not signed in after all; keep listening for the real thing.
      successDetectedRef.current = false
      return
    }
    useAccountsStore.getState().record(target, status)
    setStatus('success')
    window.dispatchEvent(new CustomEvent('nyra:login-success', { detail: { workspaceId: target } }))
    const run = runRef.current
    setTimeout(() => {
      if (runRef.current !== run) return
      window.api.login.cancel()
      setOpen(false)
    }, CLOSE_AFTER_MS)
  }

  // Mount the terminal once the container is in the DOM
  useEffect(() => {
    if (!open || !container || termRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'Fira Code Variable', 'SF Mono', Menlo, monospace",
      theme: {
        background: '#0d0d0d',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5'
      },
      allowTransparency: true,
      scrollback: 2000,
      convertEol: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    fit.fit()
    // Whatever the CLI printed while the dialog was still opening.
    if (bufferRef.current) term.write(bufferRef.current)
    // Push the post-fit size to the PTY (start was spawned with default 100×30)
    setTimeout(() => {
      try {
        fit.fit()
        window.api.login.resize(term.cols, term.rows)
      } catch { /* ignore */ }
    }, 50)

    // Forward terminal keystrokes to the PTY
    term.onData((data) => {
      window.api.login.input(data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.login.resize(cols, rows)
    })

    termRef.current = term
    fitRef.current = fit

    // Resize on container size changes
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
    }
  }, [open, container])

  // Tear down terminal + listeners when modal closes
  useEffect(() => {
    if (open) return
    dataUnsubRef.current?.()
    exitUnsubRef.current?.()
    dataUnsubRef.current = null
    exitUnsubRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }, [open])

  if (!open) return null

  const handleCancel = (): void => {
    if (status === 'running') {
      window.api.login.cancel()
      setStatus('cancelled')
    }
    // Signed in, and closed before it closed itself: the CLI /login left at its
    // prompt still has to go.
    if (status === 'success') window.api.login.cancel()
    setOpen(false)
  }

  const who = accountLabel(account)
  const subtitle = {
    idle: 'Starting…',
    running: 'claude /login — type or paste directly into the terminal',
    success: who ? `Signed in as ${who}` : 'Logged in. Resuming your task…',
    failed: errorMsg ?? 'Login did not complete.',
    cancelled: who
      ? `Cancelled. Still signed in as ${who}.`
      : `Cancelled. ${workspace.name} stays signed out; sign in any time from Usage.`
  }[status]

  return (
    <Modal onClose={handleCancel} title={`Sign in to ${workspace.name}`} className="max-w-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
          <div className="flex min-w-0 items-center gap-3">
            <WorkspaceAvatar workspace={workspace} className="size-7 rounded-md text-[11px]" />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold text-foreground">Sign in to {workspace.name}</h2>
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                {status === 'success' && <CircleCheck className="size-3 shrink-0 text-success" />}
                {status === 'cancelled' && <CircleX className="size-3 shrink-0" />}
                <span className="truncate">{subtitle}</span>
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="text-[11px] text-muted-foreground hover:text-foreground/80 px-2 py-1 rounded-sm"
          >
            {status === 'running' ? 'Cancel' : 'Close'}
          </button>
        </div>

        <div className="p-3 bg-background">
          <div ref={setContainer} className="h-80 w-full" />
        </div>

        <div className="px-5 py-2.5 border-t border-border">
          <p className="text-[10px] text-muted-foreground">
            Click the auth URL to open it in your browser, then paste the code back into the terminal above.
          </p>
        </div>
      </Modal>
  )
}
