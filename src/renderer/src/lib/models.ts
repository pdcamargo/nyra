/**
 * Which models Nyra offers by name, and what it does with the rest.
 *
 * The CLI has no command that enumerates models. `--model` takes "an alias for
 * the latest model" or a full name, and its help lists three by way of example,
 * so there is nothing to discover at startup — only a choice about what to do
 * when a model is not on our list. Nyra takes it anyway: these are shortcuts,
 * not a whitelist, and a model released tomorrow works tomorrow.
 *
 * No version number is ever written down in this file. An alias means "the
 * latest", so calling one Opus 4 was wrong the day Opus 5 shipped. The numbers
 * on the labels are the ones the CLI reported resolving an alias to — see
 * `store/modelVersions` — which is the only source that cannot go stale.
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

const isAlias = (value: string): value is KnownModel =>
  (KNOWN_MODELS as readonly string[]).includes(value)

/**
 * Everything the CLI has told us about what a name currently means.
 *
 * Two maps because they answer different questions and one outranks the other.
 * `resolved` is what a particular request came back as, keyed by the request
 * itself — `''` for "we sent no --model" — and is the direct answer. `families`
 * is the newest id seen for a family from any source at all, which is what
 * makes a row you have never run still carry a number: the default resolving
 * to `claude-opus-5-5` is the CLI stating what Opus is today.
 */
export type ModelVersions = {
  resolved?: Record<string, string>
  families?: Record<string, string>
  /**
   * What the CLI's own catalog says each alias currently means, read off the
   * binary. Ranks below both of the above — those are what this account really
   * got back, and the catalog is what the build would pick by default — but
   * above nothing, which is what every unopened row had before it.
   */
  catalog?: Record<string, string>
}

/** Strip the dressing every platform adds: `claude-`, a date, a Bedrock prefix. */
function bareId(id: string): string[] {
  return id
    .replace(/\[1m\]$/i, '')
    .replace(/^(?:[a-z]+\.)*anthropic\./i, '')
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')
    .replace(/-v\d+:\d+$/, '')
    .split('-')
    .filter(Boolean)
}

/** `us.anthropic.claude-opus-5-5-20260101[1m]` → `opus`. Null if unfamiliar. */
export function modelFamily(id: string | null | undefined): KnownModel | null {
  if (!id) return null
  const family = bareId(id)[0]?.toLowerCase()
  return family && isAlias(family) ? family : null
}

/**
 * Options for the settings dropdown, including whatever is stored.
 *
 * A model chosen in the composer can be any string the CLI accepts. Without the
 * last clause this row would read "Default" while the session ran on something
 * else entirely.
 */
export function modelOptions(
  stored: string,
  versions: ModelVersions = {}
): { value: string; label: string }[] {
  const known = KNOWN_MODELS.map((m) => ({ value: m, label: modelLabel(m, versions) }))
  const fallback = shortModelLabel(versions.resolved?.[''])
  return [
    // Named, but still marked as the default rather than renamed to it. In a
    // list you are choosing from, a row reading only "Opus 5.5" is a fifth
    // model next to four others; what this row means is "whatever the CLI
    // picks", which is worth telling apart from the Opus below it.
    { value: '', label: fallback ? `Default (${fallback})` : 'Default' },
    ...known,
    ...(stored && !isAlias(stored) ? [{ value: stored, label: modelLabel(stored, versions) }] : [])
  ]
}

/**
 * `claude-opus-5-5` → `Opus 5.5`. What a subagent actually ran on.
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
  const parts = bareId(id)
  const family = modelFamily(id)
  if (!family) return null
  // `haiku-4-5` is one version, not two: the tail joins on a dot.
  const version = parts
    .slice(1)
    .filter((p) => /^\d+$/.test(p))
    .join('.')
  return version ? `${LABELS[family]} ${version}` : LABELS[family]
}

/**
 * The newest id we have seen for a family, wherever it came from.
 *
 * Every resolution is evidence about its own family, not only about the name
 * that was asked for — so a chat left on Default reporting `claude-opus-5-5`
 * puts the number on the Opus row too, and a subagent that ran on Haiku
 * numbers the Haiku row without anyone ever having selected it. Without this
 * the picker sits bare until you have personally run all four.
 */
function familyId(family: KnownModel, versions: ModelVersions): string | undefined {
  const direct = versions.families?.[family]
  if (direct) return direct
  // Older stores kept only `resolved`, and its values are the same evidence.
  return Object.values(versions.resolved ?? {}).find((id) => modelFamily(id) === family)
}

/**
 * What to call the model this chat is set to.
 *
 * Three kinds of value are stored, and each wants a different label. An alias
 * is a standing request for the latest, so it is named from what that request
 * last came back as, then from anything else known about the family, then from
 * the CLI's own catalog, and only then dropped to a bare `Opus`. A pinned id is shown exactly as typed, because
 * somebody typed it on purpose and `claude-opus-5-5[1m]` and `claude-opus-5-5`
 * are not the same request. Empty is no `--model` at all, where the only honest
 * label is whatever the CLI picked for us — and `Default` before it has said,
 * which is the state this whole surface used to be stuck in.
 */
export function modelLabel(stored: string, versions: ModelVersions = {}): string {
  if (isAlias(stored)) {
    return (
      shortModelLabel(versions.resolved?.[stored]) ??
      shortModelLabel(familyId(stored, versions)) ??
      shortModelLabel(versions.catalog?.[stored]) ??
      LABELS[stored]
    )
  }
  if (!stored) return shortModelLabel(versions.resolved?.['']) ?? 'Default'
  return stored
}

/**
 * What the chat in front of you is running on.
 *
 * Preferred over {@link modelLabel} anywhere the label describes one
 * conversation, because a chat resolves `--model` once when its process spawns
 * and then keeps that model for as long as it lives. Two chats set to the same
 * alias can be on different models — one started either side of a release — and
 * only the process itself can say which.
 *
 * The request is checked against the answer, so picking a new model drops back
 * to the alias immediately rather than going on naming the model the process
 * still running behind it resolved.
 */
export function chatModelLabel(
  stored: string,
  running: { requested: string; id: string } | null | undefined,
  versions: ModelVersions = {}
): string {
  if (running?.requested === stored) {
    const exact = shortModelLabel(running.id)
    if (exact) return exact
  }
  return modelLabel(stored, versions)
}
