import type { KeepAwakeStatus } from './tauri-api'

function count(n: number, one: string, many: string): string | null {
  if (n === 0) return null
  return `${n} ${n === 1 ? one : many}`
}

/** What is holding the machine awake, as one line: "2 chats replying · 1 monitor running". */
export function awakeReasons(status: KeepAwakeStatus): string {
  return [
    count(status.chats, 'chat replying', 'chats replying'),
    count(status.monitors, 'monitor running', 'monitors running'),
    count(status.tasks, 'background task', 'background tasks'),
    count(status.flows, 'flow running', 'flows running')
  ]
    .filter(Boolean)
    .join(' · ')
}

/** "for 14 min", "for 2 h 5 min"; nothing under a minute. */
export function heldFor(since: number | null, now: number): string {
  if (since === null) return ''
  const minutes = Math.floor((now - since) / 60_000)
  if (minutes < 1) return ''
  if (minutes < 60) return `for ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `for ${hours} h` : `for ${hours} h ${rest} min`
}
