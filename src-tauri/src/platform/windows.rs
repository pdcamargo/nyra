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

/// Every process on the machine: parents from one Toolhelp snapshot, memory
/// from each process's working set — the closest thing Windows has to `ps`'s
/// resident size, with the same habit of counting shared pages in every
/// process that maps them. There is no `ps` to run here; Git's `usr/bin` one
/// speaks MSYS pids, which are not the ones Nyra holds.
///
/// A parent pid in a snapshot is only what the process was started by, and
/// Windows recycles pids without reparenting, so a long-dead parent's number
/// can by now belong to something else. The memory walk goes down from a
/// chat's own live pids, where that is not a concern in practice.
pub fn process_table() -> Option<Vec<super::ProcessRow>> {
    let rows = each_process()?
        .into_iter()
        .map(|(pid, ppid)| super::ProcessRow {
            pid: pid as i32,
            ppid: ppid as i32,
            resident_kb: working_set_kb(pid),
        })
        .collect();
    Some(rows)
}

/// Every (pid, parent pid) on the machine, from one Toolhelp snapshot.
fn each_process() -> Option<Vec<(u32, u32)>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut out = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            out.push((entry.th32ProcessID, entry.th32ParentProcessID));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Some(out)
    }
}

/// Every process whose command line contains `needle`, with its start time.
///
/// What `pgrep -f` and `ps -o lstart=` do on Unix, read natively: the command
/// line out of the process itself, the creation time out of its handle. A
/// process that cannot be opened — protected, or another user's — cannot be
/// one of Claude's shells anyway, so it is skipped rather than guessed at.
pub fn find_processes(needle: &str) -> Vec<super::FoundProcess> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let Some(all) = each_process() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (pid, _) in all {
        // The idle process and System have no command line to read.
        if pid <= 4 {
            continue;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                continue;
            }
            if command_line(handle).is_some_and(|line| line.contains(needle)) {
                found.push(super::FoundProcess {
                    pid: pid as i32,
                    started_ms: creation_ms(handle),
                });
            }
            CloseHandle(handle);
        }
    }
    found
}

/// The command line a process was started with. `ProcessCommandLineInformation`
/// needs only limited-query access, unlike reading it out of the PEB, and has
/// been there since Windows 8.1.
unsafe fn command_line(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
    use windows_sys::Win32::Foundation::UNICODE_STRING;
    let mut needed = 0u32;
    // The first call only says how big the answer is.
    NtQueryInformationProcess(handle, ProcessCommandLineInformation, std::ptr::null_mut(), 0, &mut needed);
    if needed == 0 {
        return None;
    }
    // u64s so the UNICODE_STRING at the front is aligned; its text follows it.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let status = NtQueryInformationProcess(
        handle,
        ProcessCommandLineInformation,
        buf.as_mut_ptr().cast(),
        (buf.len() * 8) as u32,
        &mut needed,
    );
    if status < 0 {
        return None;
    }
    let text = &*(buf.as_ptr() as *const UNICODE_STRING);
    if text.Buffer.is_null() || text.Length == 0 {
        return None;
    }
    let units = std::slice::from_raw_parts(text.Buffer, usize::from(text.Length) / 2);
    Some(String::from_utf16_lossy(units))
}

/// When a process started, in Unix ms.
unsafe fn creation_ms(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<i64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let mut created: FILETIME = std::mem::zeroed();
    let (mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME) =
        (std::mem::zeroed(), std::mem::zeroed(), std::mem::zeroed());
    if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
        return None;
    }
    // 100 ns ticks since 1601; the Unix epoch is 11 644 473 600 s after that.
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Some((ticks / 10_000) as i64 - 11_644_473_600_000)
}

/// Which pid listens on which TCP ports, from the kernel's own table — what
/// `lsof -iTCP -sTCP:LISTEN` reads on a Mac. IPv4 and IPv6 both: a dev server
/// on `::` has no IPv4 row at all.
pub fn listening_ports() -> Option<std::collections::HashMap<i32, Vec<u16>>> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID};
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    let mut by_pid = std::collections::HashMap::new();
    let v4 = listener_table(AF_INET)?;
    for row in rows_of::<MIB_TCPROW_OWNER_PID>(&v4) {
        super::add_port(&mut by_pid, row.dwOwningPid as i32, port_of(row.dwLocalPort));
    }
    // IPv6 can be switched off; its absence is not a reason to report nothing.
    if let Some(v6) = listener_table(AF_INET6) {
        for row in rows_of::<MIB_TCP6ROW_OWNER_PID>(&v6) {
            super::add_port(&mut by_pid, row.dwOwningPid as i32, port_of(row.dwLocalPort));
        }
    }
    Some(by_pid)
}

/// The port lives in the low 16 bits, in network byte order.
fn port_of(raw: u32) -> u16 {
    u16::from_be((raw & 0xFFFF) as u16)
}

/// `GetExtendedTcpTable`'s listener table for one address family, raw.
fn listener_table(family: u16) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER};
    let mut size = 0u32;
    // The table can grow between asking its size and reading it, so ask again
    // a couple of times rather than once.
    for _ in 0..4 {
        let mut buf = vec![0u8; size as usize];
        let ptr = if buf.is_empty() { std::ptr::null_mut() } else { buf.as_mut_ptr().cast() };
        let status = unsafe {
            GetExtendedTcpTable(ptr, &mut size, 0, u32::from(family), TCP_TABLE_OWNER_PID_LISTENER, 0)
        };
        match status {
            NO_ERROR if !buf.is_empty() => return Some(buf),
            NO_ERROR | ERROR_INSUFFICIENT_BUFFER => continue,
            _ => return None,
        }
    }
    None
}

/// The rows of a `MIB_TCP(6)TABLE_OWNER_PID`: a count, then the rows. Read
/// unaligned, because the buffer is bytes.
fn rows_of<Row: Copy>(table: &[u8]) -> Vec<Row> {
    const HEADER: usize = 4;
    let size = std::mem::size_of::<Row>();
    if table.len() < HEADER {
        return Vec::new();
    }
    let count = u32::from_ne_bytes([table[0], table[1], table[2], table[3]]) as usize;
    (0..count)
        .map(|i| HEADER + i * size)
        .take_while(|at| at + size <= table.len())
        .map(|at| unsafe { std::ptr::read_unaligned(table[at..].as_ptr() as *const Row) })
        .collect()
}

fn working_set_kb(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let read = K32GetProcessMemoryInfo(handle, &mut counters, size) != 0;
        CloseHandle(handle);
        read.then(|| counters.WorkingSetSize as u64 / 1024)
    }
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
