import { platform } from './platform'
import { resolvePath, samePath } from './paths'

/**
 * Design paths as they arrive from a chat, turned into one host path per file.
 *
 * Three hosts, and each spells paths its own way before Nyra ever sees them:
 *
 *   - macOS and Linux: `/Users/me/…`. Nothing to translate.
 *   - Windows: `C:\Users\me\…` from a Write, `C:/Users/me/…` from a script,
 *     `/c/Users/me/…` from Git Bash — one file, three spellings.
 *   - WSL: a chat running inside a distro says `/home/me/…` or `/mnt/c/…`,
 *     which the host only reaches as `\\wsl.localhost\Distro\home\me\…` and
 *     `C:\…`. `resolvePath` already knows that mapping (`toHostPath`), so it is
 *     applied first, always, and nothing here duplicates it.
 *
 * Comparison goes through `samePath`, which folds case and separators on
 * Windows only — the one rule that differs by host and the one that is easiest
 * to get subtly wrong by hand.
 */

const ROOT = String.raw`(?:[A-Za-z]:[\\/]|\\\\|/)`

/**
 * An absolute path to a design, quoted — which is the only way a path with a
 * space in it survives a shell command.
 */
const QUOTED = new RegExp(String.raw`(["'])(${ROOT}[^"'\n]*?\.nyui\.json)\1`, 'i')

/**
 * An absolute path to a design, unquoted, so it ends at the first space. The
 * lookbehind stops a match starting in the middle of a path or a word: a bare
 * `x.nyui.json` from an `ls`, or the tail of `files/x.nyui.json`, is not a
 * path Nyra can open, and resolving it against the project invents one.
 */
const BARE = new RegExp(String.raw`(?<![\w.\-\\/:~])${ROOT}[^\s"'\`<>|;&()]*\.nyui\.json`, 'i')

/** A line that starts with a design path, possibly with spaces in it. */
const LEADING = new RegExp(String.raw`^${ROOT}.*\.nyui\.json`, 'i')

/** The design a shell command names, if it names one by an absolute path. */
export function designPathInCommand(command: string): string | null {
  const quoted = QUOTED.exec(command)
  if (quoted) return quoted[2]
  return BARE.exec(command)?.[0] ?? null
}

/**
 * The design path a `nyra_design` answer names.
 *
 * Nyra's own answers put the path at the start of a line — "Write the
 * document to:\n<path>", "<path> did not compile" — so a line that begins
 * with one is read to its last `.nyui.json`, spaces included. Anything else
 * falls back to the unquoted form.
 */
export function designPathInText(text: string | undefined): string | null {
  if (!text) return null
  for (const line of text.split(/\r?\n/)) {
    const leading = LEADING.exec(line.trim())
    if (leading) return leading[0]
  }
  return BARE.exec(text)?.[0] ?? null
}

/**
 * The host path for a design path a chat produced.
 *
 * `resolvePath` first — it turns a WSL chat's `/home/…` and `/mnt/c/…` into
 * host paths, and a relative path into one under the chat's directory. Then,
 * on Windows only, Git Bash's `/c/…` becomes `C:\…` and separators become
 * backslashes, so the index, the watcher and the Summary all see one spelling.
 */
export function hostDesignPath(path: string, cwd: string, windows = platform().pathStyle === 'win32'): string {
  const hosted = resolvePath(path, cwd)
  if (!windows) return hosted
  const bash = /^\/([a-zA-Z])(?:\/|$)/.exec(hosted)
  const native = bash ? `${bash[1].toUpperCase()}:\\${hosted.slice(3)}` : hosted
  return native.replace(/\//g, '\\').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
}

/** Whether two design paths are one file, by this host's rules. */
export const sameDesign = (a: string, b: string): boolean => samePath(a, b)
