#!/usr/bin/env node
/**
 * `tauri build`, with the two local secrets it needs.
 *
 * The updater key has always been passed in like this. The signing identity is
 * here for a less obvious reason.
 *
 * An ad-hoc signature — `signingIdentity: "-"`, which is what this shipped with
 * — has no designated requirement beyond its own cdhash:
 *
 *     designated => cdhash H"bed1abeb3b18…"
 *
 * macOS keys every privacy grant to that requirement: Desktop, Documents, and
 * the "would like to access data from other apps" prompt that a Claude Code
 * client trips constantly, because every shell command an agent runs inherits
 * the app's identity. A rebuild is a new cdhash, so every grant ever given dies
 * with the build that asked for it and the next launch asks again — which is
 * exactly what "why do I have to keep giving permission?" feels like from the
 * outside. Signed with a real certificate, the requirement names the
 * certificate:
 *
 *     designated => identifier "com.nyra.app" and anchor apple generic
 *                   and certificate leaf[subject.CN] = "Apple Development: …"
 *
 * That holds across every rebuild and every update, so a grant is given once.
 * Certificate renewal keeps the same common name, so it survives that too.
 *
 * Neither secret is in the repo. `~/.nyra/signing-identity` holds one line —
 * whatever `security find-identity -v -p codesigning` calls the certificate.
 * Without that file this falls back to ad-hoc and builds exactly as it used to;
 * it just goes on re-asking.
 *
 * What this does *not* buy is distribution: an Apple Development certificate is
 * not a Developer ID, so a download still needs notarization before Gatekeeper
 * will open it without a right-click. That was equally true of ad-hoc.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const line = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '')

const identityFile = join(homedir(), '.nyra', 'signing-identity')
const identity = line(identityFile)
const updaterKey = line(join(homedir(), '.tauri', 'nyra-updater.key'))

if (identity) {
  console.log(`signing as ${identity}`)
} else {
  console.warn(
    `no ${identityFile} — signing ad-hoc.\n` +
      '  The build works; macOS privacy grants just will not survive it.'
  )
}
if (!updaterKey) {
  console.warn('no ~/.tauri/nyra-updater.key — the updater artifact will not be signed.')
}

const tauri = join(root, 'node_modules', '.bin', 'tauri')
const result = spawnSync(existsSync(tauri) ? tauri : 'tauri', ['build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: {
    ...process.env,
    // `-` is codesign's own spelling of ad-hoc, and the config used to say it.
    APPLE_SIGNING_IDENTITY: identity || '-',
    TAURI_SIGNING_PRIVATE_KEY: updaterKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ''
  }
})

process.exit(result.status ?? 1)
