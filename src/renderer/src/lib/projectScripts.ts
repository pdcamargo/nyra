import type { Project, ProjectScripts } from '../store/sessions'
import { joinPath, samePath } from './paths'

/**
 * A project's Setup and Run scripts.
 *
 * Two places can hold them. A `.nyra/scripts.json` committed to the repo is
 * shared with everyone who clones it, so when there is one it wins — whole, not
 * field by field, so what the file says is all that runs. Otherwise they are
 * the project's own, kept in Nyra and set from Project settings.
 */
export const REPO_SCRIPTS_FILE = '.nyra/scripts.json'

export type ResolvedScripts = ProjectScripts & {
  source: 'repo' | 'nyra'
  /** The file they came from, for `source: 'repo'`. */
  file?: string
}

/** One script: a string, or an array of lines — JSON has no multi-line strings. */
function scriptOf(value: unknown): string | undefined {
  const text = Array.isArray(value)
    ? value.filter((line): line is string => typeof line === 'string').join('\n')
    : typeof value === 'string'
      ? value
      : ''
  return text.trim() ? text : undefined
}

/** `.nyra/scripts.json`'s text as scripts, or null when it is not a JSON object. */
export function parseScriptsFile(text: string): ProjectScripts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const scripts: ProjectScripts = {}
  const setup = scriptOf(raw.setup)
  const run = scriptOf(raw.run)
  if (setup) scripts.setup = setup
  if (run) scripts.run = run
  return scripts
}

/** The repo's scripts file under `dir`, if it has a readable one. */
export async function readRepoScripts(dir: string): Promise<(ProjectScripts & { file: string }) | null> {
  const file = joinPath(dir, REPO_SCRIPTS_FILE)
  try {
    const { content } = await window.api.fs.readFile(file)
    if (content === undefined) return null
    const scripts = parseScriptsFile(content)
    return scripts ? { ...scripts, file } : null
  } catch {
    return null
  }
}

/**
 * The scripts that apply to a chat in `cwd`.
 *
 * The chat's own folder is read first — a worktree carries the file if it is
 * committed, and its branch may have changed it — then the project's checkout.
 */
export async function resolveScripts(cwd: string, project: Project | null | undefined): Promise<ResolvedScripts> {
  const dirs = [cwd, project?.path].filter((d): d is string => !!d)
  for (const [i, dir] of dirs.entries()) {
    if (i > 0 && samePath(dir, dirs[0])) continue
    const repo = await readRepoScripts(dir)
    if (repo) return { ...repo, source: 'repo' }
  }
  return { ...project?.scripts, source: 'nyra' }
}

const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
]

/** How `manager` runs a package.json script. */
export function runScriptCommand(manager: string, script: string): string {
  return manager === 'npm' || manager === 'bun' ? `${manager} run ${script}` : `${manager} ${script}`
}

/** Which package.json script a Run should start: `dev`, else `start`. */
export function pickRunScript(scripts: Record<string, unknown> | undefined): string | null {
  if (!scripts) return null
  for (const name of ['dev', 'start']) {
    if (typeof scripts[name] === 'string') return name
  }
  return null
}

/**
 * A Run command to offer when none is set: the package.json's `dev` or
 * `start`, under whichever package manager the lockfile names.
 */
export async function detectRunCommand(dir: string): Promise<{ command: string; script: string } | null> {
  let pkg: { scripts?: Record<string, unknown> }
  try {
    const { content } = await window.api.fs.readFile(joinPath(dir, 'package.json'))
    if (content === undefined) return null
    pkg = JSON.parse(content)
  } catch {
    return null
  }
  const script = pickRunScript(pkg.scripts)
  if (!script) return null
  let manager = 'npm'
  for (const [file, name] of LOCKFILES) {
    const stamp = await window.api.fs.statFile(joinPath(dir, file)).catch(() => null)
    if (stamp?.exists) {
      manager = name
      break
    }
  }
  return { command: runScriptCommand(manager, script), script }
}
