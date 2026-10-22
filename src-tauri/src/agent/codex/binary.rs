//! Finding the `codex` to run.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::{platform, util};

/// The oldest build whose app-server speaks the protocol this module was
/// written against. 0.163 is the one it was checked on.
pub const MIN_VERSION: [u64; 3] = [0, 163, 0];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub path: PathBuf,
    pub version: Option<[u64; 3]>,
}

/// `codex-cli 0.163.0` → [0, 163, 0]; a prerelease reads as its release.
/// None for anything it cannot read.
pub fn parse_version(output: &str) -> Option<[u64; 3]> {
    output.split_whitespace().find_map(|token| {
        let release = token.split(['-', '+']).next()?;
        let parts: Vec<u64> = release.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
        match parts[..] {
            [major, minor, patch] => Some([major, minor, patch]),
            _ => None,
        }
    })
}

pub fn version_label(version: [u64; 3]) -> String {
    format!("{}.{}.{}", version[0], version[1], version[2])
}

fn run_version(path: &Path) -> Option<[u64; 3]> {
    let mut child = platform::std_command(path)
        .arg("--version")
        .env_clear()
        .envs(util::clean_child_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A wedged binary must not hang a spawn.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    parse_version(&out)
}

/// The binary a launcher stands for: npm's `.cmd` is traded for the `.exe` it
/// would have spawned, when that is where it should be.
fn native(path: PathBuf) -> PathBuf {
    platform::codex_native(&path).unwrap_or(path)
}

/// Every install on this machine, with the version it reports: the installers'
/// own locations first, then whatever `PATH` finds — which is where an nvm or
/// volta install lives.
pub fn installs() -> Vec<Install> {
    let paths: Vec<PathBuf> = platform::CODEX_INSTALLS
        .iter()
        .map(|entry| PathBuf::from(util::expand_home(entry)))
        .filter(|p| p.is_file())
        .chain(platform::which("codex"))
        .map(native)
        .collect();
    let mut seen = Vec::new();
    paths
        .into_iter()
        .filter(|p| {
            let fresh = !seen.contains(p);
            seen.push(p.clone());
            fresh
        })
        .map(|path| {
            let version = run_version(&path);
            Install { path, version }
        })
        .collect()
}

/// Of these, the one to run: the newest that reports a version, else the first.
pub fn pick(installs: &[Install]) -> Option<&Install> {
    installs
        .iter()
        .filter(|i| i.version.is_some())
        .max_by_key(|i| i.version)
        .or_else(|| installs.first())
}

/// The binary to start, or why there is none. Blocking: each candidate runs
/// `--version`, so call it off the async runtime.
pub fn resolve() -> Result<Install, String> {
    let found = installs();
    let chosen = pick(&found).cloned().ok_or_else(|| {
        "Codex CLI not found. Install it with `npm install -g @openai/codex`, then sign in with `codex login`."
            .to_string()
    })?;
    if let Some(version) = chosen.version.filter(|v| *v < MIN_VERSION) {
        return Err(format!(
            "Codex {} is older than Nyra supports ({} or newer). Update it with `npm install -g @openai/codex`.",
            version_label(version),
            version_label(MIN_VERSION),
        ));
    }
    crate::logf!("Resolved codex binary: {} (of {} install(s))", chosen.path.display(), found.len());
    Ok(chosen)
}

/// A spawn should not pay `--version` on every chat. Resolved once per run;
/// an update mid-session is picked up on the next launch.
pub fn cached() -> Result<Install, String> {
    use once_cell::sync::OnceCell;
    static RESOLVED: OnceCell<Install> = OnceCell::new();
    if let Some(install) = RESOLVED.get() {
        return Ok(install.clone());
    }
    let install = resolve()?;
    Ok(RESOLVED.get_or_init(|| install).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_read_out_of_the_banner() {
        assert_eq!(parse_version("codex-cli 0.163.0"), Some([0, 163, 0]));
        assert_eq!(parse_version("codex-cli 0.164.0-alpha.12"), Some([0, 164, 0]));
        assert_eq!(parse_version("nothing here"), None);
    }

    #[test]
    fn the_newest_install_wins_and_one_without_a_version_is_the_fallback() {
        let old = Install { path: "a".into(), version: Some([0, 129, 0]) };
        let new = Install { path: "b".into(), version: Some([0, 163, 0]) };
        let mute = Install { path: "c".into(), version: None };
        assert_eq!(pick(&[old.clone(), new.clone(), mute.clone()]), Some(&new));
        assert_eq!(pick(&[mute.clone()]), Some(&mute));
        assert_eq!(pick(&[]), None);
    }
}
