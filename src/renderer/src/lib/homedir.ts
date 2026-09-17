/**
 * The user's home directory, fetched once and cached.
 *
 * Recents chats run here, and it is the last-resort cwd now that `defaultCwd` and
 * the `localStorage['cwd']` global are gone. Synchronous reads are what every
 * call site wants, so the value is primed at startup and read back from a plain
 * variable afterwards.
 */
let cached = ''
let inFlight: Promise<string> | null = null

export async function primeHomedir(): Promise<string> {
  if (cached) return cached
  if (!inFlight) {
    inFlight = window.api.system
      .homedir()
      .then((dir) => {
        cached = dir || ''
        return cached
      })
      .catch(() => '')
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/** Empty until `primeHomedir` has resolved; callers treat that as "unknown". */
export function homedir(): string {
  return cached
}
