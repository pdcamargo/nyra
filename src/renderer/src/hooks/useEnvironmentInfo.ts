import { useEffect, useState } from 'react'
import type { EnvironmentInfo } from '../lib/api-types'
import { wslShare } from '../lib/environment'

/**
 * What Rust knows about the environment `cwd` runs in, for a directory inside
 * WSL. Null while it is being asked, and always for a directory on this machine,
 * which never asks: nothing about a host chat depends on it.
 *
 * Not cached here. Rust caches the distro's probe, so a second ask is a map
 * lookup and a read of `.wslconfig` — and re-asking on mount is what lets a
 * notice notice that mirrored networking was switched on since.
 */
export function useEnvironmentInfo(cwd: string): EnvironmentInfo | null {
  const [info, setInfo] = useState<EnvironmentInfo | null>(null)

  useEffect(() => {
    setInfo(null)
    if (!wslShare(cwd)) return
    let cancelled = false
    void window.api.environment.info(cwd).then((next) => {
      if (!cancelled) setInfo(next)
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return info
}
