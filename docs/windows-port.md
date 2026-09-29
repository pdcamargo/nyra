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

## Desktop control

Claude operating other apps (`src-tauri/src/desktop/`) runs on macOS. On
Windows, `desktop/windows.rs` is a stub: it compiles, satisfies the `Backend`
trait, and answers "not supported yet" from every primitive. Filling it in has
to happen on a real machine. Everything above the trait — refs, pruning, the
allowlist, the blocklist, password fields, the typing guard, Esc, the
`confirmed: true` gate, screenshots' coordinate scale — is OS-neutral, already
tested against `fake.rs`, and should not need to change. If it seems to, the
contract is wrong; fix it in `mod.rs` and in `macos.rs` too.

### How each primitive maps

| Primitive | Windows |
|---|---|
| `list_apps` | `EnumWindows`, top-level visible windows grouped by process. `AppId` is the executable's full path; `app_matches` compares the file name, case-insensitively. |
| `find_app`, `open` | App Paths in the registry and Start-menu shortcuts for a name; `ShellExecuteExW` to open an app, a path or a URL. |
| `list_windows` | The app's top-level windows. `WindowKey` is the HWND. Set `blocked` when the owning process runs at a higher integrity level than Nyra (`OpenProcess` + `TokenIntegrityLevel`): UIPI silently drops input and patterns sent to it, so this must be a refusal, never a no-op. |
| `element_tree`, `menu_bar` | UI Automation, a `CacheRequest` over the ControlView walker, honouring `Limits`. `IsOffscreen` fills `offscreen`, `IsPassword` fills `secure`, `BoundingRectangle` the frame. Skip window furniture (scroll bars, thumbs, grips) the way `macos.rs` skips `FURNITURE`. |
| `perform` | Press: Invoke, then Toggle, SelectionItem, ExpandCollapse. None of them → `Unsupported`, and the engine clicks the centre. Focus: `SetFocus`. SetValue: ValuePattern. |
| `type_text` | UIA cannot insert at a caret: Focus, then `SendInput` with `KEYEVENTF_UNICODE`. Needs the window in front → `Raised(true)`. |
| `press_keys`, `click_at` | Bring the window forward, then `SendInput`. `mod_is_cmd` is false, so `mod+s` is Ctrl+S. |
| `capture_window` | Windows.Graphics.Capture for the HWND (or `PrintWindow` as a fallback), scaled to the width asked for. |
| `app_icon` | `SHGetFileInfoW` / `ExtractIconExW` on the executable, as a PNG. |
| `permissions` | `[]`: nothing to grant. Elevation is per window, in `list_windows`. |
| `seconds_since_user_input` | `GetLastInputInfo`. It counts Nyra's own `SendInput` too; the engine already discounts that. |

### Known risks

- **Foreground lock.** Windows limits which process may call
  `SetForegroundWindow`. Typing, keys and clicks all need the target in front.
  If it fails, try UIA `SetFocus` on the window, or the
  `AttachThreadInput` technique, and report `Raised` honestly.
- **Threading.** UIA wants a COM apartment. Give it one dedicated MTA thread
  and send every primitive to it, rather than initialising COM on whatever
  `spawn_blocking` thread turns up.
- **Capture.** Windows.Graphics.Capture draws a yellow border on Windows 10,
  and some windows (DRM, some GPU apps) come back black.
- **Global Esc.** `RegisterHotKey` for a bare Escape fails if another app holds
  it. `indicator.rs` logs that; the tray's Stop still works.

### Checklist

Run `cargo test --lib drives_notepad_end_to_end -- --ignored --nocapture` in
`src-tauri`. It is the finish line: it opens Notepad, types, reads the line
back, and checks the refusals. Then, in the running app with "Let Claude use
other apps" on, in a new chat:

1. **Notepad.** Ask Claude to open Notepad, type a line, and read it back. The
   allow prompt appears first; the chip over the composer and the tray icon
   say "Claude is using Notepad" and go away when the turn ends.
2. **Elevated window.** Open Task Manager as administrator. `desktop_apps`
   shows its window as blocked, and acting on it is refused with a reason.
3. **Blocked apps.** Settings, Windows Security, Windows Terminal and
   Credential Manager (Control Panel) are refused, and "always" cannot allow
   them.
4. **Password field.** Typing into a password box is refused.
5. **Esc.** Ask for a long paragraph to be typed; press Esc in Notepad. Typing
   stops, and every desktop call is refused until you send a new message.
6. **Send gate.** In an app with a Send button, pressing it without
   `confirmed: true` is refused.
7. **Screenshot.** `desktop_screenshot` returns the window, and the miniature
   over the chat shows it with the app's icon.
8. **No console windows.** Nothing flashes up during any of this.

## Releasing for Windows

This comes after the checklist passes. Today `npm run gh-release` uploads only
the `.dmg`, and `latest.json` has no `windows-x86_64` entry, so the updater
cannot serve Windows. Both have to change, along with the release flow.
Authenticode signing is separate from the macOS identity in
`~/.nyra/signing-identity`.
