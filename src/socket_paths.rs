//! Shared socket-path plumbing for the built-in backend.
//!
//! The server (binary crate) and `BackendClient` (lib crate) must derive
//! byte-identical socket paths from the same inputs, or the client connects
//! to a socket the server never bound. This module owns that logic once;
//! call sites keep thin wrappers that inject their own settings directory
//! (the server resolves `server_settings_path()`, the client resolves
//! `runtime_settings_path()` with its test-isolation fallback).

use std::io;
use std::path::{Path, PathBuf};

/// $HOME lookup shared by the binary and lib crates.
pub fn home_dir() -> io::Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is required"))
}

/// Parent directory of a settings path, with the temp-dir fallback used
/// by server, journal, and client-side socket derivations.
pub fn settings_dir_fallback(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("herdr-webui"))
}

/// Maximum socket path length the OS can bind/connect. Unix sun_path is
/// 104 bytes on macOS (108 on Linux) but the built-in backend deliberately
/// keeps a stricter budget (<100) so the same guard works everywhere; the
/// external-session guard reuses it. On Windows named pipes have no such
/// limit and the check passes trivially.
pub const SOCKET_PATH_LIMIT: usize = 100;

/// Sanitize a session name into a filesystem-safe path component. Empty
/// input maps to `default` so a blank `--session` still isolates.
pub fn safe_socket_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

/// Short stable hash suffix for the fallback directory when the canonical
/// path would exceed the OS limit. 8 bytes hex keeps the fallback dir
/// comfortably short even under a long config root.
pub fn short_socket_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Fallback directory for over-limit canonical paths. Unix pins /tmp
/// (short, world-writable); other platforms use the temp dir.
#[cfg(unix)]
pub fn short_builtin_socket_dir(hash: &str) -> PathBuf {
    PathBuf::from("/tmp").join(format!("herdr-webui-builtin-{hash}"))
}

#[cfg(not(unix))]
pub fn short_builtin_socket_dir(hash: &str) -> PathBuf {
    std::env::temp_dir().join(format!("herdr-webui-builtin-{hash}"))
}

#[cfg(unix)]
pub fn socket_path_fits(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().len() < SOCKET_PATH_LIMIT
}

#[cfg(not(unix))]
pub fn socket_path_fits(_path: &Path) -> bool {
    true
}

pub fn socket_path_pair_fits(paths: &(PathBuf, PathBuf)) -> bool {
    socket_path_fits(&paths.0) && socket_path_fits(&paths.1)
}

/// Canonical (api, client) socket pair for a session under `settings_dir`:
/// `<settings_dir>/builtin/<sanitized-session>/{herdr,herdr-client}.sock`.
/// When that pair would not fit the OS limit, fall back to a short hashed
/// directory under /tmp (or the platform temp dir). Both server and client
/// must call this with the SAME settings dir or they compute different
/// sockets and cannot meet.
pub fn builtin_socket_paths_in(settings_dir: &Path, session: Option<&str>) -> (PathBuf, PathBuf) {
    let session = session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(safe_socket_component)
        .unwrap_or_else(|| "default".to_string());
    let dir = builtin_session_dir(settings_dir, Some(&session));
    let paths = (dir.join("herdr.sock"), dir.join("herdr-client.sock"));
    if socket_path_pair_fits(&paths) {
        return paths;
    }

    let hash = short_socket_hash(&format!("{}:{session}", dir.display()));
    let dir = short_builtin_socket_dir(&hash);
    (dir.join("herdr.sock"), dir.join("herdr-client.sock"))
}

/// Canonical session directory under `settings_dir`, with no socket-path
/// fallback. Plain files have no OS path-length limit, so the session
/// journal always lives here even when the sockets had to move to the
/// short hashed directory.
pub fn builtin_session_dir(settings_dir: &Path, session: Option<&str>) -> PathBuf {
    let session = session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(safe_socket_component)
        .unwrap_or_else(|| "default".to_string());
    settings_dir.join("builtin").join(&session)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same process-wide lock the other HOME/XDG tests take: env is
    /// global and tests run in parallel. Poison recovery mirrors
    /// tui/workspace so one panicking test does not cascade. Coverage
    /// is off because the poison arm only runs after a panic inside
    /// another env-mutating test, which the harness reports as its own
    /// failure long before the recovery matters.
    #[cfg_attr(coverage, coverage(off))]
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    #[test]
    fn home_dir_resolves_and_errors_without_home() {
        let _guard = env_lock();
        // Set arm: a defined $HOME must come back verbatim.
        let prev = std::env::var_os("HOME");
        unsafe { std::env::set_var("HOME", "/tmp/herdr-home-check") };
        assert_eq!(home_dir().unwrap(), PathBuf::from("/tmp/herdr-home-check"));
        // Error arm: no $HOME surfaces the NotFound error instead of
        // panicking, so server startup can report it.
        unsafe { std::env::remove_var("HOME") };
        let err = home_dir().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(err.to_string(), "HOME is required");
        // HOME is always set under the test harness, so restore it
        // verbatim the way the other HOME tests do (tui/workspace uses
        // the same expect); the harness would have failed long before a
        // missing HOME could matter here.
        let home = prev.expect("HOME set in tests");
        unsafe { std::env::set_var("HOME", home) };
    }

    #[test]
    fn settings_dir_fallback_returns_parent_and_temp_for_empty() {
        // Parent arm: a normal settings path falls back to its parent.
        let settings = Path::new("/tmp/herdr-settings/webui-settings.json");
        assert_eq!(
            settings_dir_fallback(settings),
            PathBuf::from("/tmp/herdr-settings")
        );
        // Fallback arm: parent() is None only for an empty path; every
        // real caller joins a filename onto a directory, so this arm
        // guards against future path-shape changes.
        assert_eq!(
            settings_dir_fallback(Path::new("")),
            std::env::temp_dir().join("herdr-webui")
        );
    }

    #[test]
    fn session_dir_stays_canonical_when_sockets_fall_back() {
        // Long settings path forces the socket pair into the hashed /tmp
        // fallback; the journal directory must stay canonical so close
        // and cleanup always find it.
        let long_root = std::env::temp_dir().join("a-very-long-settings-root".repeat(3));
        let settings_dir = long_root.join("herdr-webui");
        let (api_socket, _) = builtin_socket_paths_in(&settings_dir, Some("fallback-check"));
        let canonical = builtin_session_dir(&settings_dir, Some("fallback-check"));
        assert_ne!(api_socket.parent(), Some(canonical.as_path()));
        assert!(api_socket.as_os_str().len() < SOCKET_PATH_LIMIT);
        assert_eq!(
            canonical,
            settings_dir.join("builtin").join("fallback-check")
        );
    }

    #[test]
    fn session_dir_matches_socket_dir_when_pair_fits() {
        let settings_dir = std::env::temp_dir().join("herdr-short");
        let (api_socket, _) = builtin_socket_paths_in(&settings_dir, Some("fits"));
        let canonical = builtin_session_dir(&settings_dir, Some("fits"));
        assert_eq!(api_socket.parent(), Some(canonical.as_path()));
    }

    #[test]
    fn session_dir_falls_back_to_default_for_blank_sessions() {
        // Blank session names (None, empty, whitespace) must land on the
        // default directory instead of an empty path component.
        let settings_dir = std::env::temp_dir().join("herdr-blank");
        assert_eq!(
            builtin_session_dir(&settings_dir, None),
            settings_dir.join("builtin").join("default")
        );
        assert_eq!(
            builtin_session_dir(&settings_dir, Some("")),
            settings_dir.join("builtin").join("default")
        );
        assert_eq!(
            builtin_session_dir(&settings_dir, Some("   ")),
            settings_dir.join("builtin").join("default")
        );
    }
}
