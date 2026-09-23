// Ask one configured MCP server what it exposes, and nothing else.
//
// Nyra's MCP panel wants to show a server's real tools — names, descriptions,
// parameter names — rather than the `pending` row a config file alone can
// justify. The only honest source for that is the server, so this opens a
// client, completes the handshake, asks for `tools/list`, and leaves. No tool
// is ever called: an inspector that could run `delete_file` to find out what it
// does would be a worse feature than no inspector.
//
// It is a one-shot process rather than a method on `index.mjs` on purpose.
// Inspecting a stdio server means spawning it, and a server that wedges on
// startup would otherwise take the browser sidecar down with it. Here a
// timeout costs one process that is already exiting.
//
// Wire: one JSON object on stdin, one JSON line on stdout, then exit.
//   in  { transport, command, args, url, env, headers, cwd, timeoutMs }
//   out { ok: true, protocolVersion, serverInfo, tools: [...] }
//     | { ok: false, error }
//
// `env` and `headers` are the server's credentials. They arrive because they
// are the only way to reach the server, and they never leave: no diagnostic
// here quotes a config value, and any error text is scrubbed against them
// before it is printed.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const FAILED = (error) => ({ ok: false, error: String(error?.message ?? error) })

function sanitise(spec) {
  const secrets = [...Object.values(spec.env ?? {}), ...Object.values(spec.headers ?? {})].filter(
    (value) => typeof value === 'string' && value.length >= 4
  )
  return (message) => {
    let out = String(message ?? '')
    for (const secret of secrets) out = out.split(secret).join('***')
    return out
  }
}

/** The tool list, flattened to what a row and its expanded detail need. */
function shapeTools(tools) {
  return (tools ?? []).map((tool) => {
    const schema = tool.inputSchema ?? tool.input_schema ?? null
    const properties = schema?.properties ?? {}
    const required = new Set(schema?.required ?? [])
    return {
      name: tool.name,
      description: tool.description ?? '',
      parameters: Object.keys(properties).map((name) => ({
        name,
        type: properties[name]?.type ?? 'any',
        required: required.has(name)
      })),
      inputSchema: schema
    }
  })
}

async function withClient(spec, transport) {
  const client = new Client({ name: 'nyra', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    return {
      ok: true,
      protocolVersion: client.getNegotiatedProtocolVersion?.() ?? null,
      serverInfo: client.getServerVersion() ?? null,
      capabilities: client.getServerCapabilities() ?? null,
      tools: shapeTools(listed?.tools)
    }
  } finally {
    await client.close().catch(() => {})
  }
}

function openTransport(spec) {
  const headers = spec.headers ?? {}
  if (spec.url) {
    const url = new URL(spec.url)
    if (spec.transport === 'sse') {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { headers }
      })
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  }
  if (!spec.command) throw new Error('This server has neither a command nor a URL.')
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    cwd: spec.cwd,
    // The user's PATH as Nyra resolved it, plus whatever the config adds. A
    // server that needs `npx` would otherwise ENOENT under a GUI launch.
    env: { ...process.env, ...(spec.env ?? {}) },
    // A stdio server writing progress to stderr has nowhere to go. Inheriting
    // it would put a stranger's log lines on our stdout, which is a protocol.
    stderr: 'ignore'
  })
}

async function readSpec() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const line = raw.split('\n').find((l) => l.trim().length > 0)
  if (!line) throw new Error('No server description on stdin.')
  return JSON.parse(line)
}

async function main() {
  const spec = await readSpec()
  const scrub = sanitise(spec)
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 20_000

  let timer = null
  const raced = await Promise.race([
    withClient(spec, openTransport(spec)).catch((error) => FAILED(error)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(FAILED(new Error('Timed out waiting for the server.'))), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))

  if (raced.ok) {
    process.stdout.write(JSON.stringify(raced) + '\n')
  } else {
    // The message is the only thing worth keeping, and it may quote a command
    // line — which is exactly what `--args` sometimes carries a token in.
    process.stdout.write(JSON.stringify({ ok: false, error: scrub(raced.error) }) + '\n')
  }
}

try {
  await main()
} catch (error) {
  process.stdout.write(JSON.stringify(FAILED(error)) + '\n')
}

// The MCP child is a child of this process, and its pipes are open. Exiting is
// the point of a one-shot; `client.close()` already asked it to stop.
process.exit(0)
