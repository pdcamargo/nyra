//! Everything that differs between operating systems, behind one surface.
//!
//! The rest of the backend does not write `#[cfg(unix)]` or `#[cfg(windows)]`
//! to stop a process, find a binary or pick a shell — it calls a function here.
//! Each OS gets one file implementing the same set of items, and the `pub use`
//! below is the contract: an OS file that is missing one fails to compile on
//! that OS, which is what `cargo xwin check --target x86_64-pc-windows-msvc`
//! catches from a Mac. A new OS is a new file, not a hunt through the tree.
//!
//! What belongs here is facts about the OS: how a process is stopped, where
//! tools get installed, what a shell is called. A *feature* that is wholly
//! different per OS — native spell checking, capturing the WKWebView — keeps
//! its own single `mod imp` switch in its own file, the way `spellcheck.rs`
//! does, rather than moving in here.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

pub use imp::{
    canonical_dir, default_shell, executable_names, file_id, force_kill, is_alive, log_dir,
    login_shell_path, on_shutdown_signal, private_open_options, restrict_to_owner, terminate,
    CLAUDE_INSTALLS, FALLBACK_BINS,
};

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/// A `std::process::Command` for `program`, ready for this OS.
///
/// Every child Nyra starts goes through here. On Windows that is what keeps a
/// console window from flashing up for every `git status`, and what turns an
/// npm `.cmd` shim into the `node` call it wraps — the shim goes through
/// `cmd.exe`, which cannot carry an argument with a newline in it, and the
/// system prompt Nyra passes Claude is several paragraphs long.
pub fn std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let (program, lead) = imp::launch(program.as_ref());
    let mut cmd = std::process::Command::new(program);
    cmd.args(lead);
    imp::detach_console(&mut cmd);
    cmd
}

/// [`std_command`], as a tokio command.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    tokio::process::Command::from(std_command(program))
}

/// A PTY command for `program`: the terminal and `claude /login`. No console
/// flag here — a pseudo-console is exactly what a PTY child is meant to have.
pub fn pty_command(program: impl AsRef<OsStr>) -> portable_pty::CommandBuilder {
    let (program, lead) = imp::launch(program.as_ref());
    let mut cmd = portable_pty::CommandBuilder::new(program);
    cmd.args(lead);
    cmd
}

/// A command that runs `script` the way a flow's script node means it: in a
/// POSIX shell, where there is one.
pub fn script_command(script: &str) -> tokio::process::Command {
    tokio::process::Command::from(imp::script_command(script))
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/// Ask `pid` to stop, and make sure of it once `grace` has passed.
///
/// The polite half is SIGTERM on Unix. Windows has nothing polite to send a
/// console process, so there the first step already ends it, along with its
/// children — which, unlike on Unix, do not go with it on their own.
pub fn terminate_then_kill(pid: u32, grace: Duration) -> std::io::Result<()> {
    terminate(pid)?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(grace).await;
        if is_alive(pid) {
            force_kill(pid);
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Finding binaries
// ---------------------------------------------------------------------------

/// `which`, against the PATH Nyra resolved for its children rather than the one
/// it inherited.
pub fn which(name: &str) -> Option<PathBuf> {
    which_in(name, OsStr::new(&crate::util::child_path()))
}

/// `which` over an explicit PATH value. Honours PATHEXT on Windows, so `node`
/// finds `node.exe` and `claude` finds `claude.cmd`.
pub fn which_in(name: &str, path: &OsStr) -> Option<PathBuf> {
    let names = executable_names(name);
    std::env::split_paths(path).find_map(|dir| {
        names
            .iter()
            .map(|n| dir.join(n))
            .find(|candidate| candidate.is_file())
    })
}

/// The script an npm `.cmd` shim runs, relative to the shim's directory.
///
/// Both generations of cmd-shim end in the same shape — the script quoted
/// against the shim's own directory, then `%*` — and that is the only quoted
/// path followed by `%*`, so the `node.exe` probe above it never matches:
///
/// ```text
/// "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
/// "%~dp0\node.exe"  "%~dp0\node_modules\npm\bin\npm-cli.js" %*
/// ```
///
/// Portable on purpose: it is plain text, and testable from any OS.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_npm_shim(text: &str) -> Option<String> {
    static SCRIPT: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r#""%(?:dp0%|~dp0)\\([^"]+)"\s+%\*"#).unwrap()
    });
    let captures = SCRIPT.captures(text)?;
    let script = captures.get(1)?.as_str().trim();
    (!script.is_empty()).then(|| script.to_string())
}

/// `node <script>` for an npm shim at `shim`, when the script it names exists.
/// `node` is the one beside the shim if there is one, the way the shim picks it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn unwrap_npm_shim(shim: &Path) -> Option<(OsString, OsString)> {
    let text = std::fs::read_to_string(shim).ok()?;
    let relative = parse_npm_shim(&text)?;
    let dir = shim.parent()?;
    let script = relative
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .fold(dir.to_path_buf(), |acc, part| acc.join(part));
    if !script.is_file() {
        return None;
    }
    let local = dir.join(executable_names("node").into_iter().next()?);
    let node = if local.is_file() { local } else { which("node")? };
    Some((node.into_os_string(), script.into_os_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_script_out_of_a_current_npm_shim() {
        let shim = r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
"#;
        assert_eq!(
            parse_npm_shim(shim).as_deref(),
            Some(r"node_modules\@anthropic-ai\claude-code\cli.js")
        );
    }

    #[test]
    fn reads_the_script_out_of_an_older_npm_shim() {
        let shim = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\npm\\bin\\npm-cli.js\" %*\r\n) ELSE (\r\n  node  \"%~dp0\\node_modules\\npm\\bin\\npm-cli.js\" %*\r\n)";
        assert_eq!(
            parse_npm_shim(shim).as_deref(),
            Some(r"node_modules\npm\bin\npm-cli.js")
        );
    }

    #[test]
    fn a_batch_file_that_is_not_a_shim_is_left_alone() {
        assert_eq!(parse_npm_shim("@echo off\r\necho hello %*\r\n"), None);
    }

    #[test]
    fn which_in_finds_a_file_and_skips_a_directory() {
        let base = std::env::temp_dir().join(format!("nyra-which-{}", crate::util::rand_suffix(8)));
        let bin = base.join("bin");
        std::fs::create_dir_all(bin.join(executable_names("tool").remove(0))).unwrap();
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let file = other.join(executable_names("tool").remove(0));
        std::fs::write(&file, b"").unwrap();

        let path = std::env::join_paths([&bin, &other]).unwrap();
        assert_eq!(which_in("tool", &path), Some(file));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn our_own_process_is_alive() {
        assert!(is_alive(std::process::id()));
    }
}
