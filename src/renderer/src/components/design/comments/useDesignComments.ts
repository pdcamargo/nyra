import { useCallback, useEffect, useMemo, useState } from 'react'
import { commentScope, type DesignComment } from '../../../lib/designComments'

export type DesignComments = {
  /** Which comment file this design's comments live in; null until known. */
  scope: string | null
  /** For a file in a system, its path inside the system. */
  rel: string | undefined
  /** This file's comments, oldest first. */
  comments: DesignComment[]
  refresh: () => void
}

/**
 * The comments on one design file, kept current.
 *
 * A system's comments share one file, so every file of it reads the same
 * list and keeps its own. Claude resolving one, or another window adding one,
 * arrives as `nyra:comments-changed` for the scope, and the list re-reads.
 */
export function useDesignComments(path: string): DesignComments {
  const [scope, setScope] = useState<string | null>(null)
  const [rel, setRel] = useState<string | undefined>(undefined)
  const [all, setAll] = useState<DesignComment[]>([])
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let live = true
    setScope(null)
    setAll([])
    void Promise.all([commentScope(path), window.api.designSystem?.of(path)]).then(([s, member]) => {
      if (!live) return
      setScope(s)
      setRel(member?.rel)
    })
    return () => {
      live = false
    }
  }, [path])

  useEffect(() => {
    if (!scope) return
    let live = true
    void window.api.comments.list(scope).then((res) => {
      if (live && res.ok) setAll(res.comments ?? [])
    })
    return () => {
      live = false
    }
  }, [scope, tick])

  useEffect(() => {
    if (!scope) return
    return window.api.comments.onChanged((p) => {
      if (p.scope === scope) refresh()
    })
  }, [scope, refresh])

  // A system file by its path inside the system, so a worktree's copy and the
  // main checkout's show the same comments; a draft by its own path.
  const comments = useMemo(() => all.filter((c) => (rel !== undefined && c.rel ? c.rel === rel : c.file === path)), [all, path, rel])
  return { scope, rel, comments, refresh }
}
