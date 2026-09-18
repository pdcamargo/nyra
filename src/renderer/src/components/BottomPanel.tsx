import React, { useCallback, useEffect, useRef } from 'react'
import { Activity, SquareTerminal, X } from 'lucide-react'
import TerminalPanel from './TerminalPanel'
import ProcessesView from './ProcessesView'
import { useUiStore } from '../store/ui'
import { useTerminalsStore, panelFor, NO_PROJECT } from '../store/terminals'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const PROCESSES_TAB_ID = '__processes__'

/**
 * Terminals and background processes.
 *
 * Tab state lives in the terminals store rather than here: this component is
 * unmounted whenever the panel is closed, and the tabs are per project, not per
 * chat — switching projects should show that project's shells, not re-cd the ones
 * you already had open.
 */
export default function BottomPanel({
  cwd,
  projectId
}: {
  cwd: string
  projectId: string | null
}): React.JSX.Element {
  const key = projectId ?? NO_PROJECT
  const { tabs, activeTabId } = useTerminalsStore((s) => panelFor(s, key))

  const createTerminal = useCallback(() => {
    useTerminalsStore.getState().createTerminal(key)
  }, [key])

  const setTabs = useCallback(
    (next: { id: string; title: string }[]) => {
      useTerminalsStore.getState().setTabs(key, next)
    },
    [key]
  )

  const closeTerminal = useCallback(
    (id: string) => {
      useTerminalsStore.getState().closeTerminal(key, id)
      void window.api.terminal.kill(id)
    },
    [key]
  )

  // Give a project its first terminal the first time its panel is opened. The
  // StrictMode guard is per project, so switching projects still gets one.
  const seeded = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (seeded.current.has(key)) return
    seeded.current.add(key)
    if (panelFor(useTerminalsStore.getState(), key).tabs.length === 0) {
      const id = useTerminalsStore.getState().createTerminal(key)
      if (useUiStore.getState().bottomPanelFocusNonce > 0) {
        useTerminalsStore.getState().setActiveTab(key, id)
      }
    }
  }, [key])

  // Switch to Processes when an external trigger (the tasks chip, /tasks) asks.
  //
  // Reacting to a *change* in the nonce, not to its value: this panel unmounts
  // whenever it is closed, so `> 0` meant that once you had used the chip even
  // once, every later reopen forced you onto Processes.
  const focusNonce = useUiStore((s) => s.bottomPanelFocusNonce)
  const lastNonce = useRef(focusNonce)
  useEffect(() => {
    if (focusNonce === lastNonce.current) return
    lastNonce.current = focusNonce
    useTerminalsStore.getState().setActiveTab(key, null)
  }, [focusNonce, key])

  const showingProcesses = activeTabId === null || activeTabId === PROCESSES_TAB_ID

  return (
    <div className="flex flex-col h-full bg-background border-t border-border/55">
      {/* Tab bar */}
      <div className="flex items-center gap-0 px-2 h-8 min-h-[32px] bg-muted border-b border-border/55">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={`flex items-center gap-1.5 px-3 py-1 text-[11px] cursor-pointer rounded-t transition-colors ${
                active ? 'text-foreground/80 bg-background' : 'text-muted-foreground hover:text-foreground/80'
              }`}
              onClick={() => useTerminalsStore.getState().setActiveTab(key, tab.id)}
            >
              <SquareTerminal className="size-3" />
              <span>{tab.title}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id) }}
                    className="text-muted-foreground/70 hover:text-foreground/80 ml-1"
                    aria-label="Close terminal"
                  >
                    <X className="size-2.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Close terminal</TooltipContent>
              </Tooltip>
            </div>
          )
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={createTerminal}
              className="text-muted-foreground/70 hover:text-foreground/80 px-2 py-1 text-[13px] transition-colors"
            >
              +
            </button>
          </TooltipTrigger>
          <TooltipContent>New terminal</TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={`flex items-center gap-1.5 px-3 py-1 text-[11px] cursor-pointer rounded-t transition-colors ${
                showingProcesses ? 'text-foreground/80 bg-background' : 'text-muted-foreground hover:text-foreground/80'
              }`}
              onClick={() => useTerminalsStore.getState().setActiveTab(key, null)}
            >
              <Activity className="size-3" />
              <span>Processes</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Background processes</TooltipContent>
        </Tooltip>
      </div>

      {/* Terminal view — kept mounted to preserve xterm state when toggling tabs */}
      <div className={`${showingProcesses ? 'hidden' : 'flex flex-1 min-h-0'}`}>
        <TerminalPanel
          cwd={cwd}
          tabs={tabs}
          activeTabId={showingProcesses ? null : activeTabId}
          visible={!showingProcesses}
          onTabsChange={setTabs}
        />
      </div>

      {/* Processes view */}
      {showingProcesses && <ProcessesView />}
    </div>
  )
}
