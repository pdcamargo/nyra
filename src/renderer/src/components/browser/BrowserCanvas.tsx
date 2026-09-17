import React, { useCallback, useEffect, useRef } from 'react'
import { browserHub, useBrowserStore } from '../../store/browser'
import type { CdpConnection } from '../../lib/browser/cdp'
import { buttonName, keyEventOf, modifiersOf, pageFromCanvas } from '../../lib/browser/input'

/**
 * One tab's pixels, and — when it is the real panel rather than a preview —
 * one tab's input.
 *
 * The canvas takes its intrinsic size from the frame and its display size from
 * the container, so the page renders at the pinned viewport and is scaled into
 * whatever room there is. That is why the page never reflows to a phone layout
 * when the panel is narrow, and it is also what makes canvas coordinates
 * convert to page coordinates with a single multiply.
 */
export default function BrowserCanvas({
  targetId,
  width,
  everyNthFrame = 2,
  interactive = false,
  className = ''
}: {
  targetId: string | null
  /** CSS pixels this surface will occupy. The hub streams at the largest width
   *  any surface asked for, so a miniature never downgrades the panel. */
  width: number
  everyNthFrame?: number
  /** Previews are for looking at. Only the panel takes input. */
  interactive?: boolean
  className?: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<{ conn: CdpConnection; sessionId: string } | null>(null)
  const cdpUrl = useBrowserStore((s) => s.cdpUrl)
  const viewport = useBrowserStore((s) => s.viewport)

  useEffect(() => {
    if (!cdpUrl || !targetId) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void browserHub(cdpUrl, viewport)
      .then(async ({ conn, hub }) => {
        if (cancelled) return
        unsubscribe = hub.subscribe(targetId, { width, everyNthFrame }, (bitmap) => {
          const canvas = canvasRef.current
          if (!canvas) return
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        })
        if (!interactive) return
        const sessionId = await hub.session(targetId)
        if (!cancelled) liveRef.current = { conn, sessionId }
      })
      .catch(() => {
        // The panel renders the connection failure from store state; a rejected
        // promise here would only be an unhandled one.
      })

    return () => {
      cancelled = true
      liveRef.current = null
      unsubscribe?.()
    }
  }, [cdpUrl, targetId, width, everyNthFrame, interactive, viewport])

  /** Fire and forget. CDP preserves order per session, so a press and its
   *  release cannot cross, and awaiting each round trip would put the socket's
   *  whole latency between a click and its effect. */
  const send = useCallback((method: string, params: Record<string, unknown>) => {
    const live = liveRef.current
    if (!live) return
    void live.conn.send(method, params, live.sessionId).catch(() => {})
  }, [])

  const pointOf = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return { x: 0, y: 0 }
      return pageFromCanvas({ x: clientX, y: clientY }, canvas.getBoundingClientRect(), viewport)
    },
    [viewport]
  )

  const mouse = useCallback(
    (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', event: React.MouseEvent) => {
      const { x, y } = pointOf(event.clientX, event.clientY)
      send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' && event.buttons === 0 ? 'none' : buttonName(event.button),
        buttons: event.buttons,
        modifiers: modifiersOf(event),
        clickCount: type === 'mouseMoved' ? 0 : Math.max(1, event.detail)
      })
    },
    [pointOf, send]
  )

  // Wheel and paste want native listeners: React's wheel handler is passive, so
  // preventDefault there is ignored and the panel scrolls instead of the page.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !interactive) return

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const { x, y } = pointOf(event.clientX, event.clientY)
      send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        // Straight through, not negated: CDP's wheel deltas use the same sign
        // convention as the DOM's, so positive deltaY scrolls down in both.
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifiersOf(event)
      })
    }

    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      // The page cannot reach the real clipboard, and forwarding Cmd+V as a
      // shortcut would paste nothing. Insert the text directly instead.
      send('Input.insertText', { text })
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('paste', onPaste)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('paste', onPaste)
    }
  }, [interactive, pointOf, send])

  const onKey = useCallback(
    (event: React.KeyboardEvent, type: 'down' | 'up') => {
      // Typing goes to the page; ⌘ stays with Nyra, so ⌘Q, ⌘W and the command
      // palette still work while the canvas has focus. Paste is the one ⌘
      // combination worth having in the page, and the paste listener has it.
      if (event.metaKey) return
      event.preventDefault()
      send('Input.dispatchKeyEvent', keyEventOf(event, type))
    },
    [send]
  )

  return (
    <canvas
      ref={canvasRef}
      // Until the first frame lands the element has no intrinsic size, so the
      // aspect ratio keeps the box from collapsing and the layout from jumping.
      style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? 'Browser page' : undefined}
      onMouseDown={
        interactive
          ? (e) => {
              canvasRef.current?.focus()
              mouse('mousePressed', e)
            }
          : undefined
      }
      onMouseMove={interactive ? (e) => mouse('mouseMoved', e) : undefined}
      onMouseUp={interactive ? (e) => mouse('mouseReleased', e) : undefined}
      onMouseLeave={
        interactive
          ? (e) => {
              // Release a button that went down here and came up somewhere else,
              // or the page is stuck mid-drag forever.
              if (e.buttons !== 0) mouse('mouseReleased', e)
            }
          : undefined
      }
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={interactive ? (e) => onKey(e, 'down') : undefined}
      onKeyUp={interactive ? (e) => onKey(e, 'up') : undefined}
      className={`block h-auto w-full bg-background ${
        interactive ? 'cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring' : ''
      } ${className}`}
    />
  )
}
