mod protocol;
mod terminal_text;

pub mod backend_client;
pub mod socket_paths;
pub mod tui;

// Compatibility re-exports: the public TUI surface stays `herdr_webui::tui_*`
// for the binary and the e2e test module.
pub use tui::keys;
pub use tui::model;
pub use tui::panels;
pub use tui::render;
pub use tui::terminal;
pub use tui::theme;
pub use tui::web_api;

/// Process-wide lock serializing env-var manipulation across all lib
/// test modules (backend_client, service-adjacent helpers, tui_web_api).
/// Env is global and tests run in parallel, so every test that reads or
/// writes `HERDR_WEBUI_TUI_API`, `XDG_CONFIG_HOME`, or `HOME` must hold
/// this lock; module-private locks let cross-module pairs race.
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}
