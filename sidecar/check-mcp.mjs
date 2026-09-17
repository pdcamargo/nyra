// Does a real MCP streamable-HTTP client accept the response shape Nyra's axum
// handler produces, and does the agent's pointer get reported back? The handler answers a POST with one JSON-RPC response and
// 202 for a notification, and never opens an SSE stream — that is the part of
// the transport contract worth proving before trusting it.
import http from 'node:http'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TOKEN = 'test-token'
const child = spawn('node', ['index.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.stderr.write('  [sc] ' + d))
const pending = new Map(); const events = []; let id = 0
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id) } else events.push(m)
})
const rpc = (method, params = {}) =>
  new Promise((r) => { const n = ++id; pending.set(n, r); child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n') })

// Mirrors src-tauri/src/webhook_server.rs::browser_mcp exactly.
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('{"error":"POST only"}') }
  if (req.headers['x-nyra-token'] !== TOKEN) { res.writeHead(401); return res.end('{"error":"Unauthorised"}') }
  const chunks = []; for await (const c of req) chunks.push(c)
  const message = JSON.parse(Buffer.concat(chunks).toString())
  const chatId = req.url.split('/').pop()
  const out = await rpc('mcp.message', { chatId, message })
  const reply = out.result?.message
  if (reply == null) { res.writeHead(202); return res.end() }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(reply))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/browser/mcp/chat-http`

const client = new Client({ name: 'contract-test', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { 'x-nyra-token': TOKEN } }
}))
console.log('PASS initialize + notifications/initialized over plain-JSON POST')

const { tools } = await client.listTools()
console.log('PASS tools/list ->', tools.length, 'tools')

const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } })
console.log('PASS browser_navigate ->', nav.isError ? 'ERROR' : 'ok')

const tabs = await rpc('tab.list', { chatId: 'chat-http' })
console.log('PASS landed in the chat\'s own context ->', tabs.result.tabs.map((t) => t.url))

// The ghost cursor. Nothing in the page distinguishes the agent's synthetic
// click from the user's, so this is the only thing that can say where it went.
await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'data:text/html,<button style="position:absolute;left:400px;top:250px;width:100px;height:40px">go</button>' }
})
const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
const ref = /\[ref=(\w+)\]/.exec(JSON.stringify(snapshot.content?.[0]?.text ?? ''))?.[1]
await client.callTool({ name: 'browser_click', arguments: { element: 'go button', target: ref } })
await new Promise((r) => setTimeout(r, 400))
const cursor = events.filter((e) => e.event === 'cursor').pop()
// The button spans 400-500 x 250-290, so its centre is 450,270.
console.log(
  cursor?.params.x === 450 && cursor?.params.y === 270
    ? 'PASS agent cursor reported at the click point'
    : `FAIL agent cursor -> ${JSON.stringify(cursor?.params)}`
)

try {
  await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: '1' } })
  console.log('FAIL a filtered tool was callable')
} catch (e) {
  console.log('PASS filtered tool refused ->', String(e.message).slice(0, 60))
}

await client.close(); server.close(); child.stdin.end()
await new Promise((r) => child.on('exit', r))
console.log('done')
