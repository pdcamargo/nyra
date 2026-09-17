import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export interface TerminalTab {
  id: string
  title: string
}

interface TerminalPanelProps {
  cwd: string
  tabs: TerminalTab[]
  activeTabId: string | null
  visible: boolean
  onTabsChange: (tabs: TerminalTab[]) => void
}

export default function TerminalPanel({ cwd, tabs, activeTabId, visible, onTabsChange }: TerminalPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalsRef = useRef<Map<string, { term: Terminal; fitAddon: FitAddon }>>(new Map())
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Initialize/show the active terminal
  useEffect(() => {
    if (!activeTabId || !containerRef.current || !cwd || !visible) return

    for (const [id, entry] of terminalsRef.current) {
      const el = entry.term.element?.parentElement
      if (el) el.style.display = id === activeTabId ? '' : 'none'
    }

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

    terminalsRef.current.set(activeTabId, { term, fitAddon })

    const termId = activeTabId
    window.api.terminal.spawn(termId, cwd)

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

  // Dispose terminals whose tabs were removed
  useEffect(() => {
    const liveIds = new Set(tabs.map((t) => t.id))
    for (const [id, entry] of terminalsRef.current) {
      if (!liveIds.has(id)) {
        entry.term.dispose()
        terminalsRef.current.delete(id)
        window.api.terminal.kill(id)
      }
    }
  }, [tabs])

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
