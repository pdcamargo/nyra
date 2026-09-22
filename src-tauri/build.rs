fn main() {
    link_clang_runtime();
    tauri_build::build()
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
#[cfg(target_os = "macos")]
fn link_clang_runtime() {
    use std::process::Command;

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

#[cfg(not(target_os = "macos"))]
fn link_clang_runtime() {}
