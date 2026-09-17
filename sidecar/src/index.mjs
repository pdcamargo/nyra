// Control plane for Nyra's browser.
//
// Deliberately thin. The renderer talks CDP to Chromium directly — frames and
// input never pass through here or through Rust — so this only has to do the
// things a raw CDP socket cannot: launch the browser, and own the
// BrowserContext that scopes a chat. Everything else the webview does itself
// over the one socket it already holds.
//
// Speaks newline-delimited JSON on stdout, which is how Rust learns the port
// and hears about a browser that went away. Same shape as the stream-json the
// Claude runner already parses.

import http from 'node:http'
import { BrowserHost } from './browser.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}
const TOKEN = args.get('token') ?? ''

function say(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

const host = new BrowserHost(say)

function send(res, status, body) {
  const payload = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // Nothing legitimate on this socket is large; a body this big is a bug or
    // a stranger.
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /state': async () => host.state(),
  'POST /chat/ensure': async (body) => host.ensureContext(body.chatId, body),
  'POST /chat/release': async (body) => host.releaseChat(body.chatId),
  'POST /chat/open-tab': async (body) => host.openTab(body.chatId, body.url),
  'POST /chat/touch': async (body) => host.touch(body.chatId)
}

const server = http.createServer(async (req, res) => {
  // Loopback-only, but any local process can still reach a loopback port. The
  // token is the whole authorisation story, same position webhook_server takes.
  if (TOKEN && req.headers['x-nyra-token'] !== TOKEN) return send(res, 401, { error: 'unauthorised' })

  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes[`${req.method} ${url.pathname}`]
  if (!route) return send(res, 404, { error: 'not found' })

  try {
    send(res, 200, await route(await readJson(req)))
  } catch (err) {
    send(res, 500, { error: String(err?.message ?? err) })
  }
})

server.listen(Number(args.get('port') ?? 0), '127.0.0.1', () => {
  say({ type: 'ready', port: server.address().port })
})

async function bail(reason) {
  say({ type: 'stopping', reason })
  await host.shutdown()
  process.exit(0)
}

// Chromium is a child of this process, not of Nyra. If Nyra goes away without
// saying so, stdin closes — that is the only signal we get, and leaking a
// headless browser is worse than exiting early.
process.stdin.on('end', () => void bail('stdin closed'))
process.stdin.resume()
process.on('SIGTERM', () => void bail('sigterm'))
process.on('SIGINT', () => void bail('sigint'))
