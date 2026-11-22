//! TUI unit tests, split by feature area. `use super::*` in a test body
//! still means the whole `crate::tui` namespace: each submodule re-exports
//! its items flat through this mod.rs, and the module keeps the fixtures
//! (app builders, fake sockets) that other tui modules borrow through
//! `crate::tui::tests::*`.

use super::*;

pub(crate) mod common;
mod core_ui;
#[cfg(test)]
mod coverage_round_100;
#[cfg(test)]
mod coverage_round_100_helpers;
#[cfg(test)]
mod coverage_tests_round10;
#[cfg(test)]
mod coverage_tests_round11;
#[cfg(test)]
mod coverage_tests_round12;
#[cfg(test)]
mod coverage_tests_round7;
#[cfg(test)]
mod coverage_tests_round8;
#[cfg(test)]
mod coverage_tests_round9;
mod files;
mod git;
mod palette_lens;
mod settings_sessions;
mod split_layout;

pub(crate) use common::*;
