import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAnnotationsStore, useSessionAnnotations } from '../../store/annotations'
import { rangeAt } from '../../lib/chatAnnotations'
import { setHighlight } from '../../lib/annotationHighlights'

type Pin = { id: string; n: number; x: number; y: number }

const PIN = 18

/**
 * One message's pending annotations: the tint behind each range and a
 * numbered pin at its end. Sits over the message's text as an absolutely
 * placed sibling, so it never changes the row's height — the virtualiser
 * measured that without it.
 *
 * Ranges are rebuilt from offsets whenever the row mounts or reflows; the
 * highlight registry is told when they go, so an unmounted row leaves no
 * tint pointing at nothing.
 */
export default function AnnotationLayer({
  sessionId,
  messageId,
  rootRef,
  text
}: {
  sessionId: string | null | undefined
  messageId: string
  rootRef: React.RefObject<HTMLElement | null>
  /** The message's text, so a reply still streaming re-places its pins. */
  text: string
}): React.JSX.Element | null {
  const all = useSessionAnnotations(sessionId)
  const mine = useMemo(() => all.filter((a) => a.messageId === messageId), [all, messageId])
  const [pins, setPins] = useState<Pin[]>([])
  const layer = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || mine.length === 0) {
      setPins([])
      return
    }
    const ids = mine.map((a) => a.id)
    const place = (): void => {
      const origin = layer.current?.getBoundingClientRect()
      if (!origin) return
      const next: Pin[] = []
      for (const a of mine) {
        const range = rangeAt(root, a.start, a.end)
        setHighlight('nyra-annotation', a.id, range)
        const rects = range?.getClientRects()
        const last = rects?.[rects.length - 1]
        if (!last) continue
        next.push({
          id: a.id,
          n: all.indexOf(a) + 1,
          // Just past the last character, lifted like a footnote mark.
          x: Math.min(last.right - origin.left - 3, origin.width - PIN / 2),
          y: last.top - origin.top - PIN / 2 + 2
        })
      }
      setPins(next)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(root)
    return () => {
      observer.disconnect()
      for (const id of ids) setHighlight('nyra-annotation', id, null)
    }
  }, [mine, all, rootRef, text])

  if (pins.length === 0) return <div ref={layer} className="pointer-events-none absolute inset-0" />
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0">
      {pins.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-label={`Edit annotation ${p.n}`}
          onClick={() => useAnnotationsStore.getState().edit(p.id)}
          className="pointer-events-auto absolute flex items-center justify-center rounded-full bg-info text-[11px] font-semibold text-info-foreground tabular-nums shadow-panel transition-transform select-none hover:scale-110"
          style={{ left: p.x, top: p.y, width: PIN, height: PIN }}
        >
          {p.n}
        </button>
      ))}
    </div>
  )
}
