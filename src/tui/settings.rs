//! TUI settings file helpers and tour/prefix state.

/// Max lines the Help overlay can scroll down: total rows minus whatever
/// fits in the 50-line centered box (title + border included).
pub(crate) fn help_max_scroll() -> usize {
    let rows = crate::tui::keys::help_rows().len();
    rows.saturating_sub(50usize.saturating_sub(4).saturating_sub(1))
}

/// TUI read of the webui's `terminalPrefixPassthrough` option. The
/// webui stores its own options in browser localStorage, which a
/// process cannot read, so this reads the shared webui-settings.json
/// (same file server_settings.rs owns in the binary) under the same key
/// name the webui uses. Absent key, missing file, or a parse failure =
/// off (the default); the read never blocks startup. Asymmetry kept on
/// purpose: the webui toggle edits localStorage, this flag edits the
/// shared settings file, until the webui mirrors the key over.
/// Resolve the shared settings-file path. Public so the bin target's
/// drift-guard test can pin it against server_settings_path (C3):
/// the TUI and the server must never disagree on the file.
pub fn tui_settings_path() -> std::path::PathBuf {
    tui_settings_path_with(std::env::var("XDG_CONFIG_HOME").ok().as_deref(), || {
        std::env::var("HOME").ok()
    })
}

/// to_string_pretty only fails on non-finite floats or depth
/// overflows, and the settings writers patch a plain object read from
/// disk (or a fresh default), so this is infallible in practice and
/// returns the text directly.
pub(crate) fn stringify_settings(root: &serde_json::Value) -> String {
    serde_json::to_string_pretty(root).expect("serializing a plain settings object is infallible")
}

/// Shared io-error mapping so the map_err sites count as one covered
/// function instead of one closure per call site.
pub(crate) fn err_text<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Pure resolver behind tui_settings_path so the no-XDG/no-HOME arm
/// can run without unsetting process-wide env vars.
pub(crate) fn tui_settings_path_with(
    xdg: Option<&str>,
    home: impl FnOnce() -> Option<String>,
) -> std::path::PathBuf {
    if let Some(dir) = xdg {
        std::path::PathBuf::from(dir).join("herdr-webui/webui-settings.json")
    } else {
        home()
            .map(|h| std::path::PathBuf::from(h).join(".config/herdr-webui/webui-settings.json"))
            .unwrap_or_else(|| std::env::temp_dir().join("herdr-webui/webui-settings.json"))
    }
}

/// Read side of the shared settings file (see `tui_settings_path`).
pub(crate) fn tui_terminal_prefix_passthrough() -> bool {
    let Ok(raw) = std::fs::read_to_string(tui_settings_path()) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    value
        .get("terminalPrefixPassthrough")
        .and_then(|flag| flag.as_bool())
        .unwrap_or(false)
}

/// Onboarding-tour run state, persisted in the shared settings file the
/// same way the passthrough flag is (webui/mobile keep theirs in
/// localStorage; a terminal process has none, so the shared file is the
/// TUI's store). "done" = reached the last step, "skipped" = closed
/// early; both suppress nothing in the TUI (there is no auto-start),
/// they only report in the settings overlay.
pub(crate) fn tui_tour_state() -> Option<String> {
    let raw = std::fs::read_to_string(tui_settings_path()).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value
        .get("tuiOnboardingTour")
        .and_then(|state| state.as_str())
        .map(str::to_string)
        .filter(|state| state == "done" || state == "skipped")
}

/// Write side: record the TUI onboarding tour outcome. Unknown keys
/// survive (same patch-in-place discipline as the passthrough writer).
pub(crate) fn tui_set_tour_state(state: &str) -> Result<(), String> {
    let path = tui_settings_path();
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if !root.is_object() {
        root = serde_json::Value::default();
    }
    root["tuiOnboardingTour"] = serde_json::Value::String(state.to_string());
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    std::fs::create_dir_all(parent).map_err(err_text)?;
    let raw = stringify_settings(&root);
    std::fs::write(&path, raw).map_err(err_text)
}

/// Write side: flip `terminalPrefixPassthrough` in the shared file.
/// Unknown keys survive (the whole object is parsed, patched, written
/// back); a missing file starts a fresh object. IO failures surface as
/// the returned error, callers turn it into a status line.
pub(crate) fn tui_set_terminal_prefix_passthrough(on: bool) -> Result<(), String> {
    let path = tui_settings_path();
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if !root.is_object() {
        root = serde_json::Value::default();
    }
    root["terminalPrefixPassthrough"] = serde_json::Value::Bool(on);
    // parent() is None only for bare-root paths, which tui_settings_path
    // never builds; create_dir_all treats an empty path as a no-op.
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    std::fs::create_dir_all(parent).map_err(err_text)?;
    let raw = stringify_settings(&root);
    std::fs::write(&path, raw).map_err(err_text)
}
