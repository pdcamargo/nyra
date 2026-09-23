import { BUILT_IN_COMMANDS } from '../data/commands'

/**
 * Which slash commands exist, according to everything that knows one.
 *
 * `BUILT_IN_COMMANDS` is a list maintained by hand, and it had drifted: `/goal`,
 * `/recap`, `/usage` and `/insights` were all real and none of them were in it,
 * so the composer would not complete them and the decorator drew them as if they
 * were typos. The `system/init` event carries `slash_commands` — 124 of them —
 * which is the CLI stating what it actually has.
 *
 * The CLI is not the only source. A skill on disk (`~/.claude/skills`,
 * `.claude/skills`) and a custom command (`.claude/commands/git/sync.md`, which
 * the CLI reads back as `git:sync`) are both real slash commands, and both were
 * missing from the index — so `/claude-api` and every namespaced command the
 * user had written themselves were drawn as if they were paths.
 *
 * So the curated list stops being the source of truth and becomes what it is
 * good at: descriptions, ordering, and Nyra's own commands, which the CLI has
 * never heard of and must not be dropped. Anything reported that we have no
 * description for still completes, just without a subtitle.
 *
 * One index rather than one per surface: `composerDecorations` asks whether a
 * name is real on every keystroke, and it cannot await a fetch to answer.
 */

export type SlashCommand = {
  /** With the leading slash: `/compact`, `/git:sync`. */
  name: string
  description: string
  /** What the popup tags it as. A skill is loaded, a command is run. */
  kind: 'command' | 'skill'
  /** What it takes after its name, as the CLI puts it — `<model>`. Absent for
   *  a command that declares nothing, which is not the same as taking nothing:
   *  a skill gets whatever follows its name whether it says so or not. */
  argumentHint?: string
}

/** What the CLI says about one command, from its answer to `initialize`. */
export type CommandDetail = {
  name: string
  description?: string | null
  argumentHint?: string | null
}

/** Bare name — `loop`, not `/loop stop` — to what the curated list calls it. */
const CURATED = new Map(
  BUILT_IN_COMMANDS.map((c) => [c.name.slice(1).split(' ')[0], c.description])
)

/** Names the running CLI reported, or null before any session has started. */
let reported: string[] | null = null

/**
 * The CLI's own description and argument hint per bare name.
 *
 * Kept across launches, because the CLI only answers once a chat has started a
 * process — and the composer is used before that, too. A command that has since
 * been removed keeps a stale entry until the next answer replaces the lot,
 * which costs a hint on a name nothing will complete.
 */
const DETAILS_KEY = 'nyra-command-details'
let details = new Map<string, CommandDetail>(readDetails())

function readDetails(): [string, CommandDetail][] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(DETAILS_KEY)
    const list = raw ? (JSON.parse(raw) as CommandDetail[]) : []
    return Array.isArray(list) ? list.map((d) => [d.name, d]) : []
  } catch {
    return []
  }
}

/** Skills on disk, whatever Claude would load for this project. */
let skills: SlashCommand[] = []

/** Custom commands on disk — one `.md` file under a `.claude/commands`. */
let customCommands: SlashCommand[] = []

/** Commands contributed by installed plugins, keyed by the plugin that owns
 *  them so one plugin's list replaces its own entry and nobody else's. */
const pluginCommands = new Map<string, SlashCommand[]>()

/** Record what `system/init` said this CLI supports. */
export function noteSlashCommands(names: string[]): void {
  reported = names.filter((n) => typeof n === 'string' && n.length > 0)
}

/** Record what the CLI's `initialize` answer said about each of its commands. */
export function noteCommandDetails(list: CommandDetail[]): void {
  const valid = list.filter((d) => typeof d?.name === 'string' && d.name.length > 0)
  if (valid.length === 0) return
  details = new Map(valid.map((d) => [d.name, d]))
  try {
    localStorage.setItem(DETAILS_KEY, JSON.stringify(valid))
  } catch {
    // Storage full or unavailable: the hints still work for this launch.
  }
}

/** What `/name` takes, if the CLI said. */
export function argumentHint(name: string): string | undefined {
  return details.get(name)?.argumentHint || undefined
}

/**
 * Record the skills on disk.
 *
 * Called with a bare name — `claude-api` — which is how the CLI would take it.
 * Project entries arrive first so they win a name collision with a global one,
 * the same way Claude resolves them.
 */
export function noteSkills(list: { name: string; description?: string }[]): void {
  skills = list
    .filter((s) => typeof s.name === 'string' && s.name.length > 0)
    .map((s) => ({ name: `/${s.name}`, description: s.description ?? '', kind: 'skill' as const }))
}

/** Record the custom commands on disk. Named the way the CLI reads them, so a
 *  nested `git/sync.md` arrives as `git:sync` and is matched with the colon. */
export function noteCustomCommands(list: { name: string; description?: string }[]): void {
  customCommands = list
    .filter((c) => typeof c.name === 'string' && c.name.length > 0)
    .map((c) => ({
      name: `/${c.name}`,
      description: c.description ?? '',
      kind: 'command' as const
    }))
}

/**
 * Record the commands an installed plugin contributes.
 *
 * The CLI namespaces them — the `review` command from a plugin called
 * `claude-api` is `/claude-api:review` — so the namespace is built the same way
 * here, and a name that already carries one is left as it is.
 */
export function notePluginCommands(
  plugin: string,
  list: { name: string; description?: string }[]
): void {
  const entries = list
    .filter((c) => typeof c.name === 'string' && c.name.length > 0)
    .map((c) => ({
      name: `/${c.name.includes(':') ? c.name : `${plugin}:${c.name}`}`,
      description: c.description ?? '',
      kind: 'command' as const
    }))
  if (entries.length === 0) pluginCommands.delete(plugin)
  else pluginCommands.set(plugin, entries)
}

/** Only for tests: forget what any previous session or disk read reported. */
export function resetSlashCommands(): void {
  reported = null
  details = new Map()
  skills = []
  customCommands = []
  pluginCommands.clear()
}

/**
 * Everything completable.
 *
 * Order matters more than it looks. Your own material comes first — you typed
 * `/` to find the skill you just made, and it would be below three screens of
 * built-ins otherwise. Then the curated list, roughly by how often you reach for
 * it, then whatever the CLI reported, which is alphabetical and appended rather
 * than merged so `/compact` stays above `/agents`.
 *
 * First name wins, so a skill you wrote named `compact` describes itself rather
 * than wearing the built-in's description.
 */
export function slashCommands(): SlashCommand[] {
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  // The curated wording wins where there is one: it was written for a popup,
  // and the CLI's was written for the model. The CLI fills in the rest, and is
  // the only source for what a command takes.
  const push = (command: SlashCommand): void => {
    const bare = command.name.slice(1)
    if (seen.has(bare)) return
    seen.add(bare)
    const detail = details.get(bare)
    out.push({
      ...command,
      description: command.description || detail?.description || '',
      argumentHint: detail?.argumentHint || undefined
    })
  }

  for (const skill of skills) push(skill)
  for (const command of customCommands) push(command)
  for (const commands of pluginCommands.values()) {
    for (const command of commands) push(command)
  }
  for (const command of BUILT_IN_COMMANDS) push({ ...command, kind: 'command' })
  for (const name of reported ?? []) {
    push({ name: `/${name}`, description: CURATED.get(name) ?? '', kind: 'command' })
  }
  // The same CLI's fuller list, remembered from the last process that started.
  // It names what `system/init` names — the CLI's bundled skills among them,
  // `/claude-api` for one — and it is there at launch, before any chat has
  // started a process to report them.
  for (const name of details.keys()) {
    push({ name: `/${name}`, description: CURATED.get(name) ?? '', kind: 'command' })
  }
  return out
}

/** Whether `/name` is a real command — what the composer draws as a command. */
export function isKnownCommand(name: string): boolean {
  if (CURATED.has(name)) return true
  if (skills.some((s) => s.name.slice(1) === name)) return true
  if (customCommands.some((c) => c.name.slice(1) === name)) return true
  for (const commands of pluginCommands.values()) {
    if (commands.some((c) => c.name.slice(1) === name)) return true
  }
  return (reported?.includes(name) ?? false) || details.has(name)
}
