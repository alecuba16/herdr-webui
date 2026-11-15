//! Shared socket-path plumbing for the built-in backend.
//!
//! The server (binary crate) and `BackendClient` (lib crate) must derive
//! byte-identical socket paths from the same inputs, or the client connects
//! to a socket the server never bound. This module owns that logic once;
//! call sites keep thin wrappers that inject their own settings directory
//! (the server resolves `server_settings_path()`, the client resolves
//! `runtime_settings_path()` with its test-isolation fallback).

use std::path::{Path, PathBuf};

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
}
