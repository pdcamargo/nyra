import type { Session, TextMessage } from '../store/sessions'

export type SessionMatch = {
  session: Session
  matchSource: 'title' | 'message'
  snippet: string
}

/**
 * Find sessions whose title or message text contains the query.
 *
 * Title matches win and stop the scan for that session, so a chat you can name
 * ranks by its name rather than by something buried in its transcript.
 */
export function searchSessions(sessions: Session[], query: string): SessionMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const results: SessionMatch[] = []

  for (const session of sessions) {
    if (session.title.toLowerCase().includes(q)) {
      results.push({ session, matchSource: 'title', snippet: session.title })
      continue
    }
    for (const msg of session.messages) {
      if (msg.role === 'tool_call') continue
      const text = (msg as TextMessage).text
      if (!text) continue
      const idx = text.toLowerCase().indexOf(q)
      if (idx === -1) continue
      const start = Math.max(0, idx - 30)
      const end = Math.min(text.length, idx + q.length + 50)
      results.push({
        session,
        matchSource: 'message',
        snippet:
          (start > 0 ? '…' : '') +
          text.slice(start, end).replace(/\s+/g, ' ') +
          (end < text.length ? '…' : '')
      })
      break
    }
  }
  return results
}

export type PromptHistoryItem = { text: string; timestamp: number; cwd: string }

/**
 * Every prompt you have sent, newest first, deduplicated by text.
 *
 * Drawn from the sessions themselves rather than a separate log, so it survives
 * whatever the transcript survives and never drifts from it.
 */
export function collectPromptHistory(sessions: Session[]): PromptHistoryItem[] {
  const items: PromptHistoryItem[] = []
  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.role !== 'user') continue
      const text = (msg as TextMessage).text
      if (text?.trim()) {
        items.push({ text, timestamp: msg.timestamp ?? session.createdAt, cwd: session.cwd })
      }
    }
  }
  items.sort((a, b) => b.timestamp - a.timestamp)
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.text)) return false
    seen.add(item.text)
    return true
  })
}
