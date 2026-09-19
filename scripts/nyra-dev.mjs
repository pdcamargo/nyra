#!/usr/bin/env node
/**
 * Look inside a running Nyra from outside it.
 *
 * Nyra is used to develop Nyra, so there is usually a dev instance and an
 * installed one running at once, and until now no way to see into either. This
 * talks to the loopback server every instance already runs (`webhook_server.rs`)
 * and reaches the real WKWebView behind it — so a screenshot is the actual app,
 * not the renderer loaded in a browser tab where there is no Tauri IPC and
 * nothing works.
 *
 *   node scripts/nyra-dev.mjs instances
 *   node scripts/nyra-dev.mjs shot [--max-width 1400]
 *   node scripts/nyra-dev.mjs eval 'document.title'
 *   node scripts/nyra-dev.mjs log [-n 200] [--grep renderer]
 *
 * Targets the dev instance unless told otherwise: --port N, or --profile release.
 *
 * The screenshot is WebKit's own software re-render, which is why it needs no
 * Screen Recording permission and works when the window is behind others. The
 * same fact means hardware-accelerated layers — WebGL, video, the browser
 * panel's canvas — come back blank, and window chrome is outside the image.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The range `webhook_server::start` walks from its preferred 8787.
const FIRST_PORT = 8787
const LAST_PORT = 8797
const REGISTRY = path.join(os.homedir(), '.nyra', 'devtools')

const args = process.argv.slice(2)
const command = args[0]

function flag(name, fallback = undefined) {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

function die(message) {
  console.error(message)
  process.exit(1)
}

// Generous, because this is the cost of a wrong answer: a closed port refuses
// immediately either way, and the only thing the timeout governs is how long we
// wait on an instance that is busy. Too tight and a loaded dev build reads as
// "not running".
const PROBE_MS = 1500

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(PROBE_MS)
    })
    if (!res.ok) return null
    const body = await res.json()
    if (!body || typeof body !== 'object') return null
    // An instance from before this feature answers `{ok:true}` and nothing
    // else. Say so rather than printing `undefined` at someone.
    return { profile: body.profile ?? 'legacy', ...body, port }
  } catch {
    // Refused, timed out, or not a Nyra. All the same answer.
    return null
  }
}

/** Every Nyra currently listening. Probing beats a registry file: a dead port
 *  refuses in microseconds, so nothing here can go stale. */
async function instances() {
  const ports = Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i)
  const found = await Promise.all(ports.map(probe))
  return found.filter(Boolean)
}

function tokenFor(port) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REGISTRY, `${port}.json`), 'utf-8')).token
  } catch {
    return null
  }
}

async function target() {
  const wanted = flag('port')
  const profile = flag('profile', 'debug')
  const running = await instances()

  if (running.length === 0) {
    die(
      'No Nyra is listening on 8787-8797.\n' +
        'Start the one you want to inspect with `npm run dev`, then try again.'
    )
  }

  if (wanted) {
    const hit = running.find((i) => String(i.port) === String(wanted))
    if (!hit) die(`Nothing is listening on ${wanted}. Running: ${running.map((i) => i.port).join(', ')}`)
    return hit
  }

  const matches = running.filter((i) => i.profile === profile)
  if (matches.length === 0) {
    const others = running
      .map((i) => `  ${i.port}  ${i.profile}${i.version ? `  v${i.version}` : ''}`)
      .join('\n')
    const legacy = running.some((i) => i.profile === 'legacy')
    die(
      `No ${profile}-profile Nyra is running.\n` +
        (profile === 'debug' ? 'Start one with `npm run dev`.\n' : '') +
        `Currently listening:\n${others}\n` +
        (legacy
          ? 'A "legacy" instance is one built before this feature — restart it on a current build to inspect it.\n'
          : '') +
        'Pick one explicitly with --port N.'
    )
  }
  if (matches.length > 1) {
    const list = matches.map((i) => `  ${i.port}  pid ${i.pid}`).join('\n')
    die(`More than one ${profile} instance is running — pick one with --port N:\n${list}`)
  }

  const hit = matches[0]
  if (!hit.devtools) {
    die(
      `The instance on ${hit.port} (${hit.profile} v${hit.version}) has devtools off.\n` +
        'Debug builds have them on by default; for a release build, relaunch it with NYRA_DEVTOOLS=1.'
    )
  }
  return hit
}

async function post(instance, route, body) {
  const token = tokenFor(instance.port)
  if (!token) {
    die(
      `No token for port ${instance.port} at ${path.join(REGISTRY, `${instance.port}.json`)}.\n` +
        'That file is written when the instance starts — it may predate this feature, so restart it.'
    )
  }
  const res = await fetch(`http://127.0.0.1:${instance.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nyra-token': token },
    body: JSON.stringify(body ?? {})
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    die(`${route} answered ${res.status} with something that is not JSON:\n${text.slice(0, 400)}`)
  }
  if (!res.ok) die(`${route} answered ${res.status}: ${parsed.error ?? text}`)
  return parsed
}

// --- commands ---------------------------------------------------------------

async function cmdInstances() {
  const running = await instances()
  if (running.length === 0) {
    console.log('Nothing listening on 8787-8797. Start one with `npm run dev`.')
    return
  }
  console.log('port  profile  version  devtools  pid     exe')
  for (const i of running) {
    const exe = (i.exe ?? '—').replace(os.homedir(), '~')
    console.log(
      `${String(i.port).padEnd(6)}${(i.profile ?? '?').padEnd(9)}${String(i.version ?? '?').padEnd(9)}` +
        `${String(!!i.devtools).padEnd(10)}${String(i.pid ?? '?').padEnd(8)}${exe}`
    )
  }
}

async function cmdShot() {
  const instance = await target()
  const maxWidth = Number(flag('max-width', '1400'))
  const shot = await post(instance, '/dev/screenshot', { maxWidth })
  if (shot.error) die(shot.error)
  console.log(shot.path)
  console.error(`  ${shot.width}x${shot.height}px, ${(shot.bytes / 1024).toFixed(0)} KB, port ${instance.port}`)
}

async function cmdEval() {
  const code = args.slice(1).find((a) => !a.startsWith('--'))
  if (!code) die("Nothing to evaluate. Try: nyra-dev.mjs eval 'document.title'")
  const instance = await target()
  const result = await post(instance, '/dev/eval', { code })
  if (result.ok === false) die(result.error ?? 'evaluation failed')
  console.log(JSON.stringify(result.value ?? null, null, 2))
}

async function cmdLog() {
  const instance = await target()
  const wanted = Number(flag('n', args.includes('-n') ? args[args.indexOf('-n') + 1] : '200'))
  const grep = flag('grep')
  if (!instance.logPath) die('That instance did not report a log path — it predates this feature.')
  if (!fs.existsSync(instance.logPath)) die(`No log yet at ${instance.logPath}.`)

  let lines = fs.readFileSync(instance.logPath, 'utf-8').split('\n').filter(Boolean)
  if (grep) lines = lines.filter((l) => l.includes(grep))
  console.error(`# ${instance.logPath} (${instance.profile} v${instance.version}, pid ${instance.pid})`)
  console.log(lines.slice(-wanted).join('\n'))
}

const commands = {
  instances: cmdInstances,
  shot: cmdShot,
  eval: cmdEval,
  log: cmdLog
}

if (!command || !commands[command]) {
  die(
    `Usage: node scripts/nyra-dev.mjs <${Object.keys(commands).join('|')}> [options]\n\n` +
      "  instances                     every Nyra currently listening\n" +
      '  shot [--max-width 1400]       PNG of the window; prints the path\n' +
      "  eval '<expression>'           evaluate in the renderer, print the JSON\n" +
      '  log [-n 200] [--grep renderer]  tail that instance\'s debug log\n\n' +
      '  --port N | --profile debug|release   which instance (default: the dev one)'
  )
}

await commands[command]()
