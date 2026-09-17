// The agent's half of the browser.
//
// Claude reaches this through an MCP server per chat, bound to that chat's
// BrowserContext. That binding is the whole reason the sidecar hosts these
// rather than Claude spawning `@playwright/mcp --cdp-endpoint` itself: a CDP
// endpoint is the whole browser, so one agent would see every chat's tabs.
// `createConnection(config, contextGetter)` takes a context we already own,
// which scopes the tools without forking the tool set.
//
// Transport is Nyra's own pipe. MCP's streamable-HTTP transport wants to own a
// request and a response object, and we have neither here — Rust terminates the
// HTTP and relays the JSON-RPC down the same pipe everything else uses. The
// upside is that a sidecar restart is invisible to Claude: the endpoint it was
// given belongs to Nyra, and Nyra does not go away.

import { createConnection } from '@playwright/mcp'

const CAPABILITIES = ['core', 'core-navigation', 'core-tabs', 'core-input']

/**
 * What the agent gets. Every chat carries these definitions in its context
 * whether or not it ever browses, so the list is a budget rather than a menu —
 * and `capabilities` alone still leaves 26 of them.
 *
 * Left out on purpose: `browser_run_code_unsafe`, because `browser_evaluate`
 * covers the legitimate case without the name inviting the other one;
 * `browser_resize`, because the viewport is pinned and a tool that fights that
 * would only produce confusing screenshots; file upload, drag and drop, and the
 * WebMCP pair, because they are rare enough not to earn the tokens.
 */
const TOOLS = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_find',
  'browser_wait_for',
  'browser_evaluate',
  'browser_console_messages',
  'browser_network_requests',
  'browser_handle_dialog',
  'browser_tabs'
])

class PipeTransport {
  constructor() {
    this.pending = new Map()
  }

  async start() {}

  /** Server → client. Replies land back on the request that is waiting for
   *  them; anything the server started on its own has nowhere to go, because
   *  an HTTP POST only carries one answer. */
  async send(message) {
    const resolve = message.id != null ? this.pending.get(message.id) : undefined
    if (!resolve) return
    this.pending.delete(message.id)
    resolve(trimToolList(message))
  }

  async close() {
    for (const resolve of this.pending.values()) resolve(null)
    this.pending.clear()
    this.onclose?.()
  }

  /** Client → server, and back with whatever it answers. */
  deliver(message) {
    // Refuse a tool we did not advertise. Upstream can add tools in a patch
    // release, and a model that saw a name somewhere else can ask for it.
    if (message.method === 'tools/call' && !TOOLS.has(message.params?.name)) {
      return Promise.resolve({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown tool ${message.params?.name}` }
      })
    }
    // A notification has no id and expects no reply.
    if (message.id == null) {
      this.onmessage?.(message)
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve)
      this.onmessage?.(message)
    })
  }
}

export class ChatMcp {
  constructor(server, transport) {
    this.server = server
    this.transport = transport
  }

  static async open(getContext) {
    const transport = new PipeTransport()
    const server = await createConnection({ capabilities: CAPABILITIES }, getContext)
    await server.connect(transport)
    return new ChatMcp(server, transport)
  }

  handle(message) {
    return this.transport.deliver(message)
  }

  async close() {
    await this.server.close().catch(() => {})
  }
}

/** Drop the tools we do not expose from a `tools/list` reply. */
function trimToolList(message) {
  const tools = message?.result?.tools
  if (!Array.isArray(tools)) return message
  return {
    ...message,
    result: { ...message.result, tools: tools.filter((tool) => TOOLS.has(tool.name)) }
  }
}
