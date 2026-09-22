import React from 'react'
import WorkspacePanel from './workspace/WorkspacePanel'
import { usePanelLayoutStore } from '../store/panelLayout'

/**
 * The right panel.
 *
 * It used to hold four tabs — agents, context, MCP, memory — with the browser
 * taking the whole panel as a fifth mode, so two title-bar buttons fought over
 * one strip of window and each could close the other. Those tabs are gone:
 * agents and context said what the summary and the composer already say, MCP is
 * configuration and lives in settings, and memory is a library, which belongs in
 * the left rail beside the other libraries.
 *
 * What is left is one panel behind one button, holding a strip of tabs that are
 * each either a page or a file. This component is only the frame — the width,
 * the border, and the surface everything else sits on.
 */
export default function RightPanel(): React.JSX.Element {
  const width = usePanelLayoutStore((s) => s.rightPanelWidth)

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-l border-border/55 bg-sidebar"
    >
      <WorkspacePanel />
    </aside>
  )
}
