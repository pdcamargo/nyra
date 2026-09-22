/**
 * The terms Whisper is biased towards while dictating.
 *
 * Whisper conditions on a prompt, but only the **last 224 tokens** of it reach
 * the decoder, and later tokens carry more weight. So this returns a list
 * ordered *least valuable first*: the generic baseline goes at the front where
 * it will be truncated away, and identifiers from the project the user is
 * actually working in go at the end, where they survive.
 *
 * Bare identifiers, no prose. A prompt written as an English sentence nudges
 * the output towards English, which is the wrong thing to do to somebody
 * dictating in Portuguese.
 */
import type { FileEntry } from './api-types'

/** Words that are common in a prompt to Claude and rare in Whisper's training. */
const BASELINE = [
  'Claude',
  'Nyra',
  'TypeScript',
  'Rust',
  'Tauri',
  'React',
  'zustand',
  'npm',
  'git',
  'commit',
  'rebase',
  'refactor',
  'repo',
  'API',
  'CLI',
  'JSON',
  'CSS',
  'async',
  'await',
  'enum',
  'struct',
  'boolean',
  'regex',
  'stdout',
  'stderr'
]

/** Skip directories whose contents say nothing about this project. */
const NOISE = /(^|\/)(node_modules|target|dist|build|\.git|vendor|\.next|coverage)(\/|$)/

/** Identifiers worth spending prompt budget on. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{2,}$/

/**
 * Split a filename into the words someone would actually say.
 *
 * `ComposerBar.tsx` → `ComposerBar`; `use-chat-settings.ts` → `chat`,
 * `settings`. The compound is kept as well as its parts, because "ComposerBar"
 * is exactly the thing that comes back as "composer bar" without it.
 */
export function identifiersFromPath(path: string): string[] {
  const base = path.split('/').pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '')
  if (!stem) return []

  const out: string[] = []
  for (const part of stem.split(/[-_.\s]+/)) {
    if (!part) continue
    if (IDENTIFIER.test(part)) out.push(part)
    // Split camelCase and PascalCase into their words too, so a model that
    // cannot produce the compound can still get the pieces right.
    const words = part.split(/(?<=[a-z0-9])(?=[A-Z])/)
    if (words.length > 1) {
      for (const word of words) if (IDENTIFIER.test(word)) out.push(word)
    }
  }
  return out
}

/**
 * Build the vocabulary list for a working directory.
 *
 * Returns least-valuable-first. `limit` caps how many identifiers are kept;
 * the prompt is truncated to 224 tokens in Rust regardless, but sending
 * thousands of terms to be thrown away is wasteful.
 */
export function buildVocabulary(files: FileEntry[], limit = 160): string[] {
  const counts = new Map<string, number>()

  for (const entry of files) {
    if (entry.type !== 'file' || NOISE.test(entry.path)) continue
    for (const identifier of identifiersFromPath(entry.path)) {
      counts.set(identifier, (counts.get(identifier) ?? 0) + 1)
    }
  }

  // Frequent identifiers are the project's vocabulary; one-offs are noise.
  // Sorted ascending so the most-used land at the end of the prompt, which is
  // the part Whisper keeps.
  const ranked = [...counts.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([term]) => term)

  const seen = new Set(ranked.map((t) => t.toLowerCase()))
  const baseline = BASELINE.filter((t) => !seen.has(t.toLowerCase()))

  return [...baseline, ...ranked]
}
