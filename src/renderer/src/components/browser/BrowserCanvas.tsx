import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { browserHub, useBrowserStore } from '../../store/browser'
import type { CdpConnection } from '../../lib/browser/cdp'
import { useElementDpr } from '../../lib/browser/dpr'
import type { Subscription, Want } from '../../lib/browser/screencast'
import { buttonName, keyEventOf, modifiersOf, pageFromCanvas } from '../../lib/browser/input'

/**
 * One tab's pixels, and — when it is the real panel rather than a preview —
 * one tab's input.
 *
 * The canvas takes its intrinsic size from the frame and its display size from
 * its container. Those are two different numbers on purpose: the container is
 * sized by whoever owns the layout, and the frame arrives at whatever
 * resolution is available, so a still sharpened to the full device-pixel raster
 * and a live frame capped at the CSS viewport both land in the same box.
 *
 * The size it asks for is in device pixels, measured off the element rather
 * than computed from `width`. Asking in CSS pixels and then drawing onto a
 * Retina canvas is a straight upscale, which is what made the panel look soft.
 *
 * It does not choose what the page renders at — the sidecar does. See the
 * ownership note in `screencast.ts`.
 */
export default function BrowserCanvas({
  targetId,
  width,
  everyNthFrame = 1,
  interactive = false,
  preview = false,
  onUserInput,
  className = ''
}: {
  targetId: string | null
  /** CSS pixels this surface will occupy. The hub streams at the largest width
   *  any surface asked for, so a miniature never downgrades the panel. */
  width: number
  everyNthFrame?: number
  /** Previews are for looking at. Only the panel takes input. */
  interactive?: boolean
  /** A miniature: cheaper frames, and never worth a sharpening screenshot. */
  preview?: boolean
  /** The person touched the page. Whoever is drawing an agent on the wheel
   *  should stop — they have taken it back. */
  onUserInput?: () => void
  className?: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<{ conn: CdpConnection; sessionId: string } | null>(null)
  const subRef = useRef<Subscription | null>(null)
  const cdpUrl = useBrowserStore((s) => s.cdpUrl)
  // Primitives, not the object. A `tabs` broadcast lands on every navigation,
  // title change and loading flip, and selecting the record itself would hand
  // back a fresh identity each time — which, in the effect below, is a
  // detach-and-reattach per navigation.
  const vpWidth = useBrowserStore(
    (s) => (targetId ? s.viewportByTarget[targetId]?.width : undefined) ?? s.viewport.width
  )
  const vpHeight = useBrowserStore(
    (s) => (targetId ? s.viewportByTarget[targetId]?.height : undefined) ?? s.viewport.height
  )
  const viewport = useMemo(() => ({ width: vpWidth, height: vpHeight }), [vpWidth, vpHeight])
  // Quantised to two decimals inside the hook, so this is stable across
  // re-layouts and only moves when the display or the app's zoom does.
  const pixelRatio = useElementDpr(canvasRef)

  /** What this surface currently wants. Kept in a ref as well as in the effect
   *  below, because the attach is async and a resize can land before it. */
  const want: Want = useMemo(
    () => ({ width, devicePixels: Math.ceil(width * pixelRatio), everyNthFrame, preview }),
    [width, pixelRatio, everyNthFrame, preview]
  )
  const wantRef = useRef(want)

  // Attach. Deliberately does not depend on size: resizing a surface is not the
  // same event as detaching it, and tearing this down on a drag stops the
  // stream and starts it again once per mousemove.
  useEffect(() => {
    if (!cdpUrl || !targetId) return
    let cancelled = false

    void browserHub(cdpUrl)
      .then(async ({ conn, hub }) => {
        if (cancelled) return
        subRef.current = hub.subscribe(targetId, wantRef.current, (bitmap) => {
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
      subRef.current?.stop()
      subRef.current = null
    }
    // Not `viewport` either: a size change restarts the stream through the
    // hub's `invalidate`, which does not need this session torn down.
  }, [cdpUrl, targetId, interactive])

  // Resize. A cheap imperative poke, and usually a no-op inside the hub.
  useEffect(() => {
    wantRef.current = want
    subRef.current?.update(want)
  }, [want])

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
              onUserInput?.()
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
      onKeyDown={
        interactive
          ? (e) => {
              onUserInput?.()
              onKey(e, 'down')
            }
          : undefined
      }
      onKeyUp={interactive ? (e) => onKey(e, 'up') : undefined}
      // `object-contain` is not decoration. A frame can briefly disagree with
      // the box it lands in — a navigation reverts the page for a beat, a
      // device change lands before the new stream does — and without this the
      // canvas stretches it to fit, which reads as the page distorting. Letting
      // it letterbox instead makes a stale frame look merely stale.
      className={`block bg-background object-contain ${
        interactive ? 'cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring' : ''
      } ${className}`}
    />
  )
}
