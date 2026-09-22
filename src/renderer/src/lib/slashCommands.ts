import { BUILT_IN_COMMANDS } from '../data/commands'

/**
 * Which slash commands exist, according to the CLI that is running.
 *
 * `BUILT_IN_COMMANDS` is a list maintained by hand, and it had drifted: `/goal`,
 * `/recap`, `/usage` and `/insights` were all real and none of them were in it,
 * so the composer would not complete them and the decorator drew them as if they
 * were typos. The `system/init` event carries `slash_commands` — 124 of them —
 * which is the CLI stating what it actually has.
 *
 * So the curated list stops being the source of truth and becomes what it is
 * good at: descriptions, ordering, and Nyra's own commands, which the CLI has
 * never heard of and must not be dropped. Anything the CLI reports that we have
 * no description for still completes, just without a subtitle.
 */

export type SlashCommand = { name: string; description: string }

/** Bare name — `loop`, not `/loop stop` — to what the curated list calls it. */
const CURATED = new Map(
  BUILT_IN_COMMANDS.map((c) => [c.name.slice(1).split(' ')[0], c.description])
)

/** Names the running CLI reported, or null before any session has started. */
let reported: string[] | null = null

/** Record what `system/init` said this CLI supports. */
export function noteSlashCommands(names: string[]): void {
  reported = names.filter((n) => typeof n === 'string' && n.length > 0)
}

/** Only for tests: forget what a previous session reported. */
export function resetSlashCommands(): void {
  reported = null
}

/**
 * Everything completable, curated entries first.
 *
 * Order matters more than it looks: the curated list is roughly by how often you
 * reach for it, and the CLI's is alphabetical, so appending rather than merging
 * keeps `/compact` above `/agents`.
 */
export function slashCommands(): SlashCommand[] {
  const out: SlashCommand[] = BUILT_IN_COMMANDS.map((c) => ({ ...c }))
  if (!reported) return out

  const already = new Set(BUILT_IN_COMMANDS.map((c) => c.name.slice(1).split(' ')[0]))
  for (const name of reported) {
    if (already.has(name)) continue
    already.add(name)
    out.push({ name: `/${name}`, description: CURATED.get(name) ?? '' })
  }
  return out
}

/** Whether `/name` is a real command — what the composer draws as a command. */
export function isKnownCommand(name: string): boolean {
  if (CURATED.has(name)) return true
  return reported?.includes(name) ?? false
}
