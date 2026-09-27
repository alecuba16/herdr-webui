//! Git management panel: changes, log, branches, stash, history views.
//!
//! One submodule per subfeature (Phase 2a of `docs/tui-parity-plan.md`):
//! `changes` diff/stage/commit actions, `log` commit lists and commit
//! diffs, `branch` switch/delete, `stash` apply/drop, `parse` response
//! parsers. This module keeps the shared state struct and view plumbing.

mod branch;
mod changes;
mod log;
mod parse;
mod stash;

use std::collections::HashMap;

use serde_json::Value;

use crate::tui::model::value_str;
use crate::tui::web_api::{WebApiClient, WebApiError};

use super::files::move_index;

pub use parse::GitDiffLineMeta;
pub(super) use parse::{
    parse_blame_authors, parse_branch, parse_commit, parse_diff_lines_with_meta, parse_git_files,
    parse_stash,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitView {
    Changes,
    Log,
    Branches,
    Stash,
    /// Per-file history (webui prefix `h`): commits touching the file
    /// selected in Changes, reusing the commit list rendering.
    History,
}

impl GitView {
    pub fn title(self) -> &'static str {
        match self {
            Self::Changes => "Changes",
            Self::Log => "Log",
            Self::Branches => "Branches",
            Self::Stash => "Stash",
            Self::History => "History",
        }
    }

    pub fn all() -> [GitView; 5] {
        [
            Self::Changes,
            Self::Log,
            Self::Branches,
            Self::Stash,
            Self::History,
        ]
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum GitFileStatus {
    Staged,
    Unstaged,
    Untracked,
    Conflicted,
}

impl GitFileStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
            Self::Untracked => "untracked",
            Self::Conflicted => "conflicted",
        }
    }

    pub fn index_letter(self) -> char {
        match self {
            Self::Staged => 'S',
            Self::Unstaged => 'M',
            Self::Untracked => 'U',
            Self::Conflicted => 'C',
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitFileEntry {
    pub path: String,
    pub status: GitFileStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitCommitEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitBranchEntry {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub pushed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitStashEntry {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct GitPanel {
    pub cwd: String,
    pub view: GitView,
    pub branch: String,
    pub upstream: String,
    pub ahead: usize,
    pub behind: usize,
    pub state: String,
    pub files: Vec<GitFileEntry>,
    pub file_selected: usize,
    pub diff_lines: Vec<String>,
    pub diff_title: String,
    /// Parallel to `diff_lines`: git line numbers for blame annotation.
    pub diff_meta: Vec<Option<GitDiffLineMeta>>,
    /// Webui `gitShortcuts.blame` toggle: annotate diff lines with the
    /// author of the line (`new_line_number || old_line_number`).
    pub show_blame: bool,
    /// Parsed blame authors (final line number → author) for the file
    /// in `blame_path`, plus the ref the blame was fetched for.
    pub blame_authors: HashMap<usize, String>,
    pub blame_path: Option<String>,
    pub commits: Vec<GitCommitEntry>,
    pub commit_selected: usize,
    /// File whose history the History view lists (`prefix h` from
    /// Changes, webui `gitShortcuts.history`).
    pub history_file: Option<String>,
    pub branches: Vec<GitBranchEntry>,
    pub branch_selected: usize,
    pub stashes: Vec<GitStashEntry>,
    pub stash_selected: usize,
    pub status: Option<String>,
    pub message: Option<String>,
}

impl GitPanel {
    pub fn new(cwd: &str) -> Self {
        Self {
            cwd: cwd.to_string(),
            view: GitView::Changes,
            branch: String::new(),
            upstream: String::new(),
            ahead: 0,
            behind: 0,
            state: String::new(),
            files: Vec::new(),
            file_selected: 0,
            diff_lines: Vec::new(),
            diff_title: String::new(),
            diff_meta: Vec::new(),
            show_blame: false,
            blame_authors: HashMap::new(),
            blame_path: None,
            commits: Vec::new(),
            commit_selected: 0,
            history_file: None,
            branches: Vec::new(),
            branch_selected: 0,
            stashes: Vec::new(),
            stash_selected: 0,
            status: None,
            message: None,
        }
    }

    pub fn set_cwd(&mut self, cwd: &str) {
        if self.cwd != cwd {
            self.cwd = cwd.to_string();
            self.branch.clear();
            self.upstream.clear();
            self.files.clear();
            self.diff_lines.clear();
            self.diff_meta.clear();
            self.show_blame = false;
            self.blame_authors.clear();
            self.blame_path = None;
            self.commits.clear();
            self.history_file = None;
            self.branches.clear();
            self.stashes.clear();
            self.status = None;
        }
    }

    pub fn refresh(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = api.git_status(&self.cwd)?;
        self.branch = value_str(&data, &["branch"]).unwrap_or("").to_string();
        self.upstream = value_str(&data, &["upstream"]).unwrap_or("").to_string();
        self.ahead = data.get("ahead").and_then(Value::as_u64).unwrap_or(0) as usize;
        self.behind = data.get("behind").and_then(Value::as_u64).unwrap_or(0) as usize;
        self.state = value_str(&data, &["state"]).unwrap_or("").to_string();
        self.files = parse_git_files(&data);
        if self.file_selected >= self.files.len() {
            self.file_selected = self.files.len().saturating_sub(1);
        }
        self.status = None;
        self.message = None;
        Ok(())
    }

    pub fn refresh_view(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        match self.view {
            GitView::Changes => {
                self.refresh(api)?;
                self.refresh_diff(api)
            }
            GitView::Log => self.refresh_log(api),
            GitView::Branches => self.refresh_branches(api),
            GitView::Stash => self.refresh_stashes(api),
            GitView::History => self.refresh_history(api),
        }
    }

    pub fn move_selection(&mut self, delta: isize) {
        match self.view {
            GitView::Changes => {
                self.file_selected = move_index(self.file_selected, self.files.len(), delta);
            }
            GitView::Log => {
                self.commit_selected = move_index(self.commit_selected, self.commits.len(), delta);
            }
            GitView::History => {
                self.commit_selected = move_index(self.commit_selected, self.commits.len(), delta);
            }
            GitView::Branches => {
                self.branch_selected = move_index(self.branch_selected, self.branches.len(), delta);
            }
            GitView::Stash => {
                self.stash_selected = move_index(self.stash_selected, self.stashes.len(), delta);
            }
        }
    }

    pub fn selected_file(&self) -> Option<&GitFileEntry> {
        self.files.get(self.file_selected)
    }
}
