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
