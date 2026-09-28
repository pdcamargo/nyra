/**
 * Which environment a chat's directory lives in, and what its paths are called
 * from here.
 *
 * A project under `\\wsl.localhost\Ubuntu\…` runs Claude, git and the terminal
 * inside the distro, so every path it prints is a Linux one: `/home/me/repo/a.ts`,
 * or `/mnt/c/…` for a Windows drive. This maps those back to paths Nyra can open,
 * and nothing else. The other direction — a host path handed to the distro — is
 * Rust's, in `src-tauri/src/environment/`, and both sides are tested against
 * `src/shared/wsl-paths.json` so the two cannot drift.
 *
 * Separate from `paths.ts` on purpose: that file is path *syntax*. Which distro a
 * chat is in is environment knowledge, and `/mnt` as the automount root is an
 * assumption about WSL, not about paths.
 */
import { platform } from './platform'

export type WslShare = {
  distro: string
  /** `\\wsl.localhost\` or `\\wsl$\` — whichever the cwd was spelled with, so a
   *  path handed back compares as a string against the project's own. */
  prefix: string
}

const SHARE_RE = /^(?:[\\/]{2}\?[\\/]UNC[\\/]|[\\/]{2})(wsl\.localhost|wsl\$)[\\/]([^\\/]+)/i

/** The distro share `cwd` is on, or null for a directory on this machine. */
export function wslShare(cwd: string): WslShare | null {
  if (platform().pathStyle !== 'win32') return null
  const match = SHARE_RE.exec(cwd)
  if (!match) return null
  const host = match[1].toLowerCase() === 'wsl$' ? 'wsl$' : 'wsl.localhost'
  return { distro: match[2], prefix: `\\\\${host}\\` }
}

/** `WSL · Ubuntu` for a directory inside a distro; null for one on this machine. */
export function environmentLabel(cwd: string): string | null {
  const share = wslShare(cwd)
  return share ? `WSL · ${share.distro}` : null
}

/**
 * A path inside the environment, written the way its own shell would show it:
 * `/home/me/dev/repo` with a home of `/home/me` reads `~/dev/repo`. Both come
 * from Rust (`environment_info`), already in the environment's own form, so
 * this is prefix work on POSIX paths and nothing more.
 */
export function tildeInEnv(path: string, home: string | null): string {
  if (!home || home === '/') return path
  const root = home.replace(/\/+$/, '')
  if (path === root) return '~'
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}

const DRIVE_RE = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/

/**
 * A path the chat's environment printed, as one Nyra can open.
 *
 * Only a Linux-absolute path in a WSL chat changes: `/mnt/<d>/…` becomes `D:\…`,
 * anything else the same path on the distro's share. A relative path, a Windows
 * path, a UNC path (`//server/…` included) and every path in a host chat come
 * back exactly as given.
 */
export function toHostPath(cwd: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path
  const share = wslShare(cwd)
  if (!share) return path
  const drive = DRIVE_RE.exec(path)
  if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`
  return `${share.prefix}${share.distro}\\${path.replace(/^\/+/, '').replace(/\//g, '\\')}`
}
