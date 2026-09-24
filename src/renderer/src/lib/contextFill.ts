import type { Session } from '../store/sessions'

/**
 * Assumed until the CLI reports the real window on a turn's result. The
 * largest one a model runs with, so an unknown window under-reads rather than
 * warning early.
 */
const FALLBACK_WINDOW = 1_000_000

export type ContextFill = {
  tokens: number
  window: number
  /** Whether `window` came from the CLI or is the fallback. */
  measured: boolean
  pct: number
}

/**
 * How full a chat's context is, from the latest call alone.
 *
 * It used to be `usage.inputTokens + usage.outputTokens` — a running sum over
 * every call, counted again for each line the CLI split a reply into, and
 * missing the cached input that makes up nearly all of a long conversation. It
 * read what the chat had spent, not what it held.
 */
export function contextFill(
  session: Pick<Session, 'contextTokens' | 'contextWindow'> | null | undefined
): ContextFill | null {
  const tokens = session?.contextTokens
  if (tokens === undefined) return null
  const measured = (session?.contextWindow ?? 0) > 0
  const window = measured ? session!.contextWindow! : FALLBACK_WINDOW
  return { tokens, window, measured, pct: Math.min(100, (tokens / window) * 100) }
}
