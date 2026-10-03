/**
 * Upgrade design files on disk without the app open.
 *
 *   npm run design:upgrade -- <file or folder>... [--dry-run]
 *
 * The same chain the panel's "Upgrade file" runs, for a repo full of designs
 * at once. Folders are walked for `*.nyui.json`; `node_modules` and dot-folders
 * are skipped. Each original is copied to `~/.nyra/designs/backups/` before its
 * file is replaced — never beside it, so nothing new shows up in `git status`
 * but the upgraded files themselves.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { FORMAT_VERSION, NewerFormatError, serializeDocument, upgrade } from '../src/migrations'
import { validate } from '../src/pipeline'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targets = args.filter((a) => !a.startsWith('--'))
if (targets.length === 0) {
  console.error('usage: npm run design:upgrade -- <file or folder>... [--dry-run]')
  process.exit(2)
}

function* designFiles(path: string): Generator<string> {
  const st = statSync(path)
  if (st.isFile()) {
    if (path.endsWith('.nyui.json')) yield path
    return
  }
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    yield* designFiles(join(path, name))
  }
}

const backups = join(homedir(), '.nyra', 'designs', 'backups')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
let upgraded = 0
let failed = 0

for (const target of targets) {
  for (const file of designFiles(resolve(target))) {
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      console.error(`skip  ${file}: not valid JSON (${(e as Error).message})`)
      failed++
      continue
    }
    let out
    try {
      out = upgrade(json)
    } catch (e) {
      console.error(`skip  ${file}: ${e instanceof NewerFormatError ? e.message : (e as Error).message}`)
      failed++
      continue
    }
    if (!out) continue
    const checked = validate(out.doc)
    if (!checked.ok) {
      console.error(`skip  ${file}: upgraded, but the result does not validate — ${checked.issues[0]?.message}`)
      failed++
      continue
    }
    console.log(`${dryRun ? 'would ' : ''}upgrade ${file}  v${out.from} → v${out.to}`)
    for (const note of out.notes) console.log(`        ${note}`)
    if (dryRun) continue

    mkdirSync(backups, { recursive: true })
    const stem = basename(file).replace(/\.nyui\.json$/, '')
    copyFileSync(file, join(backups, `${stem}.v${out.from}.${stamp}.nyui.json`))
    const tmp = join(dirname(file), `.${basename(file)}.${process.pid}`)
    writeFileSync(tmp, serializeDocument(out.doc))
    renameSync(tmp, file)
    upgraded++
  }
}

console.log(
  dryRun
    ? `dry run — nothing written. Current format is v${FORMAT_VERSION}.`
    : `${upgraded} file(s) upgraded to v${FORMAT_VERSION}; originals in ${backups}.${failed ? ` ${failed} skipped.` : ''}`
)
process.exit(failed > 0 ? 1 : 0)
