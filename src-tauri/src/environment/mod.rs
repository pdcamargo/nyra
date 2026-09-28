//! Where a project's code runs: on this machine, or inside a WSL distro.
//!
//! `platform/` is chosen at compile time, and a Windows binary is always
//! Windows. This is chosen at runtime, per project: one Nyra can have a Windows
//! project and a WSL project open side by side. So it is a second layer beside
//! `platform/`, not a part of it.
//!
//! The rule that holds it together: anything that spawns in, or takes a path
//! from, a project's directory goes through that project's `Environment`, the
//! way every child already goes through `platform::command`. Only this module
//! knows `wsl.exe` exists.
//!
//! `Host` is exactly what the code did before there was an environment —
//! `platform::command` in `cwd`, `util::home_dir`, paths as given — so a call
//! site that switches to it behaves as it always has.

pub mod wsl;

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Environment {
    Host,
    Wsl { distro: String, share: wsl::Share },
}

impl Environment {
    /// From a project directory: `\\wsl.localhost\Ubuntu\home\me\repo` and
    /// `\\wsl$\Ubuntu\…` are WSL, anything else is the host.
    pub fn of(cwd: &str) -> Environment {
        match wsl::parse_unc(cwd) {
            Some((share, distro, _)) => Environment::Wsl { distro, share },
            None => Environment::Host,
        }
    }

    pub fn is_host(&self) -> bool {
        matches!(self, Environment::Host)
    }

    pub fn distro(&self) -> Option<&str> {
        match self {
            Environment::Host => None,
            Environment::Wsl { distro, .. } => Some(distro),
        }
    }

    /// A command that runs `program` inside this environment, in `cwd`.
    ///
    /// WSL: `wsl.exe -d <distro> --cd <linux cwd> --exec env PATH=<…> <program>`.
    /// `--exec` hands argv straight to the Linux process — no shell in between,
    /// so a multi-line argument arrives byte for byte. It also reads no rc files,
    /// which is why PATH is the one the probe got from the user's shell: without
    /// it `claude` is not found, and an `npx` MCP server cannot find `node`.
    ///
    /// Nothing else of Nyra's environment is forwarded. Only what `WSLENV` names
    /// crosses anyway, and a process in the distro should see the distro's own.
    pub fn std_command(&self, program: &str, cwd: &str) -> std::process::Command {
        match self {
            Environment::Host => {
                let mut cmd = crate::platform::std_command(program);
                cmd.current_dir(cwd);
                cmd
            }
            Environment::Wsl { distro, .. } => {
                let mut cmd = crate::platform::std_command("wsl.exe");
                cmd.args(["-d", distro.as_str()]);
                if !cwd.is_empty() {
                    cmd.arg("--cd").arg(self.to_env(Path::new(cwd)));
                }
                cmd.args(["--exec", "env"]);
                if let Some(path) = wsl::probe(distro).map(|p| p.path).filter(|p| !p.is_empty()) {
                    cmd.arg(format!("PATH={path}"));
                }
                cmd.arg(program);
                cmd
            }
        }
    }

    /// [`Environment::std_command`], as a tokio command.
    pub fn command(&self, program: &str, cwd: &str) -> tokio::process::Command {
        tokio::process::Command::from(self.std_command(program, cwd))
    }

    /// The environment's own interactive shell, for the terminal panel, in
    /// `cwd` (its home when empty).
    ///
    /// WSL: `wsl.exe -d <distro> --cd <dir>` with no `--exec`, which is WSL
    /// starting the user's login shell the way a terminal tab would. The host
    /// environment is still what the PTY gets, as it always has: it only reaches
    /// `wsl.exe`, and the shell inside reads its own profile.
    pub fn shell_command(&self, cwd: &str) -> portable_pty::CommandBuilder {
        match self {
            Environment::Host => {
                let (shell, args) = crate::platform::default_shell();
                let mut cmd = crate::platform::pty_command(&shell);
                cmd.args(args);
                cmd.cwd(if cwd.is_empty() { crate::util::home_dir() } else { PathBuf::from(cwd) });
                cmd
            }
            Environment::Wsl { distro, .. } => {
                let mut cmd = crate::platform::pty_command("wsl.exe");
                cmd.args(["-d", distro.as_str(), "--cd"]);
                cmd.arg(if cwd.is_empty() { "~".to_string() } else { self.to_env(Path::new(cwd)) });
                cmd
            }
        }
    }

    /// A path this environment printed, as one Nyra can open. Identity on the
    /// host; a relative path, or one that is already a Windows path, is left
    /// alone in WSL too.
    pub fn to_host(&self, path: &str) -> PathBuf {
        match self {
            Environment::Host => PathBuf::from(path),
            Environment::Wsl { distro, share } => wsl::to_windows(*share, distro, path),
        }
    }

    /// A path Nyra holds, as this environment names it. Identity on the host.
    pub fn to_env(&self, host: &Path) -> String {
        match self {
            Environment::Host => host.to_string_lossy().into_owned(),
            Environment::Wsl { distro, .. } => wsl::to_linux(distro, &host.to_string_lossy()),
        }
    }

    /// `cwd` as the environment names it: `/home/me/repo` for a WSL share.
    pub fn cwd_in_env(&self, cwd: &str) -> String {
        self.to_env(Path::new(cwd))
    }

    /// Whether `path` is inside `root`, compared the way this environment's
    /// paths compare on the host. The host keeps `Path::starts_with`; the share
    /// is case-insensitive and takes either slash.
    pub fn is_within(&self, root: &Path, path: &Path) -> bool {
        match self {
            Environment::Host => path.starts_with(root),
            Environment::Wsl { .. } => wsl::is_within(root, path),
        }
    }

    /// The `claude` to run when this environment has to have its own.
    ///
    /// Host: `Ok(None)`, and the caller resolves the host's CLI from Settings
    /// the way it always has. WSL: the distro's own, found by the probe — never
    /// the Windows binary Settings names, which would run with the Windows
    /// `~/.claude` against a 9P share. Err says why there is none.
    pub fn own_claude(&self) -> Result<Option<String>, String> {
        let Environment::Wsl { distro, .. } = self else {
            return Ok(None);
        };
        match wsl::probe(distro) {
            None => Err(format!(
                "Couldn't start the {distro} WSL distro to run Claude Code in it. Check that `wsl -d {distro}` opens a shell."
            )),
            Some(p) if p.claude.is_empty() => Err(format!(
                "Claude Code isn't installed in {distro}. Install it inside the distro (`curl -fsSL https://claude.ai/install.sh | bash`), then send the message again."
            )),
            Some(p) => Ok(Some(p.claude)),
        }
    }

    /// Whether a process here can reach the host's `127.0.0.1`, where Nyra
    /// serves its browser and app MCP servers. Under WSL2's default NAT the
    /// distro's loopback is its own; mirrored networking shares the host's.
    pub fn reaches_host_loopback(&self) -> bool {
        match self {
            Environment::Host => true,
            Environment::Wsl { .. } => wsl::mirrored_networking(),
        }
    }

    /// The environment's `$HOME`, as a path Nyra can open — where its
    /// `~/.claude` is.
    ///
    /// A distro that will not answer has no home to report. The share's root is
    /// what comes back then, so every lookup under it finds nothing rather than
    /// reading the Windows `~/.claude` in its place.
    pub fn home(&self) -> PathBuf {
        match self {
            Environment::Host => crate::util::home_dir(),
            Environment::Wsl { distro, share } => {
                let home = wsl::probe(distro).map(|p| p.home).unwrap_or_else(|| "/".into());
                wsl::to_windows(*share, distro, &home)
            }
        }
    }
}

/// What the renderer needs to mark a project and explain what a WSL chat
/// cannot do.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    /// `host` or `wsl`.
    pub kind: &'static str,
    pub distro: Option<String>,
    /// Whether the distro answered at all. Always true on the host.
    pub reachable: bool,
    /// Whether the distro has its own `claude`. Always true on the host, which
    /// reports a missing CLI its own way.
    pub claude_found: bool,
    /// Whether the distro shares the host's loopback, so Nyra's MCP servers are
    /// reachable from inside it. Always false on the host, where it means
    /// nothing.
    pub mirrored_networking: bool,
    /// The directory as the environment names it — `/home/me/repo` in WSL, the
    /// cwd unchanged on the host. For display: the renderer has no host → env
    /// mapping of its own.
    pub cwd_in_env: String,
    /// The environment's `$HOME` as it names it, so a display can write `~`.
    /// None on the host, and for a distro that did not answer.
    pub home_in_env: Option<String>,
}

/// Asking about a distro is also what warms its probe, so the first chat, git
/// call or memory read in a newly opened WSL project does not wait on it.
pub async fn info(cwd: &str) -> EnvironmentInfo {
    let env = Environment::of(cwd);
    let Some(distro) = env.distro().map(str::to_string) else {
        return EnvironmentInfo {
            kind: "host",
            distro: None,
            reachable: true,
            claude_found: true,
            mirrored_networking: false,
            cwd_in_env: cwd.to_string(),
            home_in_env: None,
        };
    };
    let asked = distro.clone();
    let probe = tauri::async_runtime::spawn_blocking(move || wsl::probe(&asked))
        .await
        .ok()
        .flatten();
    EnvironmentInfo {
        kind: "wsl",
        reachable: probe.is_some(),
        claude_found: probe.as_ref().is_some_and(|p| !p.claude.is_empty()),
        mirrored_networking: wsl::mirrored_networking(),
        cwd_in_env: env.cwd_in_env(cwd),
        home_in_env: probe.map(|p| p.home),
        distro: Some(distro),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The table the renderer runs too, so the two sides cannot drift.
    const FIXTURE: &str = include_str!("../../../src/shared/wsl-paths.json");

    fn cases(section: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(FIXTURE).expect("wsl-paths.json parses");
        let list = all[section].as_array().unwrap_or_else(|| panic!("no `{section}` in the fixture"));
        assert!(!list.is_empty(), "`{section}` is empty");
        list.clone()
    }

    fn text<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key].as_str().unwrap_or_else(|| panic!("`{key}` missing in {case}"))
    }

    #[test]
    fn the_shared_fixture_detects_a_distro_from_the_cwd() {
        for case in cases("detect") {
            let cwd = text(&case, "cwd");
            let env = Environment::of(cwd);
            match (&env, case["distro"].as_str()) {
                (Environment::Wsl { distro, share }, Some(expected)) => {
                    assert_eq!(distro, expected, "{cwd}");
                    assert_eq!(share.prefix(), text(&case, "share"), "{cwd}");
                    assert_eq!(env.cwd_in_env(cwd), text(&case, "linux"), "{cwd}");
                }
                (Environment::Host, None) => {}
                (env, expected) => panic!("{cwd}: got {env:?}, expected distro {expected:?}"),
            }
        }
    }

    #[test]
    fn the_shared_fixture_maps_env_paths_to_host_paths() {
        for case in cases("toHost") {
            let env = Environment::of(text(&case, "cwd"));
            let path = text(&case, "path");
            assert_eq!(env.to_host(path), PathBuf::from(text(&case, "host")), "{case}");
        }
    }

    #[test]
    fn the_shared_fixture_maps_host_paths_to_env_paths() {
        for case in cases("toEnv") {
            let env = Environment::of(text(&case, "cwd"));
            let host = text(&case, "host");
            assert_eq!(env.to_env(Path::new(host)), text(&case, "path"), "{case}");
        }
    }

    #[test]
    fn a_share_is_wsl_and_anything_else_is_the_host() {
        assert_eq!(
            Environment::of(r"\\wsl.localhost\Ubuntu\home\me\repo"),
            Environment::Wsl { distro: "Ubuntu".into(), share: wsl::Share::Localhost }
        );
        assert_eq!(Environment::of(r"C:\Users\me\repo"), Environment::Host);
        assert_eq!(Environment::of("/Users/me/repo"), Environment::Host);
        assert_eq!(Environment::of(""), Environment::Host);
    }

    #[test]
    fn the_host_hands_paths_back_as_given() {
        let host = Environment::Host;
        assert_eq!(host.to_host("/tmp/x.png"), PathBuf::from("/tmp/x.png"));
        assert_eq!(host.to_env(Path::new(r"C:\a\b")), r"C:\a\b");
        assert_eq!(host.cwd_in_env(r"C:\a"), r"C:\a");
        assert_eq!(host.home(), crate::util::home_dir());
    }

    #[test]
    fn a_host_command_is_the_platform_command_in_cwd() {
        let dir = std::env::temp_dir();
        let cmd = Environment::Host.std_command("git", &dir.to_string_lossy());
        assert_eq!(cmd.get_current_dir(), Some(dir.as_path()));
        assert_eq!(cmd.get_args().count(), 0);
    }

    #[test]
    fn a_wsl_command_runs_the_program_in_the_distro_with_its_path() {
        wsl::set_probe_for_test(
            "EnvTest",
            wsl::Probe {
                home: "/home/me".into(),
                path: "/home/me/.local/bin:/usr/bin".into(),
                claude: "/home/me/.local/bin/claude".into(),
            },
        );
        let env = Environment::of(r"\\wsl.localhost\EnvTest\home\me\repo");
        let cmd = env.std_command("git", r"\\wsl.localhost\EnvTest\home\me\repo");
        assert_eq!(cmd.get_program(), "wsl.exe");
        assert_eq!(cmd.get_current_dir(), None, "wsl.exe starts in Nyra's own directory");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            [
                "-d",
                "EnvTest",
                "--cd",
                "/home/me/repo",
                "--exec",
                "env",
                "PATH=/home/me/.local/bin:/usr/bin",
                "git"
            ]
        );
        assert_eq!(env.home(), PathBuf::from(r"\\wsl.localhost\EnvTest\home\me"));
    }

    /// Against the real thing: the terminal's shell starts in the distro, in the
    /// directory asked for, and `kill_terminal`'s `child.kill()` leaves neither it
    /// nor its foreground job behind. `cargo test -- --ignored wsl`.
    #[test]
    #[ignore]
    fn wsl_real_distro_terminal_shell_dies_with_its_pty() {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};

        let distro = std::env::var("NYRA_TEST_DISTRO").unwrap_or_else(|_| "Ubuntu".into());
        let cwd = format!(r"\\wsl.localhost\{distro}\tmp");
        let env = Environment::of(&cwd);
        let marker = format!("nyra-term-{}", crate::util::rand_suffix(6));
        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut child = pair.slave.spawn_command(env.shell_command(&cwd)).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).into_owned()).is_err() {
                    break;
                }
            }
        });

        // ConPTY opens by asking where the cursor is and waits for the answer,
        // which xterm.js gives in the app. Answer it the same way here.
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut opening = String::new();
        while Instant::now() < deadline && !opening.contains("\u{1b}[6n") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                opening.push_str(&chunk);
            }
        }
        write!(writer, "\u{1b}[1;1R").unwrap();
        write!(writer, "echo \"$$ $PWD\" > /tmp/{marker}; sleep 3171\r").unwrap();
        writer.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let read_back = |env: &Environment, script: &str| -> String {
            let out = env.std_command("sh", "").args(["-c", script]).stdin(std::process::Stdio::null()).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let mut recorded = String::new();
        let mut screen = String::new();
        while Instant::now() < deadline && recorded.is_empty() {
            while let Ok(chunk) = rx.try_recv() {
                screen.push_str(&chunk);
            }
            std::thread::sleep(Duration::from_millis(300));
            recorded = read_back(&env, &format!("cat /tmp/{marker} 2>/dev/null"));
        }
        let Some((pid, pwd)) = recorded.split_once(' ') else {
            panic!("the shell never ran the line; the terminal showed: {screen:?}");
        };
        assert_eq!(pwd, "/tmp", "the shell did not start in the project directory");
        assert!(!read_back(&env, "pgrep -f '[s]leep 3171' || true").is_empty(), "no foreground job");

        child.kill().unwrap();
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(1500));
        let left = read_back(&env, &format!("kill -0 {pid} 2>/dev/null && echo shell-alive; pgrep -f '[s]leep 3171'; rm -f /tmp/{marker}"));
        assert!(left.is_empty(), "left running in {distro}: {left}");
    }

    #[test]
    fn the_wsl_shell_is_the_distros_own_in_the_linux_cwd() {
        let env = Environment::of(r"\\wsl$\Ubuntu\home\me\repo");
        let cmd = env.shell_command(r"\\wsl$\Ubuntu\home\me\repo");
        let argv: Vec<_> = cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(argv, ["wsl.exe", "-d", "Ubuntu", "--cd", "/home/me/repo"]);
    }
}
