import { useCallback, useEffect, useRef } from 'react'

/** How long the bar stays up after the last scroll event. */
const LINGER_MS = 700

/**
 * A scrollbar that is only there while it is being used.
 *
 * WebKit can do the hover half on its own — `.scroll-auto-hide:hover` in
 * index.css — but "or while scrolling" has no CSS expression: there is no
 * `:scrolling` pseudo-class, and a wheel over a list the pointer is not inside
 * (a trackpad flick, a keyboard page-down) would otherwise scroll silently with
 * no indication of where you are. This marks the element for the CSS to pick up.
 *
 * The timer is a ref rather than state on purpose: a scroll handler that
 * re-rendered on every frame of a flick would cost more than the scrollbar it is
 * hiding.
 */
export function useAutoHideScrollbar(): {
  onScroll: (event: { currentTarget: HTMLElement }) => void
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const el = useRef<HTMLElement | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const onScroll = useCallback((event: { currentTarget: HTMLElement }) => {
    el.current = event.currentTarget
    el.current.dataset.scrolling = 'true'
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      // The node can be gone by now — a tab switch unmounts the list mid-flick.
      if (el.current?.isConnected) delete el.current.dataset.scrolling
    }, LINGER_MS)
  }, [])

  return { onScroll }
}
