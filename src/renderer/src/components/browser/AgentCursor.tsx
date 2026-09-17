import React, { useEffect, useState } from 'react'
import type { AgentCursor as Cursor } from '../../store/browser'

/** How long the ghost lingers after the agent's last move. Long enough to
 *  follow a sequence of clicks, short enough that a still cursor is not left
 *  sitting on the page implying something is happening. */
const LINGER_MS = 4000

/**
 * Where the agent's pointer is.
 *
 * Both of us drive this page and every event either of us sends is synthetic,
 * so there is nothing in the page that says which clicks were the agent's. This
 * is the answer: the sidecar reports where the pointer went during a tool call,
 * and the ghost shows up there. Yours is the real one your hand is on.
 */
export default function AgentCursor({
  cursor,
  tabId,
  viewport
}: {
  cursor: Cursor | null
  tabId: string | null
  viewport: { width: number; height: number }
}): React.JSX.Element | null {
  const [, tick] = useState(0)

  // Re-render once when the linger is up, so the ghost actually goes away
  // rather than waiting for the next unrelated render.
  useEffect(() => {
    if (!cursor) return
    const remaining = cursor.at + LINGER_MS - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => tick((n) => n + 1), remaining)
    return () => clearTimeout(timer)
  }, [cursor])

  if (!cursor || cursor.tabId !== tabId) return null
  const age = Date.now() - cursor.at
  if (age > LINGER_MS) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute transition-[left,top] duration-300 ease-out"
      style={{
        // Percentages, because the canvas is scaled and the page is not.
        left: `${(cursor.x / viewport.width) * 100}%`,
        top: `${(cursor.y / viewport.height) * 100}%`,
        // Fade over the last second rather than vanishing mid-gesture.
        opacity: age > LINGER_MS - 1000 ? (LINGER_MS - age) / 1000 : 1
      }}
    >
      <div className="relative -left-1 -top-1">
        <span className="absolute size-5 animate-ping rounded-full bg-info/40" />
        <svg viewBox="0 0 12 18" className="relative size-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
          <path d="M1 1 L1 15 L4.5 11.5 L7 17 L9.5 16 L7 10.5 L11 10.5 Z" className="fill-info stroke-background" strokeWidth="1.2" />
        </svg>
      </div>
    </div>
  )
}
