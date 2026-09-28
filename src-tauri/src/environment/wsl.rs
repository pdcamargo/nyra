//! WSL: reading its paths, and asking a distro about itself.
//!
//! The translation half is pure string work, so it is tested on every OS. The
//! probe half runs `wsl.exe`, which only exists on Windows; on anything else it
//! simply fails and the callers fall back.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// How the share was spelled. Kept so a path handed back reads the way the
/// project's own directory does: the renderer compares them as strings, and
/// `\\wsl$\Ubuntu\repo` does not contain `\\wsl.localhost\Ubuntu\repo\a.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Share {
    /// `\\wsl.localhost\` — what Windows 11's folder dialog hands back.
    Localhost,
    /// `\\wsl$\` — the older name, still served.
    Dollar,
}

impl Share {
    pub fn prefix(self) -> &'static str {
        match self {
            Share::Localhost => r"\\wsl.localhost\",
            Share::Dollar => r"\\wsl$\",
        }
    }
}

/// `\\wsl.localhost\Ubuntu\home\me` → (Localhost, "Ubuntu", "/home/me").
///
/// Either slash, any case for the host part, and `\\?\UNC\` in front, which is
/// how a canonicalised share path comes back.
pub fn parse_unc(path: &str) -> Option<(Share, String, String)> {
    let normalized = path.replace('/', "\\");
    let rest = normalized
        .strip_prefix(r"\\?\UNC\")
        .or_else(|| normalized.strip_prefix(r"\\"))?;
    let (host, rest) = rest.split_once('\\').unwrap_or((rest, ""));
    let share = if host.eq_ignore_ascii_case("wsl.localhost") {
        Share::Localhost
    } else if host.eq_ignore_ascii_case("wsl$") {
        Share::Dollar
    } else {
        return None;
    };
    let (distro, inner) = rest.split_once('\\').unwrap_or((rest, ""));
    if distro.is_empty() {
        return None;
    }
    let inner = inner.trim_end_matches('\\');
    Some((share, distro.to_string(), format!("/{}", inner.replace('\\', "/"))))
}

/// A path Windows can open, as the distro names it.
///
/// Its own share → the Linux path. A drive → `/mnt/<letter>`, WSL's default
/// automount root. Anything else — another distro, a network share — has no
/// name inside this one and is handed back unchanged, so the failure is the
/// CLI's "no such file" rather than a wrong file.
pub fn to_linux(distro: &str, host: &str) -> String {
    let host = host.strip_prefix(r"\\?\").filter(|rest| !rest.starts_with("UNC\\")).unwrap_or(host);
    if let Some((_, d, linux)) = parse_unc(host) {
        return if d.eq_ignore_ascii_case(distro) { linux } else { host.to_string() };
    }
    let bytes = host.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = host[2..].replace('\\', "/");
        let rest = rest.trim_start_matches('/').trim_end_matches('/');
        let drive = (bytes[0] as char).to_ascii_lowercase();
        return if rest.is_empty() {
            format!("/mnt/{drive}")
        } else {
            format!("/mnt/{drive}/{rest}")
        };
    }
    host.replace('\\', "/")
}

/// A path the distro printed, as one Windows can open. The inverse of
/// [`to_linux`]; a relative path, or one that is already a Windows path, is
/// left alone.
pub fn to_windows(share: Share, distro: &str, linux: &str) -> PathBuf {
    // `//server/share` is a UNC path written with forward slashes — already a
    // Windows path — not a Linux one.
    if !linux.starts_with('/') || linux.starts_with("//") {
        return PathBuf::from(linux);
    }
    if let Some(rest) = linux.strip_prefix("/mnt/") {
        let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
        if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
            let letter = drive.to_ascii_uppercase();
            return PathBuf::from(format!(r"{letter}:\{}", tail.replace('/', "\\")));
        }
    }
    let inner = linux.trim_start_matches('/').replace('/', "\\");
    PathBuf::from(format!("{}{distro}\\{inner}", share.prefix()))
}

/// Whether `%USERPROFILE%\.wslconfig` turns mirrored networking on — the one
/// mode in which the distro's loopback is the host's, so Nyra's MCP servers at
/// `127.0.0.1` are reachable from inside it. Keys are case-insensitive, and
/// only the `[wsl2]` section counts.
pub fn parse_mirrored(wslconfig: &str) -> bool {
    let mut in_wsl2 = false;
    for line in wslconfig.lines() {
        let line = line.split(['#', ';']).next().unwrap_or("").trim();
        if line.starts_with('[') {
            in_wsl2 = line.eq_ignore_ascii_case("[wsl2]");
            continue;
        }
        if !in_wsl2 {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("networkingMode") {
                return value.trim().trim_matches('"').eq_ignore_ascii_case("mirrored");
            }
        }
    }
    false
}

pub fn mirrored_networking() -> bool {
    let path = crate::util::home_dir().join(".wslconfig");
    std::fs::read_to_string(path).is_ok_and(|text| parse_mirrored(&text))
}

// ---------------------------------------------------------------------------
// Probing a distro
// ---------------------------------------------------------------------------

/// What a distro's login shell says about it. Asked once per distro: each
/// answer costs a `wsl.exe` start and a login shell, and none of them change
/// while Nyra runs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Probe {
    /// `$HOME`, as a Linux path.
    pub home: String,
    /// `$PATH` as a login shell has it. `--exec` reads no rc files, so without
    /// this `claude` gets WSL's bare default and cannot find `node` for an
    /// `npx` MCP server.
    pub path: String,
    /// `command -v claude`, or empty.
    pub claude: String,
}

/// Between the marker and the record separator: fields split by the unit
/// separator. A login shell may print a banner first, so everything before
/// the last marker is ignored.
///
/// Not the end of the line: WSL appends the Windows PATH, and a Windows PATH
/// entry can hold a newline — one on the machine this was built on does — so
/// a line-based read lost every field after `$PATH`.
const MARKER: &str = "NYRA-PROBE\u{1f}";
const END: char = '\u{1e}';

pub fn parse_probe(stdout: &str) -> Option<Probe> {
    let at = stdout.rfind(MARKER)?;
    let rest = &stdout[at + MARKER.len()..];
    let record = rest.split_once(END).map_or(rest, |(record, _)| record);
    let mut fields = record.split('\u{1f}').map(str::trim);
    let home = fields.next().unwrap_or_default().to_string();
    if !home.starts_with('/') {
        return None;
    }
    let path = fields.next().unwrap_or_default().to_string();
    // The script already skips these; this is the backstop. WSL appends the
    // Windows PATH inside the distro, so a `claude` under `/mnt/` is a Windows
    // one — an npm shim, or a dev build's — reached through interop, with the
    // Windows `~/.claude` and none of the distro's. Never that.
    let claude = fields.next().unwrap_or_default().to_string();
    let claude = if claude.starts_with('/') && !claude.starts_with("/mnt/") { claude } else { String::new() };
    Some(Probe { home, path, claude })
}

/// The user's own shell, interactive *and* login, so a PATH set in `.zshrc`
/// counts as well as one set in `.zprofile` — nvm and `~/.local/bin` are
/// usually in the former, which a login shell alone never reads. `sh` is the
/// floor.
///
/// `claude` is looked for along PATH rather than with `command -v`, which in
/// an interactive shell answers an alias with its definition, and which would
/// stop at the first match even when that is a Windows one under `/mnt/`. The
/// two fallbacks are where the native installer and the old local install put
/// it when the profile never added them to PATH.
const PROBE_SCRIPT: &str = concat!(
    "exec ${SHELL:-/bin/sh} -ilc '",
    "c=$(printf %s \"$PATH\" | tr : \"\\n\" | while IFS= read -r d; do ",
    "case $d in /mnt/*|\"\") continue;; esac; ",
    "if [ -f \"$d/claude\" ] && [ -x \"$d/claude\" ]; then printf %s \"$d/claude\"; break; fi; ",
    "done); ",
    "[ -z \"$c\" ] && [ -x \"$HOME/.local/bin/claude\" ] && c=$HOME/.local/bin/claude; ",
    "[ -z \"$c\" ] && [ -x \"$HOME/.claude/local/claude\" ] && c=$HOME/.claude/local/claude; ",
    "printf \"\\nNYRA-PROBE\\037%s\\037%s\\037%s\\036\\n\" \"$HOME\" \"$PATH\" \"$c\"'"
);

static PROBES: Lazy<Mutex<HashMap<String, Probe>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// When each distro last failed to answer. A wedged distro takes the full
/// timeout to fail, and every git call in a project would otherwise pay it in
/// turn.
static FAILED: Lazy<Mutex<HashMap<String, Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));
const RETRY_AFTER: Duration = Duration::from_secs(30);

/// One probe at a time. Opening a project fires several git calls at once, and
/// each of them asking would be as many `wsl.exe` starts and interactive
/// shells for the one answer. The second caller waits and then reads the cache.
static PROBING: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// The distro's answers, from the cache or by asking. None when the distro
/// would not answer — not installed, or failing to start. That is remembered
/// for a short while only, so a distro that was starting cold is asked again.
///
/// Blocking: the first ask costs a `wsl.exe` start and an interactive shell,
/// about a second warm and a few cold. `environment::info`, which the renderer
/// asks as soon as it shows a WSL project, gets that out of the way early.
pub fn probe(distro: &str) -> Option<Probe> {
    let cached = || -> Option<Option<Probe>> {
        if let Some(found) = PROBES.lock().get(distro) {
            return Some(Some(found.clone()));
        }
        match FAILED.lock().get(distro) {
            Some(at) if at.elapsed() < RETRY_AFTER => Some(None),
            _ => None,
        }
    };
    if let Some(answer) = cached() {
        return answer;
    }
    let _one_at_a_time = PROBING.lock();
    if let Some(answer) = cached() {
        return answer;
    }
    let started = Instant::now();
    let found = run_probe(distro);
    match &found {
        Some(p) => {
            crate::log!(
                "wsl",
                "probed {distro} in {}ms: home={} claude={}",
                started.elapsed().as_millis(),
                p.home,
                if p.claude.is_empty() { "(none)" } else { &p.claude }
            );
            FAILED.lock().remove(distro);
            PROBES.lock().insert(distro.to_string(), p.clone());
        }
        None => {
            crate::log!("wsl", "probe of {distro} failed");
            FAILED.lock().insert(distro.to_string(), Instant::now());
        }
    }
    found
}

fn run_probe(distro: &str) -> Option<Probe> {
    let mut child = crate::platform::std_command("wsl.exe")
        .args(["-d", distro, "--cd", "~", "--exec", "sh", "-c", PROBE_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A distro that is starting cold takes a few seconds; one that is wedged
    // must not hang whoever asked.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    parse_probe(&out)
}

/// Test seam: answer for a distro without running `wsl.exe`.
#[cfg(test)]
pub fn set_probe_for_test(distro: &str, probe: Probe) {
    PROBES.lock().insert(distro.to_string(), probe);
}

/// Whether a path is inside a directory, comparing the way the share does:
/// case-insensitively, either slash.
pub fn is_within(root: &Path, path: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (root, path) = (norm(root), norm(path));
    path == root || path.starts_with(&format!("{root}\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The translation table itself is `src/shared/wsl-paths.json`, run by
    // `environment::tests` and by the renderer's tests alike.

    #[test]
    fn the_round_trip_is_the_identity() {
        for linux in ["/home/me/repo", "/mnt/c/Users/me", "/tmp/a b/c.txt"] {
            let host = to_windows(Share::Localhost, "Ubuntu", linux);
            assert_eq!(to_linux("Ubuntu", &host.to_string_lossy()), linux);
        }
    }

    #[test]
    fn mirrored_networking_is_read_from_the_wsl2_section_only() {
        assert!(parse_mirrored("[wsl2]\nnetworkingMode=mirrored\n"));
        assert!(parse_mirrored("[WSL2]\r\n  NetworkingMode = Mirrored  # yes\r\n"));
        assert!(!parse_mirrored("[wsl2]\nnetworkingMode=NAT\n"));
        assert!(!parse_mirrored("[experimental]\nnetworkingMode=mirrored\n"));
        assert!(!parse_mirrored("[wsl2]\nmemory=12GB   # Limits VM memory\nswap=4GB\n"));
        assert!(!parse_mirrored(""));
    }

    #[test]
    fn the_probe_reads_past_a_login_banner() {
        let out = "Welcome to Ubuntu\n\nNYRA-PROBE\u{1f}/home/me\u{1f}/usr/bin:/bin\u{1f}/home/me/.local/bin/claude\n";
        assert_eq!(
            parse_probe(out),
            Some(Probe {
                home: "/home/me".into(),
                path: "/usr/bin:/bin".into(),
                claude: "/home/me/.local/bin/claude".into(),
            })
        );
    }

    #[test]
    fn a_probe_without_claude_still_has_a_home() {
        let out = "\nNYRA-PROBE\u{1f}/root\u{1f}/usr/bin\u{1f}\n";
        assert_eq!(parse_probe(out).map(|p| p.claude), Some(String::new()));
        assert_eq!(parse_probe("no marker here"), None);
    }

    #[test]
    fn a_newline_inside_path_does_not_end_the_record() {
        let out = "NYRA-PROBE\u{1f}/home/me\u{1f}/usr/bin:/mnt/c/rust/stable-x86_64-pc\n  -windows-msvc/bin:/home/me/.local/bin\u{1f}/home/me/.local/bin/claude\u{1e}\n";
        let probe = parse_probe(out).unwrap();
        assert_eq!(probe.path, "/usr/bin:/mnt/c/rust/stable-x86_64-pc\n  -windows-msvc/bin:/home/me/.local/bin");
        assert_eq!(probe.claude, "/home/me/.local/bin/claude");
    }

    #[test]
    fn a_windows_claude_or_an_alias_is_not_the_distros() {
        let with = |claude: &str| {
            parse_probe(&format!("NYRA-PROBE\u{1f}/home/me\u{1f}/usr/bin\u{1f}{claude}\n")).map(|p| p.claude)
        };
        assert_eq!(with("/mnt/c/nvm4w/nodejs/claude"), Some(String::new()));
        assert_eq!(with("alias claude='npx claude'"), Some(String::new()));
        assert_eq!(with("/usr/local/bin/claude"), Some("/usr/local/bin/claude".into()));
    }

    #[test]
    fn containment_ignores_case_and_slash_direction() {
        let root = Path::new(r"\\wsl.localhost\Ubuntu\home\me");
        assert!(is_within(root, Path::new("//wsl.localhost/ubuntu/home/me/.claude")));
        assert!(!is_within(root, Path::new(r"\\wsl.localhost\Ubuntu\home\meow")));
    }

    /// Against the real thing. `cargo test -- --ignored wsl` on a machine with
    /// a distro, named by `NYRA_TEST_DISTRO` (default `Ubuntu`).
    #[test]
    #[ignore]
    fn probes_a_real_distro() {
        let distro = std::env::var("NYRA_TEST_DISTRO").unwrap_or_else(|_| "Ubuntu".into());
        let found = run_probe(&distro).expect("the distro answered");
        eprintln!("{found:?}");
        assert!(found.home.starts_with('/'), "{found:?}");
        assert!(found.path.contains("/usr/bin"), "{found:?}");
        assert!(!found.claude.is_empty(), "claude was not found in {distro}: {found:?}");
        assert!(!found.claude.starts_with("/mnt/"), "a Windows claude: {found:?}");
    }
}
