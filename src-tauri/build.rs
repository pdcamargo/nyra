fn main() {
    link_clang_runtime();
    let windows = if embed_windows_manifest() {
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new()
    };
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run the tauri build script")
}

/// Embed the Windows app manifest into every binary this crate links, test
/// executables included, and return whether it did.
///
/// The manifest asks for Common Controls v6, the only version with
/// `TaskDialogIndirect`, which Tauri's dependencies import. Left to Tauri it is
/// a resource in the app binary alone, so `cargo test` on Windows died before
/// running a test: STATUS_ENTRYPOINT_NOT_FOUND, from a test exe that loaded v5.
/// Passing it to the linker instead reaches every target, and Tauri is told
/// not to add a second copy. The file is Tauri's default, unchanged.
///
/// MSVC's linker only (`link.exe`, and `lld-link` for a cross-check from a Mac).
fn embed_windows_manifest() -> bool {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !(windows && msvc) {
        return false;
    }
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}

/// Link clang's own runtime library on macOS.
///
/// ggml-metal compiles `@available` checks into calls to
/// `___isPlatformVersionAtLeast`, which lives in `libclang_rt.osx.a`. A normal
/// CMake or Xcode link picks that up for free, but rustc links with
/// `-nodefaultlibs` and hand-picks its libraries, and Rust's own
/// `compiler_builtins` does not provide that symbol — so the final binary
/// fails to link with it undefined, while `cargo check` and `cargo build
/// --lib` both pass because neither one links an executable.
///
/// The path is asked of clang rather than hardcoded, so this keeps working
/// across Xcode upgrades and on a machine with only the Command Line Tools.
///
/// Asked of Cargo's environment rather than `#[cfg]`: a build script's `cfg` is
/// the machine *running* it, so cross-compiling Windows from a Mac would link
/// the macOS runtime into a Windows binary.
fn link_clang_runtime() {
    use std::process::Command;

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let output = Command::new("xcrun")
        .args(["clang", "-print-resource-dir"])
        .output();

    let Ok(output) = output else {
        println!("cargo:warning=could not run clang to find its runtime directory");
        return;
    };
    if !output.status.success() {
        println!("cargo:warning=clang -print-resource-dir failed");
        return;
    }

    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let darwin = std::path::Path::new(&dir).join("lib").join("darwin");
    if !darwin.join("libclang_rt.osx.a").exists() {
        println!("cargo:warning=no libclang_rt.osx.a under {}", darwin.display());
        return;
    }

    println!("cargo:rustc-link-search=native={}", darwin.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
