/**
 * Bytes for images Claude referenced in a reply, keyed by absolute path.
 *
 * Deliberately outside the sessions store. `createSessionsStorage` re-serialises a
 * chat's whole record whenever that chat changes, and reads every chat back at
 * boot, so a few megabytes of base64 riding along on a message would be paid for
 * on every streamed token and every launch.
 *
 * It is not only an optimisation, either: the transcript is virtualised, so an
 * image row unmounts and remounts every time it scrolls past. Without this the
 * file would be re-read on every pass.
 *
 * In memory only — nothing here survives a reload, which is correct, because
 * neither does the file in most cases.
 */
import type { ReadImageResult } from './api-types'

export type ImageEntry =
  | { status: 'ready'; dataUrl: string }
  | { status: 'error'; message: string }

const cache = new Map<string, ImageEntry>()
const inFlight = new Map<string, Promise<ImageEntry>>()
const attempts = new Map<string, number>()

/** How many times a not-yet-written file is worth re-reading before giving up. */
const MAX_ATTEMPTS = 3

/** The entry if it has already resolved, so a remount paints without a flash. */
export function cachedImage(path: string): ImageEntry | undefined {
  return cache.get(path)
}

export function loadImage(path: string): Promise<ImageEntry> {
  const hit = cache.get(path)
  if (hit) return Promise.resolve(hit)
  const pending = inFlight.get(path)
  if (pending) return pending

  const attempt = (attempts.get(path) ?? 0) + 1
  attempts.set(path, attempt)

  const task = (async (): Promise<ImageEntry> => {
    let entry: ImageEntry
    let retryable: boolean
    try {
      const res: ReadImageResult = await window.api.fs.readImage(path)
      if (res.base64 && res.mediaType) {
        entry = { status: 'ready', dataUrl: `data:${res.mediaType};base64,${res.base64}` }
        retryable = false
      } else {
        entry = { status: 'error', message: res.error || 'Image unavailable.' }
        retryable = res.missing === true
      }
    } catch (err) {
      entry = { status: 'error', message: (err as Error).message }
      retryable = true
    }
    // A missing file is the one failure that fixes itself: Claude streams the
    // `![...]` line before the Bash call that writes the PNG. Keep those out of
    // the cache so the next mount retries, until MAX_ATTEMPTS says stop.
    if (!retryable || attempt >= MAX_ATTEMPTS) cache.set(path, entry)
    inFlight.delete(path)
    return entry
  })()

  inFlight.set(path, task)
  return task
}

/** Test seam — the cache is module state that would otherwise leak across specs. */
export function resetImageCache(): void {
  cache.clear()
  inFlight.clear()
  attempts.clear()
}
