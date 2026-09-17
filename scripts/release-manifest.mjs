#!/usr/bin/env node
/**
 * Build the `latest.json` the updater asks for.
 *
 * Tauri writes an `.app.tar.gz` and a detached `.sig` beside the bundles; the
 * plugin needs a manifest naming them. Generated rather than hand-written
 * because the signature is a fresh blob every build, and a stale one fails with
 * "signature verification failed" rather than anything that points at the cause.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BUNDLE = 'src-tauri/target/release/bundle/macos'
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const repo = 'pdcamargo/nyra'

const archive = readdirSync(BUNDLE).find((f) => f.endsWith('.app.tar.gz'))
if (!archive) {
  console.error(
    `No .app.tar.gz in ${BUNDLE}. Is bundle.createUpdaterArtifacts set, and was the ` +
      `build signed (TAURI_SIGNING_PRIVATE_KEY)?`
  )
  process.exit(1)
}

const signature = readFileSync(join(BUNDLE, `${archive}.sig`), 'utf8').trim()

writeFileSync(
  'latest.json',
  JSON.stringify(
    {
      version,
      pub_date: new Date().toISOString(),
      platforms: {
        'darwin-aarch64': {
          signature,
          url: `https://github.com/${repo}/releases/download/v${version}/${archive}`
        }
      }
    },
    null,
    2
  ) + '\n'
)

console.log(`latest.json → v${version} (${archive})`)
