#!/usr/bin/env node
/**
 * Find the stalls in a Nyra debug log.
 *
 * Every backend log line is timestamped, so the slow step in a turn shows up as
 * a gap between consecutive lines. Prints the biggest ones with the events on
 * either side, which is usually enough to name the culprit.
 *
 *   node scripts/log-gaps.mjs [path] [--top N]
 */
import fs from 'node:fs'

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--')) ?? '/tmp/nyra-debug.log'
const top = Number(args[args.indexOf('--top') + 1]) || 15

if (!fs.existsSync(path)) {
  console.error(`no log at ${path} — run the app first`)
  process.exit(1)
}

const STAMP = /^\[([0-9T:.\-+]+)\]\s*(.*)$/
const entries = []
for (const line of fs.readFileSync(path, 'utf-8').split('\n')) {
  const m = line.match(STAMP)
  if (!m) continue
  const t = Date.parse(m[1])
  if (Number.isFinite(t)) entries.push({ t, text: m[2] })
}

if (entries.length < 2) {
  console.error(`only ${entries.length} timestamped line(s) — nothing to compare`)
  process.exit(1)
}

const gaps = []
for (let i = 1; i < entries.length; i++) {
  gaps.push({ ms: entries[i].t - entries[i - 1].t, before: entries[i - 1], after: entries[i] })
}
gaps.sort((a, b) => b.ms - a.ms)

const span = entries.at(-1).t - entries[0].t
console.log(`${entries.length} entries over ${(span / 1000).toFixed(1)}s\n`)
console.log(`top ${top} gaps:\n`)

const clip = (s) => (s.length > 110 ? s.slice(0, 110) + '…' : s)
for (const g of gaps.slice(0, top)) {
  if (g.ms < 100) break
  console.log(`  ${(g.ms / 1000).toFixed(2)}s`)
  console.log(`    after : ${clip(g.before.text)}`)
  console.log(`    before: ${clip(g.after.text)}\n`)
}

const stalled = gaps.filter((g) => g.ms >= 1000).reduce((a, g) => a + g.ms, 0)
console.log(`time sitting in gaps >= 1s: ${(stalled / 1000).toFixed(1)}s of ${(span / 1000).toFixed(1)}s`)
