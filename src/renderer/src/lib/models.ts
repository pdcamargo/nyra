/**
 * Which models Nyra offers by name, and what it does with the rest.
 *
 * The CLI has no command that enumerates models. `--model` takes "an alias for
 * the latest model" or a full name, and its help lists three by way of example,
 * so there is nothing to discover at startup — only a choice about what to do
 * when a model is not on our list. Nyra takes it anyway: these are shortcuts,
 * not a whitelist, and a model released tomorrow works tomorrow.
 *
 * No version numbers in the labels. An alias means "the latest", so calling one
 * Opus 4 was wrong the day Opus 5 shipped.
 */
export const KNOWN_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const

export type KnownModel = (typeof KNOWN_MODELS)[number]

export const MODEL_BLURB: Record<string, string> = {
  fable: 'Newest',
  opus: 'Most capable',
  sonnet: 'Balanced',
  haiku: 'Fastest'
}

const LABELS: Record<KnownModel, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

/**
 * Options for the settings dropdown, including whatever is stored.
 *
 * A model chosen in the composer can be any string the CLI accepts. Without the
 * last clause this row would read "Default" while the session ran on something
 * else entirely.
 */
export function modelOptions(stored: string): { value: string; label: string }[] {
  const known = KNOWN_MODELS.map((m) => ({ value: m, label: LABELS[m] }))
  const isKnown = (KNOWN_MODELS as readonly string[]).includes(stored)
  return [
    { value: '', label: 'Default' },
    ...known,
    ...(stored && !isKnown ? [{ value: stored, label: stored }] : [])
  ]
}

/**
 * `claude-opus-5` → `Opus 5`. What a subagent actually ran on.
 *
 * The composer picks a model by alias; the CLI resolves it to a full id and
 * stamps that onto every message, subagent ones included. Only the resolved id
 * is worth showing next to an agent — the alias is a preference, this is a fact.
 *
 * Null rather than a guess when the shape is unfamiliar: a badge reading
 * `custom-thing-v2` says less than no badge at all.
 */
export function shortModelLabel(id: string | null | undefined): string | null {
  if (!id) return null
  const bare = id
    .replace(/\[1m\]$/i, '')
    .replace(/^(?:[a-z]+\.)*anthropic\./i, '')
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')
    .replace(/-v\d+:\d+$/, '')
  const parts = bare.split('-').filter(Boolean)
  if (parts.length === 0) return null
  const [family, ...rest] = parts
  const known = (KNOWN_MODELS as readonly string[]).includes(family.toLowerCase())
  if (!known) return null
  const name = LABELS[family.toLowerCase() as KnownModel]
  // `haiku-4-5` is one version, not two: the tail joins on a dot.
  const version = rest.filter((p) => /^\d+$/.test(p)).join('.')
  return version ? `${name} ${version}` : name
}
