import type { ReleaseNote } from '../data/releaseNotes'

/** Numeric compare of dotted versions. `0.10.0` is newer than `0.9.3`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type WhatsNew = {
  /** The version this install came from, or null when it is not known. */
  from: string | null
  releases: ReleaseNote[]
}

/**
 * What to show on this launch, or null for nothing.
 *
 * A fresh install shows nothing: a changelog on day one is noise. The version
 * before this one was never recorded by builds that predate the dialog, so an
 * install that has been through onboarding but has no `lastSeen` is an update
 * from an unknown version, and gets the current release's notes alone rather
 * than the whole history.
 *
 * Downgrades and relaunches of the same version show nothing.
 */
export function whatsNew(
  notes: ReleaseNote[],
  current: string,
  lastSeen: string | null,
  existingInstall: boolean
): WhatsNew | null {
  const released = notes.filter((r) => r.version !== 'next' && r.notes.length > 0)
  if (lastSeen === null) {
    if (!existingInstall) return null
    const release = released.find((r) => r.version === current)
    return release ? { from: null, releases: [release] } : null
  }
  if (compareVersions(current, lastSeen) <= 0) return null
  const releases = released.filter(
    (r) => compareVersions(r.version, lastSeen) > 0 && compareVersions(r.version, current) <= 0
  )
  return releases.length > 0 ? { from: lastSeen, releases } : null
}
