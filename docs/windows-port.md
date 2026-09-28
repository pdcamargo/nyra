# Windows port

Phase 1 was written on a Mac: every OS difference moved behind
`src-tauri/src/platform/` and `src/renderer/src/lib/platform.ts` (see
"Platforms" in `AGENTS.md`). It compiles and links for
`x86_64-pc-windows-msvc`, and nothing here has run on Windows yet. Phase 2 is
this list, on a real Windows machine.

## Setup

- Rust (MSVC toolchain), Node 22, Git for Windows. Claude Code needs Git Bash,
  and so do flow script nodes: `platform::script_command` looks for it.
- The Claude CLI, from the native installer (`claude.exe` in
  `%USERPROFILE%\.local\bin`) or from npm (`claude.cmd`). Try both if you can:
  the npm shim is run as `node cli.js`, because `cmd.exe` cannot carry the
  multi-line system prompt.
- `npm install`, then `npm run dev`.
- Clone after `.gitattributes` is in, so the checkout is LF. `git status`
  should be clean right after cloning.

## Checklist

Each item is a thing to do in the running app and what should happen. A
failure is fixed in `platform/` or as a trait in `lib/platform.ts`, never as an
`if windows` at the call site.

1. **Launch.** The window opens with our title bar, and minimise, maximise and
   close work. So do dragging, double-click to maximise, Win+Up, snapping and
   resizing from the edges. The window is undecorated
   (`tauri.windows.conf.json`).
2. **No console windows.** Nothing flashes up while chatting, while the file tree
   loads, or while the Changes tab refreshes. Each flash is a spawn that skipped
   `platform::command`.
3. **Chat.** A prompt streams and the model picker lists your models.
4. **Stop.** Stop a long answer, then send another message. The reply should
   start without a cold start: the process survives, because Stop is a stdin
   interrupt, not a signal.
5. **Title and memory.** A new chat gets an AI title. The Memory tab finds
   `~\.claude\projects\C--Users-…\memory`.
6. **Files.** The file tree, file tabs, breadcrumbs, Quick Open and `@` mentions
   (including `@..\other`) all work with backslash paths. "Reveal in File
   Explorer" opens Explorer.
7. **Changes.** The Changes tab lists files and opens diffs. Git prints `/` and
   Nyra holds `\`, and the two have to meet (`lib/repoRoot.ts`).
8. **Terminal.** It opens PowerShell 7 if installed, Windows PowerShell
   otherwise. Typing, colours and resizing work.
9. **Browser panel.** The sidecar starts once and stays up, rather than
   respawning on every call. It finds an installed Chrome, and falls back to
   Playwright's Chromium.
10. **MCP.** Settings lists servers, and an `npx` stdio server connects.
11. **Flows.** A script node runs under Git Bash. With Git Bash hidden it falls
    back to `cmd` and says so.
12. **Dictation.** The CPU build of whisper transcribes. It will be slower than
    Metal, but it should work.
13. **Quit.** Nothing from Nyra is left in Task Manager: no `claude.exe`, no
    `node.exe` sidecar, no terminal shell.
14. **Release build.** `npm run build` produces an NSIS installer that installs
    per user and launches.

## Known risks

- **Command-line length.** Windows caps a command line at 32K characters, and
  the system prompt plus `--mcp-config` go in as arguments. If a spawn fails
  with a long prompt, pass them as files instead.
- **Orphans after a crash.** Unix children go when Nyra does; Windows children
  don't. A job object would fix it, but it would also kill the updater's
  installer, so it has been left out until that is solved.
- **Unported features.** "Open with" detects no editors yet (`open_with.rs`),
  and the devtools screenshot/eval route is macOS-only (`devtools.rs`).

## Releasing for Windows

This comes after the checklist passes. Today `npm run gh-release` uploads only
the `.dmg`, and `latest.json` has no `windows-x86_64` entry, so the updater
cannot serve Windows. Both have to change, along with the release flow.
Authenticode signing is separate from the macOS identity in
`~/.nyra/signing-identity`.
