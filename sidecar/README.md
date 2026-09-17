# Browser sidecar

Owns the Chromium behind Nyra's browser panel.

Nyra spawns this with the resolved `node` (see `util::child_path`) and talks to
it over stdin/stdout in newline-delimited JSON — the same shape `claude.rs` uses
for the Claude CLI, for the same reason: one pipe carries the protocol, and the
pipe closing is how we learn the child died.

- Requests in: `{"id":1,"method":"chat.open","params":{...}}`
- Replies out: `{"id":1,"result":{...}}` / `{"id":1,"error":"..."}`
- Events out:  `{"event":"tabs","params":{...}}`

Pixels do **not** go through here. The renderer holds its own CDP WebSocket
straight to Chromium and runs `Page.startScreencast` on its own flat sessions;
this process only launches the browser, owns one `BrowserContext` per chat, and
keeps the tab registry.

## Checks

Neither runs in CI — both launch a real browser, and the point of them is the
things a unit test cannot see.

- `node check-browser.mjs` — does `Page.startScreencast` stream continuously in
  new headless, and can a second CDP client screencast and dispatch input while
  Playwright drives the same page? Both were load-bearing assumptions.
- `node check-mcp.mjs` — does a real MCP streamable-HTTP client accept the
  response shape Nyra's axum handler produces? It answers a POST with one
  JSON-RPC response and 405s the SSE GET, which is the whole of the transport
  we implement. This is how we learned the GET has to be a 405 and not a 404.
