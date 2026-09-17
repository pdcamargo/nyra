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
