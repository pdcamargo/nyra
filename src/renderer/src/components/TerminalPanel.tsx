import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useTerminalsStore, type TerminalTab } from '../store/terminals'
import { configDirOf } from '../store/workspaces'

type Entry = { term: Terminal; fitAddon: FitAddon; wrapper: HTMLDivElement }

/** Every open tab, in every project and workspace — one string, so the
 *  selector hands back something stable. */
const allTabIds = (state: ReturnType<typeof useTerminalsStore.getState>): string =>
  Object.values(state.byProject)
    .flatMap((panel) => panel.tabs.map((t) => t.id))
    .join('\n')

interface TerminalPanelProps {
  cwd: string
  tabs: TerminalTab[]
  activeTabId: string | null
  visible: boolean
  onTabsChange: (tabs: TerminalTab[]) => void
}

export default function TerminalPanel({ cwd, tabs, activeTabId, visible, onTabsChange }: TerminalPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Every shell this panel has started, not only the ones on screen: the tabs
  // passed in are one project's (or one workspace's), and switching away from
  // it hides its terminals rather than ending them.
  const terminalsRef = useRef<Map<string, Entry>>(new Map())
  const openIds = useTerminalsStore(allTabIds)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Initialize/show the active terminal
  useEffect(() => {
    // Hidden first, whatever happens next: with no chat open there is nothing to
    // start, and a shell from the project you left must not stay on screen
    // under this one's tabs.
    for (const [id, entry] of terminalsRef.current) {
      entry.wrapper.style.display = id === activeTabId ? '' : 'none'
    }

    if (!activeTabId || !containerRef.current || !cwd || !visible) return

    if (terminalsRef.current.has(activeTabId)) {
      const entry = terminalsRef.current.get(activeTabId)!
      setTimeout(() => entry.fitAddon.fit(), 0)
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Fira Code Variable', 'SF Mono', Menlo, monospace",
      // Only the chrome follows the app theme. The ANSI 16 stay put: they are
      // terminal semantics that programs address by index, not app styling.
      theme: {
        // Fully transparent: allowTransparency is on, so the terminal composites
        // onto the panel behind it. Naming a colour here meant two backgrounds
        // that had to agree, and the container's padding drew the gap between
        // them as a frame.
        background: '#00000000',
        foreground: '#d9d9d9',
        cursor: '#d9d9d9',
        selectionBackground: 'rgba(217, 217, 217, 0.18)',
        black: '#1a1a1a',
        red: '#ff6b6b',
        green: '#69db7c',
        yellow: '#ffd43b',
        blue: '#74c0fc',
        magenta: '#da77f2',
        cyan: '#66d9e8',
        white: '#e5e5e5',
        brightBlack: '#555555',
        brightRed: '#ff8787',
        brightGreen: '#8ce99a',
        brightYellow: '#ffe066',
        brightBlue: '#91d5ff',
        brightMagenta: '#e599f7',
        brightCyan: '#99e9f2',
        brightWhite: '#ffffff'
      },
      allowTransparency: true,
      scrollback: 5000
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    const wrapper = document.createElement('div')
    wrapper.style.width = '100%'
    wrapper.style.height = '100%'
    containerRef.current.appendChild(wrapper)

    term.open(wrapper)
    fitAddon.fit()

    terminalsRef.current.set(activeTabId, { term, fitAddon, wrapper })

    const termId = activeTabId
    // Under the workspace the tab was opened in, fixed for the shell's life.
    const startedUnder = tabsRef.current.find((t) => t.id === termId)?.workspaceId
    window.api.terminal.spawn(termId, cwd, configDirOf(startedUnder))

    term.onData((data) => {
      window.api.terminal.write(termId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.terminal.resize(termId, cols, rows)
    })

    setTimeout(() => {
      fitAddon.fit()
      window.api.terminal.resize(termId, term.cols, term.rows)
    }, 50)
  }, [activeTabId, cwd, visible])

  // Refit when becoming visible (tab switched back from Processes)
  useEffect(() => {
    if (visible && activeTabId) {
      const entry = terminalsRef.current.get(activeTabId)
      if (entry) setTimeout(() => entry.fitAddon.fit(), 0)
    }
  }, [visible, activeTabId])

  // Listen for PTY data and exit events
  useEffect(() => {
    const unsubData = window.api.terminal.onData(({ id, data }) => {
      const entry = terminalsRef.current.get(id)
      if (entry) entry.term.write(data)
    })

    const unsubExit = window.api.terminal.onExit(({ id }) => {
      const entry = terminalsRef.current.get(id)
      if (entry) {
        entry.term.writeln('\r\n\x1b[90m[Process exited]\x1b[0m')
      }
    })

    return () => {
      unsubData()
      unsubExit()
    }
  }, [])

  // Handle resize with ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return
    resizeObserverRef.current = new ResizeObserver(() => {
      if (activeTabId) {
        const entry = terminalsRef.current.get(activeTabId)
        if (entry) {
          try { entry.fitAddon.fit() } catch { /* ignore */ }
        }
      }
    })
    resizeObserverRef.current.observe(containerRef.current)
    return () => resizeObserverRef.current?.disconnect()
  }, [activeTabId])

  // Dispose terminals whose tabs were closed — anywhere, not merely off screen.
  // This used to compare against the tabs passed in, which are one project's, so
  // switching project or workspace killed every shell of the one you left, and
  // left its wrapper behind to push the next terminal out of view.
  useEffect(() => {
    const open = new Set(openIds.split('\n'))
    for (const [id, entry] of terminalsRef.current) {
      if (!open.has(id)) {
        entry.term.dispose()
        entry.wrapper.remove()
        terminalsRef.current.delete(id)
        window.api.terminal.kill(id)
      }
    }
  }, [openIds])

  // Kill every PTY when the panel really goes away.
  //
  // Mount-scoped on purpose. This used to depend on `onTabsChange`, which the
  // parent passes as an inline arrow — a new identity on every render — so the
  // cleanup ran on *every* re-render, disposing live terminals and killing their
  // processes. Switching to the Processes tab re-renders the parent, which is why
  // the terminals vanished there and never came back: the tabs stayed in the
  // store, but the xterm instances behind them had been destroyed.
  useEffect(() => {
    const terminals = terminalsRef.current
    return () => {
      for (const [id, entry] of terminals) {
        entry.term.dispose()
        entry.wrapper.remove()
        window.api.terminal.kill(id)
      }
      terminals.clear()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 bg-background"
      style={{ position: 'relative' }}
    />
  )
}
