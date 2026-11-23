//! Domain route modules split out of main.rs. Each exposes the handlers
//! its routes need; main.rs's `app_router` stays the single registration
//! point.

pub(crate) mod auth;
pub(crate) mod panes;
pub(crate) mod session;
pub(crate) mod settings;
pub(crate) mod shared;
pub(crate) mod workspace;
pub(crate) mod worktree;
pub(crate) mod ws;
