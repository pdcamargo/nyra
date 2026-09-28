#!/usr/bin/env node
/**
 * Build the `latest.json` the updater asks for.
 *
 * Tauri writes an updater artifact and a detached `.sig` beside the bundles;
 * the plugin needs a manifest naming them. Generated rather than hand-written
 * because the signature is a fresh blob every build, and a stale one fails with
 * "signature verification failed" rather than anything that points at the cause.
 *
 * One manifest serves every platform, and each platform's build runs on its own
 * machine. The Mac releases first and writes it fresh, as it always has. Windows
 * comes second (`npm run release:windows`): it downloads the manifest the Mac
 * published and adds its own entry, so neither platform's users are ever handed
 * a manifest that has forgotten the other.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const repo = 'pdcamargo/nyra'

const PLATFORMS = {
  darwin: {
    key: 'darwin-aarch64',
    bundle: 'src-tauri/target/release/bundle/macos',
    artifact: (f) => f.endsWith('.app.tar.gz'),
    merge: false
  },
  win32: {
    key: 'windows-x86_64',
    bundle: 'src-tauri/target/release/bundle/nsis',
    // The NSIS installer *is* the updater artifact in Tauri 2. Matched by
    // version because older installers stay in the folder between builds.
    artifact: (f) => f.endsWith(`_${version}_x64-setup.exe`),
    merge: true
  }
}

const platform = PLATFORMS[process.platform]
if (!platform) {
  console.error(`No release target for ${process.platform}.`)
  process.exit(1)
}

const archive = existsSync(platform.bundle)
  ? readdirSync(platform.bundle).find(platform.artifact)
  : undefined
if (!archive) {
  console.error(
    `No updater artifact for v${version} in ${platform.bundle}. Is bundle.createUpdaterArtifacts ` +
      `set, and was the build signed (TAURI_SIGNING_PRIVATE_KEY)?`
  )
  process.exit(1)
}
const sigPath = join(platform.bundle, `${archive}.sig`)
if (!existsSync(sigPath)) {
  console.error(`${archive} has no .sig beside it — the build was not signed with the updater key.`)
  process.exit(1)
}
const signature = readFileSync(sigPath, 'utf8').trim()

/** The manifest the first platform published for this version. */
function published() {
  const dir = mkdtempSync(join(tmpdir(), 'nyra-manifest-'))
  try {
    execFileSync('gh', ['release', 'download', `v${version}`, '--repo', repo, '--pattern', 'latest.json', '--dir', dir], {
      stdio: ['ignore', 'ignore', 'inherit']
    })
    const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))
    if (manifest.version !== version) {
      throw new Error(`the release's latest.json says ${manifest.version}, not ${version}`)
    }
    return manifest
  } catch (error) {
    console.error(
      `Could not read latest.json from release v${version}: ${error.message}\n` +
        '  The Mac releases first and publishes it; run this once that release exists.'
    )
    process.exit(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const manifest = platform.merge
  ? published()
  : { version, pub_date: new Date().toISOString(), platforms: {} }

manifest.platforms[platform.key] = {
  signature,
  url: `https://github.com/${repo}/releases/download/v${version}/${archive}`
}

writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n')

console.log(
  `latest.json → v${version}: ${Object.keys(manifest.platforms).join(', ')} (${platform.key}: ${archive})`
)
