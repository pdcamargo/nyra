/**
 * A pasted install command, read into something Nyra is willing to run.
 *
 * The Skills and Plugins pages take whatever a README says to type — `npx
 * skills add owner/repo`, `/plugin install x@market`, or just `owner/repo` — and
 * run it in a terminal. "Whatever a README says" is the problem: this decides
 * what that is, and refuses everything else. Only two programs come out of it,
 * `npx skills add` and `claude plugin`, as an argv that never meets a shell, so
 * a `; rm -rf ~` riding along has nothing to be parsed by. The backend checks
 * the program again.
 */

export type InstallKind = 'skill' | 'plugin'

export type InstallCommand = {
  kind: InstallKind
  program: 'npx' | 'claude'
  args: string[]
  /** The command as it will run, for the terminal's first line. */
  display: string
}

export type ParsedInstall = { ok: true; command: InstallCommand } | { ok: false; error: string }

/** The `skills` package's runners, all run as `npx` — the one we can find. */
const RUNNERS: string[][] = [['npx'], ['bunx'], ['pnpm', 'dlx'], ['pnpx'], ['yarn', 'dlx']]

/** What `claude plugin` may be asked to do from here. */
const PLUGIN_VERBS: string[][] = [['install'], ['i'], ['marketplace', 'add'], ['update'], ['enable']]

/**
 * Flags that skip the CLI asking a person to approve the command a plugin runs.
 * That question is the point; a pasted line does not get to answer it.
 */
const PLUGIN_FLAGS_REFUSED = ['--accept-command', '-y', '--yes']

/** `owner/repo`, `owner/repo@skill`, or a GitHub URL. */
const REPO = /^(?:https?:\/\/)?(?:github\.com\/)?[\w.-]+\/[\w.-]+(?:@[\w.-]+)?(?:\.git)?\/?$/i
/** `plugin@marketplace`. */
const PLUGIN_ID = /^[\w.-]+@[\w.-]+$/

/**
 * Split like a shell would, quotes and backslashes included — and refuse what
 * only a shell would act on, since there is none.
 */
export function tokenize(input: string): string[] | { error: string } {
  const out: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) current += input[++i]
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (ch === '\n' || ch === '\r') {
        if (input.slice(i).trim()) return { error: 'Paste one command at a time.' }
      }
      if (started) out.push(current)
      current = ''
      started = false
    } else if (';&|<>`$()'.includes(ch)) {
      return { error: 'Paste one command, without pipes, redirects or chained commands.' }
    } else {
      current += ch
      started = true
    }
  }
  if (quote) return { error: 'A quote is left open.' }
  if (started) out.push(current)
  return out
}

function startsWith(tokens: string[], prefix: string[]): boolean {
  return prefix.every((t, i) => tokens[i] === t)
}

function skill(rest: string[]): InstallCommand {
  // Only Claude Code unless they named agents: otherwise the CLI opens with a
  // list of forty, and with more than one it links rather than copies.
  const named = rest.some((t) => t === '-a' || t === '--agent' || t.startsWith('--agent='))
  const args = ['-y', 'skills', 'add', ...rest, ...(named ? [] : ['-a', 'claude-code'])]
  return { kind: 'skill', program: 'npx', args, display: ['npx', ...args.slice(1)].join(' ') }
}

function plugin(rest: string[]): ParsedInstall {
  const refused = rest.find((t) => PLUGIN_FLAGS_REFUSED.some((f) => t === f || t.startsWith(`${f}=`)))
  if (refused) {
    return {
      ok: false,
      error: `${refused} skips the question Claude Code asks before a plugin runs a command. Leave it off and answer it in the terminal.`
    }
  }
  if (!PLUGIN_VERBS.some((verb) => startsWith(rest, verb) && rest.length > verb.length)) {
    return { ok: false, error: 'Nyra can install, enable or update a plugin, or add a marketplace.' }
  }
  const args = ['plugin', ...rest]
  return { ok: true, command: { kind: 'plugin', program: 'claude', args, display: ['claude', ...args].join(' ') } }
}

/**
 * Read a pasted line. `context` settles a bare `owner/repo`, which is a skill
 * source on the Skills page and a marketplace on the Plugins page.
 */
export function parseInstallCommand(input: string, context: InstallKind): ParsedInstall {
  const trimmed = input.trim().replace(/^\$\s+/, '')
  if (!trimmed) return { ok: false, error: 'Paste a command first.' }
  const tokens = tokenize(trimmed)
  if (!Array.isArray(tokens)) return { ok: false, error: tokens.error }

  if (tokens.length === 1) {
    const [only] = tokens
    if (PLUGIN_ID.test(only) && !only.includes('/')) return plugin(['install', only])
    if (REPO.test(only)) {
      return context === 'plugin' ? plugin(['marketplace', 'add', only]) : { ok: true, command: skill([only]) }
    }
  }

  for (const runner of RUNNERS) {
    if (!startsWith(tokens, runner)) continue
    let rest = tokens.slice(runner.length)
    while (rest[0] === '-y' || rest[0] === '--yes') rest = rest.slice(1)
    if (/^skills(@[\w.-]+)?$/.test(rest[0] ?? '') && rest[1] === 'add' && rest.length > 2) {
      return { ok: true, command: skill(rest.slice(2)) }
    }
    return { ok: false, error: 'Only `skills add` runs from here.' }
  }
  if (tokens[0] === 'skills' && tokens[1] === 'add' && tokens.length > 2) {
    return { ok: true, command: skill(tokens.slice(2)) }
  }

  if (tokens[0] === 'claude' && (tokens[1] === 'plugin' || tokens[1] === 'plugins')) return plugin(tokens.slice(2))
  if (tokens[0] === '/plugin' || tokens[0] === '/plugins') return plugin(tokens.slice(1))

  return {
    ok: false,
    error:
      context === 'plugin'
        ? 'Paste a `claude plugin install …` or `/plugin install …` command, a plugin@marketplace, or an owner/repo.'
        : 'Paste an `npx skills add …` command or an owner/repo.'
  }
}
