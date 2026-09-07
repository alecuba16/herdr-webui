mod protocol;
mod terminal_text;
mod tui_input;
mod tui_keys;
mod tui_model;
mod tui_render;
mod tui_terminal;
mod tui_theme;

pub mod backend_client;
pub mod tui;
pub mod tui_panels;
pub mod tui_web_api;

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
