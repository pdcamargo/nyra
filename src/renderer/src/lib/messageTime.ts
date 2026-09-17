/**
 * When a message was sent or arrived, said the way a person would.
 *
 * Today needs no date. This week needs the day, because "Wednesday 10:11 PM"
 * locates a conversation better than a date does. Older than that and the day
 * name stops helping, so the date takes over.
 *
 * Locale-formatted throughout: the ordering, the separators and whether it says
 * PM at all are not ours to decide.
 */
export function formatMessageTime(timestamp: number, now: number = Date.now()): string {
  const then = new Date(timestamp)
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (then.getTime() >= startOfToday.getTime()) return time

  const sixDaysBack = startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000
  if (then.getTime() >= sixDaysBack) {
    return `${then.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`
  }

  const sameYear = then.getFullYear() === new Date(now).getFullYear()
  const date = then.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })
  return `${date}, ${time}`
}
