/**
 * What a chat is holding in memory.
 *
 * The number comes from the backend's process table, not from the renderer:
 * only Rust knows the Claude process's pid, and the pid is the whole point. The
 * measurement sums RSS over that process's descendants plus the chat's
 * background shells, so Nyra's own memory and Chromium's are not in it — neither
 * hangs off a chat's Claude process.
 *
 * RSS is what a process costs, not what would be freed if it exited: shared
 * libraries land in several processes' RSS and are counted in each. That is the
 * right number for "which conversation is the heavy one", which is the only
 * question this gets asked.
 */
import type { ChatMemory } from './api-types'

export type { ChatMemory }

export async function readChatMemory(sessionId: string): Promise<ChatMemory | null> {
  try {
    return (await window.api.processes.memory(sessionId)) ?? null
  } catch {
    // A chat with no process left, or a process table that could not be read.
    // Either way there is nothing to draw, and the row's dash says so.
    return null
  }
}

/**
 * Bytes, at the size a person reads them.
 *
 * One decimal below 100 MB and none above: 812.4 MB and 1.2 GB are both useful,
 * 812.437 MB is not.
 */
export function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 100) return `${mb.toFixed(1)} MB`
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
