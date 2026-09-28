# WSL projects

Windows Nyra working on a project that lives inside WSL, the way VS Code's
Remote-WSL does it: the code, `git` and `claude` stay in the distro, and Nyra
stays a native Windows app. This is a design, not a report — none of it is
built. Build it on a Windows machine with WSL, where each step can be run as it
is written.

Running the *Linux build* of Nyra inside WSLg is a different thing, and none of
this needs it.

## The shape: an environment per project

`platform/` is chosen at compile time: a Windows binary is always Windows. WSL is
chosen at runtime, per project, and one Nyra can have a Windows project and a WSL
project open side by side. So it does not go in `platform/`. It is a second
layer beside it, `src-tauri/src/environment/`:

```rust
pub enum Environment {
    Host,
    Wsl { distro: String },
}

impl Environment {
    /// From a project directory: `\\wsl.localhost\Ubuntu\home\me\repo` and
    /// `\\wsl$\Ubuntu\…` are WSL, anything else is the host.
    pub fn of(cwd: &str) -> Environment;

    /// A command that runs *inside* this environment, with `cwd` as its
    /// working directory. Host: `platform::command`. WSL: `wsl.exe`, below.
    pub fn command(&self, program: &str, cwd: &str) -> tokio::process::Command;
    pub fn pty_command(&self, program: &str, cwd: &str) -> portable_pty::CommandBuilder;

    /// A path the environment printed, as one Nyra can open, and back.
    pub fn to_host(&self, path: &str) -> PathBuf;
    pub fn to_env(&self, host: &Path) -> String;

    /// The environment's home, as a host path: where its `~/.claude` is.
    pub fn home(&self) -> PathBuf;
}
```

`Host` delegates everything to `platform::`, so every call site that switches
to it behaves exactly as it does today. The rule that makes it hold together:
**anything that spawns in, or takes a path from, a project's directory goes
through that project's `Environment`**, the way everything already goes through
`platform::command`. Only `Environment` knows `wsl.exe` exists.

The renderer does not translate paths. It keeps sending whatever path it has,
along with the chat's cwd, and the Rust side resolves it through
`Environment::of(cwd)`. Otherwise the same translation would be written twice.

## Path translation

These are pure functions, so unit-test them first — they can be tested on any
OS.

| From | To |
|---|---|
| `\\wsl.localhost\Ubuntu\home\me\repo` (or `\\wsl$\…`) | `/home/me/repo` |
| `/mnt/c/Users/me/x.png` | `C:\Users\me\x.png` |
| `/home/me/repo/src/a.ts` | `\\wsl.localhost\Ubuntu\home\me\repo\src\a.ts` |
| `C:\Users\me\AppData\Local\Temp\nyra-files-123\a.png` | `/mnt/c/Users/me/AppData/Local/Temp/nyra-files-123/a.png` |

`/mnt` is WSL's default automount root; `wsl.conf` can move it. To start with,
assume `/mnt`. Ask `wslpath` once per distro only if someone has moved it.

The last row is attachments: Nyra stages images in the Windows `%TEMP%`, and
Claude in WSL needs a path it can read.

## Build order

Each step is usable on its own and testable before the next.

1. **Detect.** `Environment::of`, the translation table with tests, and a
   "WSL · Ubuntu" marker on the project. Picking a folder under the Linux
   entry in the folder dialog should produce a WSL project.
2. **Run Claude in the distro.** `spawn_session` goes through
   `Environment::command`: `wsl.exe -d <distro> --cd <linux cwd> --exec …`.
   - Resolve `claude` inside the distro with a login shell (`bash -lc
     'command -v claude'`), once per distro. `--exec` gets no rc files, so a
     bare `claude` would not be on PATH.
   - Pass the system prompt with `--append-system-prompt-file` and the servers
     with `--mcp-config <file>` (both in CLI 2.1.281), written to a file under
     the distro's `/tmp`. `wsl.exe` re-quotes its command line, and a
     multi-line argument does not survive that. Doing the same on the Windows
     host fixes its 32K command-line limit too.
   - Stop is the stdin interrupt, which goes through `wsl.exe`'s pipes as it
     is. **Verify that killing `wsl.exe` ends the Linux `claude`.** If it does
     not, dispose has to close stdin first (the CLI exits on EOF), then kill.
   - `util::clean_child_env` does not reach inside WSL. Only variables listed in
     `WSLENV` cross over, and Claude should get the distro's own environment.
3. **Paths back.** Every Rust command that takes a file path from the renderer
   resolves it through the chat's environment: preview, file tabs, the
   Edit/Write original-content capture in `claude.rs`, plan files, subagent
   output files in `subagents.rs`. Attachments go the other way.
4. **The distro's `~/.claude`.** `util::claude_project_dir`, `memory.rs` and
   `ai_title.rs` read `Environment::home()` instead of the Windows home. Ask
   `$HOME` once per distro. Its login, its MCP config (`~/.claude.json`),
   skills, plugins and hooks all live there as well. `claude /login` runs
   through `pty_command`, because the distro's CLI has its own login.
5. **Git, terminal, file lists.** Run all of them inside the distro. Windows git
   against `\\wsl.localhost` is slow, because every read crosses the file
   share. It also refuses the repo outright with "detected dubious ownership",
   because the files belong to the Linux user. The terminal is
   `wsl.exe -d <distro> --cd <dir>` in the PTY. `wsl.exe` costs something to
   start each time, so measure the file tree's git calls, and batch them if
   that cost adds up.
6. **MCP networking.** See the decision below.

### Left out of the first version

Say so in the UI rather than failing silently:

- Background-shell tracking (`processes.rs`): its pids are Linux pids, and
  `pgrep`/`lsof` would have to run inside the distro.
- Flow file triggers: `notify` gets no events across the file share. A watcher
  inside the distro (`inotifywait`) is the eventual fix.
- "Open with" an editor. `code --remote wsl+Ubuntu <path>` is the obvious one
  to add later.

## Decision: how Claude in WSL reaches Nyra's MCP servers

`nyra-browser` and `nyra-app` are served at `127.0.0.1:<port>` on Windows. Under
WSL2's default NAT networking, loopback inside the distro is the distro's own,
so Claude cannot reach them.

- **A. Require mirrored networking.** Mirrored networking needs Windows 11
  22H2 or later, set with `networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`.
  In that mode the distro shares the host's loopback, so nothing changes: same
  URL, same loopback-only listener. Without it, the two MCP servers are left
  off for WSL chats, with a notice explaining how to turn mirrored networking on.
- **B. Also listen on the WSL adapter.** Bind a second listener on the
  `vEthernet (WSL)` address and hand WSL chats that URL. This works on every
  WSL2, but Nyra becomes reachable from anything that can reach that adapter.
  The `x-nyra-token` check is then all that protects `app/mcp`, which can
  drive the whole app.

**Recommendation: A.** It keeps "loopback only", which the webhook server is
built around, and the fallback is clear rather than half-working. B can come
later if people hit it, behind a setting.

## Test checklist

Run this on the Windows machine with a project in WSL:

1. The project opens from `\\wsl.localhost\…` and is marked as WSL.
2. A chat streams, and `claude` is the distro's (`claude --version` inside it).
3. Stop, then another message: no cold start.
4. Clicking a file Claude edited opens it; the Changes tab shows diffs.
5. Memory and AI titles come from the distro's `~/.claude`.
6. The terminal opens in the distro, in the project directory.
7. An image attachment reaches Claude.
8. With mirrored networking, the browser and app tools work. Without it, the
   notice shows.
9. Quitting Nyra leaves no `claude` running in the distro (`ps aux` there).
