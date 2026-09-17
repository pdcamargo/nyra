#!/usr/bin/env node
/**
 * Clear what a failed `bundle_dmg.sh` left behind.
 *
 * It mounts a staging volume, and when it dies it leaves the volume mounted and
 * a `rw.<pid>.*.dmg` beside the bundles. The next build then fails on the stale
 * mount, leaves its own, and so on — five images and four failed builds later,
 * the updater artifact never gets made either, because a bundling error stops
 * the run before it.
 */
import { execSync } from 'node:child_process'
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const volumes = existsSync('/Volumes')
  ? readdirSync('/Volumes').filter((v) => v.startsWith('dmg.'))
  : []

for (const volume of volumes) {
  try {
    execSync(`hdiutil detach ${JSON.stringify(join('/Volumes', volume))} -force -quiet`)
    console.log(`ejected /Volumes/${volume}`)
  } catch {
    console.warn(`could not eject /Volumes/${volume} — is something running from it?`)
  }
}

// Anything .dmg: the half-written `rw.<pid>.*` staging images, and finished ones
// from an older version — the release uploads `dmg/*.dmg`, so a leftover from a
// previous version is an asset advertising itself as the current download.
for (const dir of ['src-tauri/target/release/bundle/macos', 'src-tauri/target/release/bundle/dmg']) {
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.dmg'))) {
    rmSync(join(dir, file), { force: true })
    console.log(`removed stale ${file}`)
  }
}
