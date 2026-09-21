import React, { useEffect, useState } from 'react'
import type { AgentCursor as Cursor } from '../../store/browser'

/** Long enough to read as letting go rather than blinking out. */
const RELEASE_MS = 700

/** A press is worth marking for about this long. */
const CLICK_MS = 500

/**
 * Where the agent's pointer is.
 *
 * Both of us drive this page and every event either of us sends is injected, so
 * there is nothing in the page that says which clicks were the agent's. This is
 * the answer: the sidecar reports what the agent did, and the ghost shows up
 * there. Yours is the real one your hand is on.
 *
 * It stays for as long as the agent has the wheel, rather than for a few
 * seconds after each move. The first version only appeared when a tool call
 * happened to move the pointer, which meant it flashed briefly a few times a
 * turn and was, in practice, never seen at all. A turn that types, scrolls or
 * navigates is still the agent driving — so the ghost parks in the middle when
 * it has no better idea, and every later move is a glide from somewhere known
 * rather than a pop out of nowhere.
 */
export default function AgentCursor({
  cursor,
  tabId,
  viewport,
  driving
}: {
  cursor: Cursor | null
  tabId: string | null
  viewport: { width: number; height: number }
  /** The agent has this tab, and the turn is still running. */
  driving: boolean
}): React.JSX.Element | null {
  // Kept mounted through the fade, so letting go is visible.
  const [mounted, setMounted] = useState(driving)

  useEffect(() => {
    if (driving) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), RELEASE_MS)
    return () => clearTimeout(timer)
  }, [driving])

  if (!mounted) return null

  // A position from another tab is not this tab's, and the middle is a better
  // answer than a corner or nothing at all.
  const here = cursor && cursor.tabId === tabId ? cursor : null
  const x = here?.x ?? viewport.width / 2
  const y = here?.y ?? viewport.height / 2
  const clicking = Boolean(here?.down) && Date.now() - (here?.at ?? 0) < CLICK_MS

  return (
    <div
      aria-hidden
      // Percentages, because the canvas is scaled and the page is not. The glide
      // is the whole point of keeping this mounted: moving between two known
      // points reads as a hand, popping in at the destination does not.
      className="pointer-events-none absolute transition-[left,top,opacity] duration-500 ease-out"
      style={{
        left: `${(x / viewport.width) * 100}%`,
        top: `${(y / viewport.height) * 100}%`,
        opacity: driving ? 1 : 0
      }}
    >
      <div className="relative -left-1 -top-1">
        {/* Always on, so the ghost is findable while it sits still. */}
        <span className="absolute -left-1 -top-1 size-7 rounded-full bg-info/20" />
        {here && clicking && <ClickRipple at={here.at} />}
        <svg
          viewBox="0 0 12 18"
          className="relative size-5 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]"
        >
          <path
            d="M1 1 L1 15 L4.5 11.5 L7 17 L9.5 16 L7 10.5 L11 10.5 Z"
            className="fill-info stroke-background"
            strokeWidth="1.2"
          />
        </svg>
      </div>
    </div>
  )
}

/**
 * One expanding ring per press.
 *
 * A transition rather than a keyframe animation, because a keyframe that loops
 * says "still happening" and a click is over the moment it lands. Remounted by
 * its key on every new press, which is what restarts it.
 */
function ClickRipple({ at }: { at: number }): React.JSX.Element {
  const [out, setOut] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOut(true))
    return () => cancelAnimationFrame(frame)
  }, [at])

  return (
    <span
      className="absolute -left-2 -top-2 size-9 rounded-full bg-info transition-all duration-500 ease-out"
      style={{ transform: out ? 'scale(1)' : 'scale(0.2)', opacity: out ? 0 : 0.55 }}
    />
  )
}
