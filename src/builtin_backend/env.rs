//! Shell/PATH environment assembly for spawned terminals.

use super::*;

pub(super) fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "powershell.exe".to_string()
            } else if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

pub(super) fn is_shell_program(program: &str) -> bool {
    let name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program)
        .trim_start_matches('-')
        .to_lowercase();
    matches!(
        name.as_str(),
        "sh" | "bash" | "zsh" | "fish" | "ksh" | "csh" | "tcsh" | "dash"
    )
}

pub(super) fn terminal_environment(shell: &str) -> HashMap<String, String> {
    let mut env = std::env::vars().collect::<HashMap<_, _>>();
    let home = env
        .get("HOME")
        .cloned()
        .or_else(default_home_dir)
        .unwrap_or_else(|| "/".to_string());
    env.entry("HOME".to_string())
        .or_insert_with(|| home.clone());
    if let Some(user) = default_user_name() {
        env.entry("USER".to_string())
            .or_insert_with(|| user.clone());
        env.entry("LOGNAME".to_string()).or_insert(user);
    }
    env.insert("SHELL".to_string(), shell.to_string());
    env.insert(
        "PATH".to_string(),
        enriched_terminal_path(env.get("PATH").map(String::as_str), &home),
    );
    env.insert("HERDR_WEBUI".to_string(), "1".to_string());
    // Image-protocol hints. The browser terminal renders Kitty graphics
    // (Ghostty core in wterm 0.5.0), so advertise a Kitty-capable host
    // terminal: agents like jcode use these to pick the Kitty emitter
    // instead of iTerm2/Sixel. Overwrite inherited values - the launching
    // shell (e.g. iTerm.app) leaks its own TERM_PROGRAM and KITTY_WINDOW_ID
    // into the server env, which would misdirect detection toward
    // protocols the web renderer cannot show. The PTY child inherits the
    // server env directly (CommandBuilder::env only adds on top), so the
    // spawn site must also env_remove() the keys listed here.
    env.insert("TERM_PROGRAM".to_string(), "ghostty".to_string());
    env.remove("KITTY_WINDOW_ID");
    env
}

/// Env keys that `terminal_environment` scrubs and that the spawn site must
/// remove from the inherited PTY env (CommandBuilder::env() cannot unset).
pub(crate) const TERMINAL_ENV_SCRUB_KEYS: [&str; 1] = ["KITTY_WINDOW_ID"];

pub(super) fn default_home_dir() -> Option<String> {
    default_user_name().and_then(|user| {
        if cfg!(target_os = "macos") {
            Some(format!("/Users/{user}"))
        } else if cfg!(unix) {
            Some(format!("/home/{user}"))
        } else {
            None
        }
    })
}

pub(super) fn default_user_name() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("LOGNAME").ok())
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn enriched_terminal_path(current_path: Option<&str>, home: &str) -> String {
    let home_entries = [
        ".local/bin",
        "bin",
        ".cargo/bin",
        ".pyenv/bin",
        ".pyenv/shims",
        ".jenv/bin",
        ".jenv/shims",
        ".fzf/bin",
        ".jcode/bin",
    ]
    .into_iter()
    .map(|entry| format!("{home}/{entry}"));
    let mac_path = macos_path_helper_path();
    let common_entries = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/nix/var/nix/profiles/default/bin",
    ];
    let mut entries = Vec::new();
    entries.extend(home_entries);
    if let Some(path) = current_path {
        entries.extend(path.split(':').map(str::to_string));
    }
    if let Some(path) = mac_path.as_deref() {
        entries.extend(path.split(':').map(str::to_string));
    }
    entries.extend(common_entries.into_iter().map(str::to_string));
    dedupe_path_entries(entries)
}

pub(super) fn dedupe_path_entries(entries: impl IntoIterator<Item = String>) -> String {
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() || out.iter().any(|existing| existing == entry) {
            continue;
        }
        out.push(entry.to_string());
    }
    out.join(":")
}

#[cfg(target_os = "macos")]
pub(super) fn macos_path_helper_path() -> Option<String> {
    let output = std::process::Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_path_helper_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
pub(super) fn macos_path_helper_path() -> Option<String> {
    None
}

pub(super) fn parse_path_helper_output(output: &str) -> Option<String> {
    for line in output.lines() {
        let Some(rest) = line.trim_start().strip_prefix("PATH=") else {
            continue;
        };
        let rest = rest.trim_start();
        if let Some(value) = rest.strip_prefix('"') {
            return value.split('"').next().map(str::to_string);
        }
        if let Some(value) = rest.strip_prefix('\'') {
            return value.split('\'').next().map(str::to_string);
        }
        return rest.split(';').next().map(str::to_string);
    }
    None
}
