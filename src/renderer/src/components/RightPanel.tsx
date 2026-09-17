import React from 'react'
import BrowserPanel from './browser/BrowserPanel'
import { usePanelLayoutStore } from '../store/panelLayout'

/**
 * The right panel.
 *
 * It used to hold four tabs — agents, context, MCP, memory — with the browser
 * taking the whole panel as a fifth mode, so two title-bar buttons fought over
 * one strip of window and each could close the other. The tabs are gone: agents
 * and context said what the summary and the composer already say, MCP is
 * configuration and lives in settings, and memory is a library, which belongs in
 * the left rail beside the other libraries. What is left is the browser, behind
 * one button.
 */
export default function RightPanel(): React.JSX.Element {
  const width = usePanelLayoutStore((s) => s.rightPanelWidth)

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-l border-border/55 bg-card"
    >
      <BrowserPanel />
    </aside>
  )
}
