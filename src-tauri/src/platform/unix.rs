//! macOS and Linux. See `mod.rs` for what each item promises.

use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::Duration;

// ---- processes ----

fn signal(pid: u32, sig: libc::c_int) -> std::io::Result<()> {
    // 0 and anything that wraps negative would signal a whole process group.
    let pid = i32::try_from(pid)
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| std::io::Error::other("invalid pid"))?;
    if unsafe { libc::kill(pid, sig) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

pub fn terminate(pid: u32) -> std::io::Result<()> {
    signal(pid, libc::SIGTERM)
}

pub fn force_kill(pid: u32) {
    let _ = signal(pid, libc::SIGKILL);
}

/// EPERM counts as alive: the process is there, it just is not ours to signal.
pub fn is_alive(pid: u32) -> bool {
    match signal(pid, 0) {
        Ok(()) => true,
        Err(e) => e.raw_os_error() == Some(libc::EPERM),
    }
}

/// Run `f` when the process is told to stop — a `kill`, a logout, a dev-loop
/// restart — rather than only when Tauri decides it is exiting.
pub fn on_shutdown_signal(f: fn()) {
    use tokio::signal::unix::{signal, SignalKind};
    for kind in [SignalKind::terminate(), SignalKind::interrupt(), SignalKind::hangup()] {
        tauri::async_runtime::spawn(async move {
            let Ok(mut stream) = signal(kind) else { return };
            stream.recv().await;
            f();
        });
    }
}

// ---- spawning ----

pub(super) fn launch(program: &OsStr) -> (OsString, Vec<OsString>) {
    (program.to_owned(), Vec::new())
}

pub(super) fn detach_console(_cmd: &mut std::process::Command) {}

pub(super) fn script_command(script: &str) -> std::process::Command {
    let mut cmd = super::std_command("sh");
    cmd.arg("-c").arg(script);
    cmd
}

/// The user's own shell. `$SHELL` is set for any login session, GUI included.
pub fn default_shell() -> (OsString, Vec<OsString>) {
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    (shell, Vec::new())
}

pub fn executable_names(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

pub fn canonical_dir(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

pub fn simplified(path: &Path) -> PathBuf {
    path.to_path_buf()
}

// ---- PATH ----

/// Long enough for an interactive rc file that does real work, short enough
/// that a wedged shell doesn't hold the first spawn hostage.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const PATH_START: &str = "__NYRA_PATH_START__";
const PATH_END: &str = "__NYRA_PATH_END__";

/// Ask the user's login shell what its PATH is.
///
/// A GUI app launched from Finder inherits launchd's PATH, which is
/// `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Sentinel-delimited because
/// an interactive shell prints whatever its rc files feel like printing, and
/// killed on timeout because the reader thread is blocked on a pipe that will
/// never close otherwise.
pub fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let script = format!("printf '%s%s%s' '{PATH_START}' \"$PATH\" '{PATH_END}'");

    let child = super::std_command(&shell)
        .args(["-ilc", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id();

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output().ok());
    });

    let output = match rx.recv_timeout(SHELL_PROBE_TIMEOUT) {
        Ok(Some(output)) => output,
        _ => {
            crate::log!("path", "login shell probe timed out or failed ({shell})");
            force_kill(pid);
            return None;
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let start = text.find(PATH_START)? + PATH_START.len();
    let rest = &text[start..];
    let end = rest.find(PATH_END)?;
    let path = rest[..end].trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Where developer tooling actually lives, for when the shell probe fails.
/// Missing directories are harmless — they just never match anything.
pub const FALLBACK_BINS: &[&str] = &[
    "~/.local/bin",
    "~/.local/share/fnm/aliases/default/bin",
    "~/.fnm/aliases/default/bin",
    "~/.volta/bin",
    "~/.bun/bin",
    "~/.cargo/bin",
    "~/.npm-global/bin",
    "~/Library/pnpm",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

/// Where the Claude CLI's installers put it: the native installer, a global
/// npm prefix, then Homebrew on either architecture.
pub const CLAUDE_INSTALLS: &[&str] = &[
    "~/.local/bin/claude",
    "~/.npm-global/bin/claude",
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
];

// ---- files ----

/// Owner-only from the moment the file exists. Only bites on create.
pub fn private_open_options(opts: &mut OpenOptions) -> &mut OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    opts.mode(0o600)
}

/// Owner-only after the fact, for a file or directory an older build made wider.
pub fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

pub fn file_id(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

/// `/tmp` rather than `$TMPDIR`, which on macOS is a per-user directory under
/// `/var/folders` that nobody can find — and `scripts/log-gaps.mjs` looks here.
pub fn log_dir() -> PathBuf {
    PathBuf::from("/tmp")
}
