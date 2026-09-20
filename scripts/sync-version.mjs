#!/usr/bin/env node
/**
 * Carry the version npm just bumped into the two files Tauri actually reads.
 *
 * `npm version` only touches package.json. Tauri takes the app's version from
 * `tauri.conf.json`, so a release cut without this builds the *old* version
 * while the update manifest advertises the new one — the updater then installs
 * something that still reports the version it started on, and offers the same
 * update again, forever.
 *
 * Run from npm's `version` lifecycle, which fires after the bump and before the
 * commit, so staging here puts all three files in one coherent commit.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
conf.version = version
writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n')

const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
writeFileSync('src-tauri/Cargo.toml', cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`))

// Cargo.lock carries it too, and a stale one makes the next build dirty the tree.
//
// This ran from the repo root for nine releases and failed every time — the
// manifest is in `src-tauri/`, so cargo exited 101 with "could not find
// Cargo.toml", and `2>/dev/null || true` plus `stdio: 'ignore'` swallowed all of
// it. Every release since has needed a follow-up "Carry 0.0.N into Cargo.lock"
// commit. Hence: the manifest path, no `|| true`, and a read-back — a lockfile
// that quietly does not move is the exact failure being fixed here.
execSync(`cargo update -p nyra --precise ${version} --manifest-path src-tauri/Cargo.toml`, {
  stdio: 'inherit'
})
const lock = readFileSync('src-tauri/Cargo.lock', 'utf8')
if (!new RegExp(`name = "nyra"\\nversion = "${version.replace(/\./g, '\\.')}"`).test(lock)) {
  throw new Error(`Cargo.lock still does not name nyra ${version} — the release would be dirty`)
}
execSync('git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock')

console.log(`version → ${version} (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)`)
