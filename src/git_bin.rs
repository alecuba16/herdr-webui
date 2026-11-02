//! Git binary resolution for the webui process and its built-in backend.
//!
//! The LaunchAgent runs the installed service with a minimal
//! `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. On macOS `/usr/bin/git` is an
//! `xcrun` shim that loads a `libxcrun.dylib` matching the current
//! process architecture. When the service binary runs under Rosetta
//! (x86_64 on an arm64 machine) the shim dies with "missing compatible
//! architecture" before git ever starts, and every git feature
//! (worktree discovery, branches, status) silently degrades.
//!
//! Resolution order, probed once per process:
//! 1. `HERDR_WEBUI_GIT_BIN` env override (explicit operator pin).
//! 2. Homebrew/MacPorts git (`/opt/homebrew/bin/git`,
//!    `/usr/local/bin/git`, `/opt/local/bin/git`), accepted only when the
//!    candidate answers `--version` from this process context.
//! 3. `git` from `PATH` (previous behavior, also correct on Linux).
//!
//! A candidate that fails to spawn or answers a failing exit status is
//! skipped, so a broken install falls through instead of poisoning
//! resolution the way the bare shim does.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Candidate git binaries tried before the bare `PATH` lookup.
const GIT_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/opt/local/bin/git",
];

pub(crate) const GIT_BIN_ENV: &str = "HERDR_WEBUI_GIT_BIN";

/// A `Command` preconfigured with the resolved git binary.
pub(crate) fn command() -> Command {
    Command::new(resolved())
}

/// The resolved git binary: absolute path or the `PATH` name `git`.
pub(crate) fn resolved() -> String {
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED.get_or_init(resolve_from_env).clone()
}

fn resolve_from_env() -> String {
    resolve_with(std::env::var(GIT_BIN_ENV).ok().as_deref())
}

/// Pure resolution core: `explicit` is the `HERDR_WEBUI_GIT_BIN` value
/// when set, and probing decides between the fixed candidates and the
/// `PATH` lookup. Split from `resolve_from_env` so tests drive the core
/// without touching process env.
fn resolve_with(explicit: Option<&str>) -> String {
    if let Some(explicit) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return explicit.to_string();
    }
    for candidate in GIT_CANDIDATES {
        let path = PathBuf::from(candidate);
        if !path.is_file() {
            continue;
        }
        if candidate_works(&path) {
            return candidate.to_string();
        }
    }
    "git".to_string()
}

/// A candidate counts when `git --version` runs to a success status in
/// this process context. Under Rosetta the `/usr/bin/git` shim fails
/// here (libxcrun dlopen error), which is exactly the signal that
/// disqualifies a candidate.
fn candidate_works(path: &PathBuf) -> bool {
    Command::new(path)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_override_wins_without_probing() {
        assert_eq!(
            resolve_with(Some("/definitely/not/a/real/git")),
            "/definitely/not/a/real/git"
        );
    }

    #[test]
    fn blank_override_falls_through_to_probing() {
        let resolved = resolve_with(Some("   "));
        assert!(
            resolved == "git" || GIT_CANDIDATES.contains(&resolved.as_str()),
            "unexpected resolution: {resolved}"
        );
    }

    #[test]
    fn missing_override_falls_through_to_probing() {
        let resolved = resolve_with(None);
        assert!(
            resolved == "git" || GIT_CANDIDATES.contains(&resolved.as_str()),
            "unexpected resolution: {resolved}"
        );
    }

    #[test]
    fn a_working_candidate_beats_path_git() {
        // A candidate that exists and answers --version must be chosen
        // over the bare PATH lookup when no override is set.
        let resolved = resolve_with(None);
        for candidate in GIT_CANDIDATES {
            let path = PathBuf::from(candidate);
            if path.is_file() && candidate_works(&path) {
                assert_eq!(resolved, *candidate);
                return;
            }
        }
        assert_eq!(resolved, "git");
    }

    #[test]
    fn command_uses_resolved_binary() {
        let cmd = command();
        assert_eq!(cmd.get_program(), std::ffi::OsStr::new(&resolved()));
    }
}
