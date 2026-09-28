# WSL projects

Windows Nyra working on a project that lives inside WSL, the way VS Code's
Remote-WSL does it: the code, `git`, `claude` and the terminal stay in the
distro, and Nyra stays a native Windows app. Built and tested against WSL2
`Ubuntu` on Windows 11 (zsh login shell, `claude` 2.1.216 from the native
installer). What still needs a person in front of the app is the checklist at
the end.

Running the *Linux build* of Nyra inside WSLg is a different thing, and none of
this needs it.

## The shape: an environment per project

`platform/` is chosen at compile time: a Windows binary is always Windows. WSL is
chosen at runtime, per project, and one Nyra can have a Windows project and a WSL
project open side by side. So it is not in `platform/`. It is a second layer
beside it, `src-tauri/src/environment/`:

```rust
pub enum Environment {
    Host,
    Wsl { distro: String, share: wsl::Share },
}

impl Environment {
    pub fn of(cwd: &str) -> Environment;                        // \\wsl.localhost\… or \\wsl$\… → Wsl
    pub fn command(&self, program: &str, cwd: &str) -> tokio::process::Command;
    pub fn std_command(&self, program: &str, cwd: &str) -> std::process::Command;
    pub fn shell_command(&self, cwd: &str) -> portable_pty::CommandBuilder;   // the terminal
    pub fn to_host(&self, path: &str) -> PathBuf;               // a path it printed → one Nyra opens
    pub fn to_env(&self, host: &Path) -> String;                // and back
    pub fn cwd_in_env(&self, cwd: &str) -> String;
    pub fn home(&self) -> PathBuf;                              // where its ~/.claude is, as a host path
    pub fn own_claude(&self) -> Result<Option<String>, String>; // the distro's claude, never Settings'
    pub fn reaches_host_loopback(&self) -> bool;                // can it reach Nyra's MCP servers
    pub fn is_within(&self, root: &Path, path: &Path) -> bool;
}
```

`Host` is exactly what the code did before: `platform::command` in `cwd`,
`util::home_dir`, paths as given, the inline `--append-system-prompt`. A Windows
or macOS project that is not in WSL runs byte-for-byte as it did. The rule that
holds it together: **anything that spawns in, or takes a path from, a project's
directory goes through that project's `Environment`**. Only `environment/` knows
`wsl.exe` exists.

`environment_info(cwd)` tells the renderer what it needs: `{ kind, distro,
reachable, claudeFound, mirroredNetworking }`. Asking about a distro also warms
its probe.

### A command in the distro

```text
wsl.exe -d <distro> --cd <linux cwd> --exec env PATH=<probe PATH> <program> <args…>
```

`--exec` hands argv straight to the Linux process, with no shell in between.
**A multi-line argument crosses it byte for byte**, as do quotes, `$`, backticks,
backslashes, a trailing `\`, an empty argument and a 20,000-byte argument, all
verified with Rust's own quoting. So a WSL chat gets its system prompt and MCP
config inline, on the same argv shape as the host. The design this replaced
wrote them to files under the distro's `/tmp`, on the belief that `wsl.exe`
mangled multi-line arguments. That is true without `--exec`, where `wsl.exe`
joins argv into a shell string, and false with it. The one limit left is
Windows' 32K command line, which the host already has.

Nothing of Nyra's environment is forwarded into the distro. Only what `WSLENV`
names would cross anyway, and Claude should see the distro's own. PATH is the
exception, and that is the probe's job.

### The probe

Once per distro, cached: `$HOME`, `$PATH` and `claude`, asked of the user's own
shell as **`-ilc`**, interactive and login. PATH and nvm usually live in
`.zshrc`, which a login shell alone never reads, and `--exec` reads no rc files
at all.

- `claude` is found by walking PATH, skipping every `/mnt/*` entry, then the
  `~/.local/bin` and `~/.claude/local` fallbacks. WSL appends the Windows PATH
  inside the distro, so a `claude` under `/mnt/` is a Windows one (an npm shim,
  or a dev build's), and it would run with the Windows `~/.claude`. `command -v`
  is not used, because in an interactive shell it answers an alias with its
  definition. `parse_probe` rejects `/mnt/` and non-absolute answers as a
  backstop.
- The record ends in a record separator (`\x1e`), not a newline. A Windows PATH
  entry can contain a newline (one on the build machine does), and a line-based
  read lost every field after `$PATH`.
- One probe at a time. Opening a project fires several git calls at once, and
  they would otherwise each start their own. A failure is remembered for 30s,
  so a wedged distro does not cost every caller the 20s timeout.
- It blocks: about a second warm, a few cold. `environment_info` is asked as soon
  as a WSL chat is shown, which gets it out of the way.

Real-distro test: `cargo test -- --ignored wsl`, with `NYRA_TEST_DISTRO`
(default `Ubuntu`). It asserts that `claude` is found and is not under `/mnt/`.

## Paths: one fixture, two directions, split by side

| From | To |
|---|---|
| `\\wsl.localhost\Ubuntu\home\me\repo` (or `\\wsl$\…`) | `/home/me/repo` |
| `/mnt/c/Users/me/x.png` | `C:\Users\me\x.png` |
| `/home/me/repo/src/a.ts` | `\\wsl.localhost\Ubuntu\home\me\repo\src\a.ts` |
| `C:\Users\me\AppData\Local\Temp\nyra-files-123\a.png` | `/mnt/c/Users/me/AppData/Local/Temp/nyra-files-123/a.png` |

- **Rust** has both directions, in `environment/wsl.rs` (`parse_unc`, `to_linux`,
  `to_windows`), behind `Environment::to_host` / `to_env`.
- **The renderer** has one: WSL path → host path, in `lib/environment.ts`
  (`wslShare`, `toHostPath`). It is not in `paths.ts`, which stays about path
  syntax; which distro a chat is in is environment knowledge. `resolvePath`
  calls it first, so tab de-dupe, `isWithin`, the file tree and the Changes tab
  all see host-form paths.
- **Both run `src/shared/wsl-paths.json`.** Rust loads it with `include_str!` and
  runs `detect`, `toHost` and `toEnv`. The renderer runs `detect` and `toHost`.
  A new case goes in the fixture, never into one side's tests.
- A path handed back keeps the cwd's share spelling (`\\wsl$\` stays `\\wsl$\`),
  because the renderer compares paths as strings against the project's own.
- `/mnt` as the automount root is an assumption on both sides: no `wslpath`, no
  `wsl.conf`. `/mnt/wsl` is WSL's own, not a drive. A UNC path written with
  forward slashes (`//wsl.localhost/…`) is already a host path, not a Linux one.
- Windows' 8.3 temp path (`C:\Users\ADMINI~1\…`) resolves from inside the distro
  as `/mnt/c/Users/ADMINI~1/…`, so the attachment dirs need no long-name lookup.

## What goes through it

**Claude** (`claude.rs`). `spawn_session` runs `own_claude()` through
`Environment::command`. With no `claude` in the distro the turn fails with an
error that says so. The system prompt states the **Linux** cwd. The spawn
fingerprint is unchanged. Staged attachments are named by host path in the
prompt; `run_claude` and `steer_session` swap the `IMAGES_DIR` / `FILES_DIR`
prefixes for their `/mnt/c/…` form. Every path Claude prints goes through
`to_host` before Nyra touches it: Edit/Write original-content capture and
revert, plan files, subagent transcripts, background-shell output files.

**Stop** is the stdin interrupt, which crosses `wsl.exe`'s pipes unchanged.

**Dispose** is unchanged: `terminate_then_kill` on the `wsl.exe` pid. Measured:

```text
wsl.exe -d Ubuntu --exec sleep 30x, then taskkill /PID <wsl.exe pid>
  /T /F, detached:        sleep gone
  /F without /T:          sleep gone
  /T /F, piped stdio:     sleep gone
  closing stdin only:     EOF reaches the Linux process, which exits
sh -c 'sleep A & sleep B </dev/null & setsid sleep C & sleep D', then /T /F:
  A, B, D gone; C (setsid, its own session) survives
```

Killing `wsl.exe` ends everything in its Linux session, which is what a `claude`
and the MCP servers and tool shells it starts are. Only a process that detaches
itself with `setsid` outlives it, as it would on native Unix. So dispose needs no
close-stdin-first step. `claude::tests::wsl_real_distro_runs_the_session_argv_and_dies_with_its_pid`
spawns the real CLI with Nyra's argv, gets its `initialize` answer, terminates
the `wsl.exe` pid and checks nothing is left in the distro.

**Path-only file commands** (`fs_read_text_file`, `fs_stat_file`,
`fs_read_image`, `fs_read_file`, `fs_revert_file`, `fs_reveal`, `fs_open_with`,
`subagent_transcript`) take an optional `cwd` and resolve through it. A host path
passes through unchanged. `fs_read_image` used to refuse `/tmp/x.png` on Windows
as not absolute; with a WSL cwd it becomes the share path and reads.

**The distro's `~/.claude`.** `Environment::home()`, with the **Linux** cwd
flattened (`-home-me-dev-repo`), in `util::claude_project_dir`, `memory.rs`
(including `is_path_allowed`), `ai_title.rs`, `hooks.rs` (global scope),
`skills.rs` (global skills, agents and commands), and `mcp.rs`: `discover` and
`set_enabled` read the distro's `~/.claude.json`, whose `projects` are keyed by
the Linux cwd, and `health` runs `claude mcp list` inside the distro.

**Git** (`git.rs`, `file_tree.rs`, the `@` file list in `fs_ops.rs`) runs inside
the distro. Windows git against the share is slow, and refuses the repo outright
as "dubious ownership" because the files belong to the Linux user. What git
prints (`rev-parse --show-toplevel`, `worktree list`) goes through `to_host`.
What Nyra hands it (worktree destinations, seed and snapshot patch and bundle
files, the `worktree remove` argument) goes through `to_env`. Managed worktrees
for a WSL project live under the distro's `~/.nyra/worktrees`, on its own
filesystem. Snapshots stay in the host's `~/.nyra/worktree-snapshots`, and git
reads them through `/mnt/c`.

What one git call costs through `wsl.exe`, warm, against the same call on
Windows:

| | median |
|---|---|
| native Windows `git` | ~21ms |
| `wsl.exe --exec git`, first run | ~42ms (41–49ms) |
| the same, later, under load | ~77ms |
| through `git::branch` (Nyra's path, `env PATH=…` included), debug build | ~85ms |
| readdir + stat of a 53-entry directory over the share | ~16ms |

Nearly all of it is `wsl.exe` starting, and it varies with machine load. The
`env PATH=<probe>` wrapper adds about 3ms. The file tree runs one `check-ignore`
per folder opened, so a folder costs one of these. That is not batched yet. The
Changes tab runs four or five in sequence, and is where to look first if a WSL
project feels slow.

**The terminal** is `wsl.exe -d <distro> --cd <linux cwd>`, with no `--exec`:
WSL starting the user's login shell. `kill_terminal`'s `child.kill()` leaves
neither the shell nor its foreground job behind, and
`environment::tests::wsl_real_distro_terminal_shell_dies_with_its_pty` checks it.
ConPTY opens with a cursor-position query (`ESC[6n`) that it waits on; xterm.js
answers it in the app.

## MCP networking

`nyra-browser` and `nyra-app` are served at `127.0.0.1:<port>` on Windows. Under
WSL2's default NAT networking, loopback inside the distro is the distro's own.

Decided: **require mirrored networking.** In mirrored mode (Windows 11 22H2+,
`networkingMode=mirrored` under `[wsl2]` in `%USERPROFILE%\.wslconfig`) the
distro shares the host's loopback, so nothing changes: same URL, same
loopback-only listener. Without it, `build_spawn_args` leaves both servers off
for a WSL chat, and says nothing about them in the system prompt, and the chat
shows a notice with the fix. `.wslconfig` is re-read at each spawn, so after
turning it on and running `wsl --shutdown`, the next chat has the tools.

The alternative, a second listener on the `vEthernet (WSL)` adapter, would make
`app/mcp` reachable from anything that can reach that adapter, with only the
`x-nyra-token` check in front of it. It can come later, behind a setting, if
people hit this.

## In the UI

- A `WSL · Ubuntu` badge after the project name in the sidebar, a "Runs in WSL ·
  Ubuntu" line in the project menu, and the composer's "Local" reads
  `WSL · Ubuntu`.
- Notices above a WSL chat, from `environment_info`: the distro did not answer;
  Claude Code isn't installed in it; or, with browser or app tools switched on,
  that they are off without mirrored networking.
- `createProject` de-dupes with `samePath`, so `\\wsl.localhost\Ubuntu\x` and
  `//WSL.LOCALHOST/ubuntu/x/` are one project. On every OS this also folds a
  trailing separator.

## Left out of the first version

- **Background-shell tracking** (`processes.rs`). Its pids are Linux pids, and
  `pgrep`/`ps`/`lsof` would have to run inside the distro. Rows still appear,
  because they come from the CLI's own events. Stop and ports do not work, which
  is also where a native Windows chat is today.
- **Flow file triggers.** `notify` on Windows gets no events across the share. A
  file-watch trigger whose directory is in a distro says so on its card. A
  watcher inside the distro (`inotifywait`) is the eventual fix.
- **"Open with" an editor** hands the editor the share path. VS Code copes,
  crudely. `code --remote wsl+<distro> <path>` is the one to add.
- **Login, plugins, account status and the model catalog** stay host-global: they
  describe the Windows CLI. The distro's CLI keeps its own login in its own
  `~/.claude`.
- **Host-side `--append-system-prompt-file`**, the fix for the 32K command line.
  WSL no longer needs it (see above); the host still has the limit.

Found while building, and not done either:

- **Flow script nodes** run `platform::script_command` (Git Bash) in the flow's
  cwd, including a WSL one. Flow *Claude* nodes go through `run_claude` and do
  run in the distro.
- **`mcp_inspect`** runs Nyra's node inspector on the host, so a stdio server of
  a WSL project is started on Windows.
- **Nyra's bundled skills** are synced into the host's `~/.claude/skills` only.
- **Only PATH comes from the user's shell.** Anything else `.zshrc` exports (an
  API key, a proxy) does not reach a WSL chat's `claude`. Its login lives in
  `~/.claude`, so the CLI itself works.

## Test checklist

Run this on the Windows machine with a project in WSL, with mirrored networking
on:

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
