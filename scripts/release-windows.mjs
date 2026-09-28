#!/usr/bin/env node
/**
 * The Windows half of a release: `npm run release:windows`, after the Mac's.
 *
 * The Mac bumps the version, tags it, pushes, and creates the GitHub release
 * with its own `latest.json`. This builds the same tag on Windows, adds the
 * `windows-x86_64` entry to that manifest, and uploads the installer, its
 * signature and the merged manifest to the same release. It never bumps,
 * tags or pushes anything itself.
 *
 * No test gate here: the Mac's release already ran `npm test` and
 * `npm run test:rust` on this exact commit, and the Windows suites still carry
 * failures of their own (CRLF and POSIX-path assumptions in tests).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const repo = 'pdcamargo/nyra'
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`
const bundle = 'src-tauri/target/release/bundle/nsis'

const fail = (message) => {
  console.error(`\n${message}`)
  process.exit(1)
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

if (process.platform !== 'win32') fail('This is the Windows half of a release; run it on Windows.')

// The same commit the Mac shipped, or the two platforms are not one release.
git('fetch', '--tags', '--quiet')
let tagged = ''
try {
  tagged = git('rev-list', '-n', '1', tag)
} catch {
  fail(`No tag ${tag}. Release on the Mac first (npm run release / release:minor), then pull here.`)
}
if (git('rev-parse', 'HEAD') !== tagged) {
  fail(`HEAD is not ${tag}. Run \`git pull\` (or \`git checkout ${tag}\`) so this builds what the Mac shipped.`)
}

try {
  execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' })
} catch {
  fail(`No GitHub release ${tag} yet. The Mac's release creates it; run this once it exists.`)
}

// Unsigned, the installer would still install, but no Windows copy could ever
// verify an update. Refuse rather than ship that.
if (!existsSync(join(homedir(), '.tauri', 'nyra-updater.key'))) {
  fail('No ~/.tauri/nyra-updater.key. Copy it from the Mac; it is the same key for every platform.')
}

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true })
  if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed.`)
}

console.log(`Building ${tag} for Windows…`)
run('npm', ['run', 'package'])
run('node', ['scripts/release-manifest.mjs'])

const installer = readdirSync(bundle).find((f) => f.endsWith(`_${version}_x64-setup.exe`))
if (!installer) fail(`No installer for ${version} in ${bundle}.`)

console.log(`Uploading ${installer}, its signature and the merged latest.json to ${tag}…`)
execFileSync(
  'gh',
  [
    'release',
    'upload',
    tag,
    '--repo',
    repo,
    '--clobber',
    join(bundle, installer),
    join(bundle, `${installer}.sig`),
    'latest.json'
  ],
  { stdio: 'inherit' }
)

console.log(`\n${tag} now ships for Windows: ${installer}`)
