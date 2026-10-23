import { create } from 'zustand'

/**
 * Which chats have a permission prompt open, and for which tool.
 *
 * The queue itself stays in `Chat`, which owns answering it. This is the part
 * the sidebar needs — a chat stopped on "Allow Bash?" looks idle from the rail
 * otherwise, and when it sits in another project, nothing else on screen says
 * it is stuck. Not persisted, for the reason `running` is not: a prompt does
 * not survive a reload.
 */
interface PendingPermissionsState {
  /** Session id → the tool of the first prompt queued for it. */
  bySession: Record<string, string>
  publish: (queue: readonly { tool_name: string; nyraSessionId?: string }[]) => void
}

export const usePendingPermissionsStore = create<PendingPermissionsState>((set) => ({
  bySession: {},
  publish: (queue) => {
    const bySession: Record<string, string> = {}
    for (const p of queue) {
      if (p.nyraSessionId && !bySession[p.nyraSessionId]) bySession[p.nyraSessionId] = p.tool_name
    }
    set({ bySession })
  }
}))
