import { useEffect, useState } from 'react'

/** Long enough to cost nothing, short enough to feel like it followed the save. */
const POLL_MS = 1500

/**
 * A token that changes whenever the file on disk does.
 *
 * Polled rather than watched. An inotify watch on a *file* survives on an
 * unlinked inode when an editor saves by writing a temp file and renaming over
 * it, so the preview would go quiet exactly when it mattered; watching the
 * parent directory instead means a hot callback filtering every build artifact.
 * A stat every second and a half cannot miss either case, and it keys on the
 * absolute path — so a chat whose worktree materialises under an open tab needs
 * no transition at all.
 *
 * Stops while the window is hidden: nobody is reading a preview they cannot see.
 */
export function useFileStamp(path: string | null): string {
  const [stamp, setStamp] = useState('')

  useEffect(() => {
    if (!path) {
      setStamp('')
      return
    }
    let cancelled = false

    const check = async (): Promise<void> => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const s = await window.api.fs.statFile(path)
        // The inode is what catches a rename-over that happens to land on the
        // same size and the same coarse mtime.
        const next = `${s.exists}:${s.size}:${s.mtimeMs}:${s.ino}`
        if (!cancelled) setStamp(next)
      } catch {
        // A failed stat is not news; the next tick will say the same thing.
      }
    }

    void check()
    const timer = setInterval(() => void check(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [path])

  return stamp
}
