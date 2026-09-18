import React from 'react'
import { FileText } from 'lucide-react'
import Empty from '../workspace/Empty'
import type { FileWorkspaceTab } from '../../store/workspace'

/**
 * One file tab: a preview on the left, a tree on the right.
 *
 * Both halves land in the next step; for now it is the empty state, which is
 * what the tab shows until a file is picked anyway.
 */
export default function FileTab({
  sessionId: _sessionId,
  tab
}: {
  sessionId: string
  tab: FileWorkspaceTab
}): React.JSX.Element {
  if (!tab.path) {
    return (
      <Empty>
        <FileText className="mb-3 size-6 text-muted-foreground/50" />
        <p className="mb-1 text-[12px] text-foreground">Open file</p>
        <p className="max-w-[240px] text-[11px] leading-relaxed text-muted-foreground">
          Select a file from the workspace tree.
        </p>
      </Empty>
    )
  }
  return <Empty>{tab.path}</Empty>
}
