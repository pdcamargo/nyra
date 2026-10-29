/**
 * The renderer's half of `nyra_secret`.
 *
 * Rust asks once per call and waits up to ten minutes. This puts the request
 * in that chat's composer and answers with what was skipped or cancelled. The
 * values themselves never pass through here: the dock hands each one to
 * `secrets.save` as it is entered, and Rust writes it and keeps only the path.
 */
import { useSecretsStore, type SecretOutcome, type SecretSpec } from '../store/secrets'

/** The tool, as the transcript sees it. */
export const SECRET_TOOL = 'mcp__nyra-app__nyra_secret'

/** Rust gives up at 600s; drop the request just before, so it never outlives it. */
const ASK_LIFETIME_MS = 598_000

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The secrets a call asks for, read leniently: for the dock and the record. */
export function secretsOf(input: unknown): SecretSpec[] {
  const raw = (input as { secrets?: unknown } | undefined)?.secrets
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      name: str(s.name),
      label: str(s.label) || str(s.name),
      reason: str(s.reason),
      placeholder: str(s.placeholder)
    }))
    .filter((s) => s.name)
}

export function askSecret(args: Record<string, unknown>): Promise<SecretOutcome> {
  const chatId = str(args.chatId)
  const requestId = str(args.requestId)
  const secrets = secretsOf(args)
  if (!chatId || !requestId || secrets.length === 0) {
    return Promise.reject(new Error('secret.request needs a chatId, a requestId and secrets'))
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(
      () => useSecretsStore.getState().settle(chatId, requestId, { outcome: 'cancelled', skipped: [] }),
      ASK_LIFETIME_MS
    )
    useSecretsStore.getState().push(chatId, {
      requestId,
      secrets,
      save: args.save === 'file' ? 'file' : 'env',
      target: str(args.target),
      resolve: (outcome) => {
        window.clearTimeout(timer)
        resolve(outcome)
      }
    })
  })
}

export type SecretLine = {
  name: string
  status: 'saved' | 'skipped' | 'cancelled' | 'no answer'
  /** Where it went, for a saved one. */
  path?: string
}

/**
 * The tool's result read back into one line per secret, plus the notes under
 * them. Rust writes `NAME: saved to <path>` or `NAME: skipped` (see
 * `secrets.rs`); anything else is a note.
 */
export function parseSecretResult(result: string | undefined): { lines: SecretLine[]; notes: string[] } {
  const lines: SecretLine[] = []
  const notes: string[] = []
  for (const raw of (result ?? '').split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*): (saved to (.+)|skipped|cancelled|no answer)$/.exec(text)
    if (m) {
      lines.push(
        m[3]
          ? { name: m[1], status: 'saved', path: m[3] }
          : { name: m[1], status: m[2] as SecretLine['status'] }
      )
    } else {
      notes.push(text)
    }
  }
  return { lines, notes }
}

/** `/Users/me/app/.env` → `.env`; a private file → "a private file". */
export function whereSaved(path: string, save: 'env' | 'file'): string {
  if (save === 'file' || /[\\/]\.nyra[\\/]secrets[\\/]/.test(path)) return 'a private file'
  return path.split(/[\\/]/).pop() || path
}
