//! Windows. See `mod.rs` for what each item promises.

use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

/// `CREATE_NO_WINDOW`. Nyra is a GUI-subsystem app with no console of its own,
/// so without this Windows gives every console child a fresh window of its own
/// — a black box flashing up for each `git status` the file tree runs.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---- processes ----

/// The whole tree, forcefully. There is no SIGTERM for a console process:
/// taskkill without `/F` asks a *window* to close, and Claude, node and git have
/// none, so it just fails. `/T` because a child outlives its parent here — kill
/// only `claude.exe` and every MCP server it started keeps running.
pub fn terminate(pid: u32) -> std::io::Result<()> {
    if pid == 0 {
        return Err(std::io::Error::other("invalid pid"));
    }
    let status = super::std_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() || !is_alive(pid) {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("taskkill failed ({status})")))
    }
}

pub fn force_kill(pid: u32) {
    let _ = terminate(pid);
}

/// Access denied counts as alive: the process is there, it just is not ours.
pub fn is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code: u32 = 0;
        let read = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        read && code == STILL_ACTIVE as u32
    }
}

/// Console control events. A GUI app only receives these when it has a
/// console — under `tauri dev` — so in a packaged build this is quiet, and
/// quitting goes through Tauri's own exit path.
pub fn on_shutdown_signal(f: fn()) {
    use tokio::signal::windows;
    tauri::async_runtime::spawn(async move {
        let (Ok(mut c), Ok(mut close), Ok(mut shutdown)) =
            (windows::ctrl_c(), windows::ctrl_close(), windows::ctrl_shutdown())
        else {
            return;
        };
        tokio::select! {
            _ = c.recv() => {}
            _ = close.recv() => {}
            _ = shutdown.recv() => {}
        }
        f();
    });
}

// ---- spawning ----

pub(super) fn launch(program: &OsStr) -> (OsString, Vec<OsString>) {
    let path = Path::new(program);
    let is_cmd = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"));
    if is_cmd {
        if let Some((node, script)) = super::unwrap_npm_shim(path) {
            return (node, vec![script]);
        }
    }
    (program.to_owned(), Vec::new())
}

pub(super) fn detach_console(cmd: &mut std::process::Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Git for Windows' `bash`, which Claude Code itself requires on Windows, so it
/// is nearly always there. Never the `bash` PATH finds first: that is usually
/// `System32\bash.exe`, the WSL launcher, which runs the script in a different
/// machine. `cmd` is the fallback, and a script written for `sh` will say so.
pub(super) fn script_command(script: &str) -> std::process::Command {
    match git_bash() {
        Some(bash) => {
            let mut cmd = super::std_command(bash);
            cmd.arg("-c").arg(script);
            cmd
        }
        None => {
            let mut cmd = super::std_command("cmd.exe");
            // Raw: cmd does not read the `\"` escaping Rust would apply, and
            // `/S` strips exactly the one pair of quotes around the rest.
            cmd.args(["/D", "/S", "/C"]).raw_arg(format!("\"{script}\""));
            cmd
        }
    }
}

fn git_bash() -> Option<PathBuf> {
    let env_dir = |key: &str, rest: &str| std::env::var_os(key).map(|d| PathBuf::from(d).join(rest));
    let mut candidates: Vec<PathBuf> = Vec::new();
    // The override Claude Code reads, so one setting serves both.
    candidates.extend(std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from));
    candidates.extend(env_dir("ProgramFiles", r"Git\bin\bash.exe"));
    candidates.extend(env_dir("ProgramFiles(x86)", r"Git\bin\bash.exe"));
    candidates.extend(env_dir("LOCALAPPDATA", r"Programs\Git\bin\bash.exe"));
    // `...\Git\cmd\git.exe` → `...\Git\bin\bash.exe`, for an install elsewhere.
    candidates.extend(
        super::which("git")
            .and_then(|git| git.parent()?.parent().map(|root| root.join(r"bin\bash.exe"))),
    );
    candidates.into_iter().find(|p| p.is_file())
}

/// PowerShell 7 if it is installed, Windows PowerShell otherwise.
pub fn default_shell() -> (OsString, Vec<OsString>) {
    let shell = super::which("pwsh")
        .or_else(|| super::which("powershell"))
        .map(PathBuf::into_os_string)
        .or_else(|| std::env::var_os("COMSPEC"))
        .unwrap_or_else(|| "cmd.exe".into());
    let is_powershell = Path::new(&shell)
        .file_stem()
        .is_some_and(|s| s.eq_ignore_ascii_case("pwsh") || s.eq_ignore_ascii_case("powershell"));
    let args = if is_powershell { vec!["-NoLogo".into()] } else { Vec::new() };
    (shell, args)
}

/// `node` → `node.COM`, `node.EXE`, … in PATHEXT order; a name that already
/// has an extension is taken as given.
pub fn executable_names(name: &str) -> Vec<String> {
    if Path::new(name).extension().is_some() {
        return vec![name.to_string()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    pathext
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(|ext| format!("{name}{}", ext.to_ascii_lowercase()))
        .collect()
}

/// Without the `\\?\` prefix `fs::canonicalize` adds, which node, cmd and half
/// of everything else on the PATH do not understand.
pub fn canonical_dir(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

/// `\\?\C:\…` → `C:\…`, when that names the same file. Tauri hands back
/// verbatim paths for its own directories, and Node cannot load an ES module
/// from one — the browser sidecar died on start, and every browser tool call
/// came back a 500. Any path of ours that a child is given goes through this.
pub fn simplified(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

// ---- PATH ----

/// None: a Windows GUI app is started with the full user and system PATH out
/// of the registry, so there is no login shell to ask and nothing missing.
pub fn login_shell_path() -> Option<String> {
    None
}

/// Where developer tooling lives when it did not make it onto PATH.
pub const FALLBACK_BINS: &[&str] = &[
    "~/.local/bin",
    "~/AppData/Roaming/npm",
    "~/.bun/bin",
    "~/.cargo/bin",
    "~/.volta/bin",
    "~/scoop/shims",
    r"C:\Program Files\nodejs",
    r"C:\Program Files\Git\cmd",
    r"C:\Program Files\GitHub CLI",
];

/// The native installer, then a global npm install.
pub const CLAUDE_INSTALLS: &[&str] = &[
    "~/.local/bin/claude.exe",
    "~/AppData/Roaming/npm/claude.cmd",
];

// ---- files ----

/// Nothing to add: `%TEMP%` is under the user's own profile, whose ACL already
/// keeps other users out.
pub fn private_open_options(opts: &mut OpenOptions) -> &mut OpenOptions {
    opts
}

pub fn restrict_to_owner(_path: &Path) {}

/// Zero, which callers read as "unknown": the stable file index is behind an
/// unstable std API, and a handle-based lookup is not worth it for a cache key.
pub fn file_id(_meta: &std::fs::Metadata) -> u64 {
    0
}

pub fn log_dir() -> PathBuf {
    std::env::temp_dir()
}
