import { useEffect, useState } from 'react'
import { compile } from '@nyra/design'
import type { DesignEntry } from '../lib/api-types'
import { useDesignActivityStore } from '../store/designActivity'
import { useFileStamp } from './useFileStamp'

/**
 * Keep the activity store's picture of one design current.
 *
 * The same poll the design tab reloads on, so the miniature and the canvas see
 * a change at the same moment. A document that fails to compile mid-edit keeps
 * its last good picture: Claude usually fixes it on the next call, and a
 * miniature that blanks for each typo would be flicker, not information.
 */
export function useDesignWatch(path: string | null): void {
  const stamp = useFileStamp(path)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    void window.api.fs.readTextFile(path).then((read) => {
      if (cancelled) return
      const store = useDesignActivityStore.getState()
      if (read.kind === 'missing') {
        store.observeMissing(path)
        return
      }
      if (read.kind !== 'text') return
      try {
        const { doc, theme } = compile(JSON.parse(read.content))
        store.observe(path, doc, theme)
      } catch {
        // Keep the last good version; see above.
      }
    })
    return () => {
      cancelled = true
    }
  }, [path, stamp])
}

/** The design index, kept current. Names come from here, never from the file. */
export function useDesignEntries(): DesignEntry[] {
  const [entries, setEntries] = useState<DesignEntry[]>([])
  useEffect(() => {
    const load = (): void => void window.api.design.list().then(setEntries)
    load()
    return window.api.design.onChanged(load)
  }, [])
  return entries
}
