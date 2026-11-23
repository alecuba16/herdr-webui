//! Inline unit tests for the WebUI server handlers and helpers, split by
//! feature area. `use super::*` still means the whole main.rs namespace:
//! each submodule re-exports its items flat through mod.rs.

#![allow(unused_imports)]

use super::*;
pub(crate) use axum::body::{to_bytes, Body};
pub(crate) use axum::http::{Method, Request};
pub(crate) use serde_json::Value;
pub(crate) use std::io::Cursor;
pub(crate) use std::sync::{Mutex as StdMutex, OnceLock};
pub(crate) use std::thread;
pub(crate) use tower::ServiceExt;

pub(crate) fn env_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

/// Lock the env mutex, recovering from a poisoned state so a panicking
/// test does not cascade failures into every other env-lock test.
/// Shared with the TUI parity e2e module (it redirects
/// `XDG_CONFIG_HOME` for its builtin-backend tests and must not race
/// these).
pub(crate) fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

pub(crate) mod common;
pub(crate) mod config;
pub(crate) mod http_api;
pub(crate) mod lsp_api;
pub(crate) mod notes_sidecar;
pub(crate) mod workspaces;

pub(crate) use common::*;
pub(crate) use config::*;
pub(crate) use http_api::*;
pub(crate) use lsp_api::*;
pub(crate) use notes_sidecar::*;
pub(crate) use workspaces::*;
