import { useCallback, useState } from 'react'

/**
 * Per-row UI state that outlives the row's mount.
 *
 * The transcript is virtualised, so a row unmounts when it scrolls out of view
 * and mounts fresh when it comes back. Plain `useState` then forgets that a
 * group was expanded: the row returns collapsed, at a height the virtualiser
 * did not measure it at, and everything under it moves while you scroll.
 *
 * In memory only, keyed by something stable such as a tool id.
 */
const remembered = new Map<string, unknown>()

export function useRememberedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (remembered.has(key) ? (remembered.get(key) as T) : initial))
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
        remembered.set(key, resolved)
        return resolved
      })
    },
    [key]
  )
  return [value, set]
}
