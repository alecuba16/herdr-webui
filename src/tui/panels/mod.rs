//! TUI panels: one module per subfeature (files explorer, git management).
//!
//! Split out of the original flat `tui_panels.rs` per the modular layout in
//! `docs/tui-parity-plan.md`.

pub mod files;
pub mod git;

#[cfg(test)]
mod tests;

pub use files::{FileEntry, FileExplorer, FilePreview};
pub use git::{
    GitBranchEntry, GitCommitEntry, GitDiffLineMeta, GitFileEntry, GitFileStatus, GitPanel,
    GitStashEntry, GitView,
};
