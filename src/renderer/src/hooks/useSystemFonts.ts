import { useEffect, useState } from 'react'
import type { FontFamily } from '../lib/api-types'

/**
 * The machine's installed font families.
 *
 * Asked for when the Appearance pane mounts, never at boot: the Rust side reads
 * and parses every font file on the machine to answer, and startup should not
 * wait on something only this one pane needs. The promise is module-level so
 * reopening the pane is free.
 */
let pending: Promise<FontFamily[]> | null = null

function load(): Promise<FontFamily[]> {
  pending ??= window.api.fonts.list().catch(() => [])
  return pending
}

/** Test seam, and the way out if a machine's font set ever changes under us. */
export function forgetSystemFonts(): void {
  pending = null
}

export function useSystemFonts(): { fonts: FontFamily[]; loading: boolean } {
  const [fonts, setFonts] = useState<FontFamily[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    void load().then((list) => {
      if (!live) return
      setFonts(list)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [])

  return { fonts, loading }
}
