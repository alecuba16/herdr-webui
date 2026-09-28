//! Git management panel: changes, log, branches, stash, history views.
//!
//! One submodule per subfeature (Phase 2a of `docs/tui-parity-plan.md`):
//! `changes` diff/stage/commit actions, `log` commit lists and commit
//! diffs, `branch` switch/delete, `stash` apply/drop, `parse` response
//! parsers. This module keeps the shared state struct and view plumbing.

mod branch;
mod changes;
mod cleanup;
mod conflicts;
mod log;
mod parse;
mod search;
mod stash;

#[cfg(test)]
pub(crate) use cleanup::{parse_cleanup_repos, CleanupItemKind};
pub use conflicts::{ConflictAction, ConflictResolveMode};
pub use log::LogScope;
#[cfg(test)]
pub(crate) use log::LOG_MAX_LIMIT;
pub(crate) use log::LOG_PAGE_SIZE;

use std::collections::HashMap;

use serde_json::Value;

use crate::tui::model::value_str;
use crate::tui::web_api::{WebApiClient, WebApiError};

use super::files::move_index;

pub use parse::GitDiffLineMeta;
pub(super) use parse::{
    parse_blame_authors, parse_branch, parse_commit, parse_diff_lines_with_meta,
    parse_diff_old_path, parse_git_files, parse_stash,
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
    /// Merge/rebase conflict resolution (webui `conflicts` tab).
    Conflicts,
    /// Merged-branch / stale-worktree cleanup (webui `cleanup` tab).
    Cleanup,
}

impl GitView {
    pub fn title(self) -> &'static str {
        match self {
            Self::Changes => "Changes",
            Self::Log => "Log",
            Self::Branches => "Branches",
            Self::Stash => "Stash",
            Self::History => "History",
            Self::Conflicts => "Conflicts",
            Self::Cleanup => "Cleanup",
        }
    }

    pub fn all() -> [GitView; 7] {
        [
            Self::Changes,
            Self::Log,
            Self::Branches,
            Self::Stash,
            Self::History,
            Self::Conflicts,
            Self::Cleanup,
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
    /// `old_path` of the file the Changes diff shows (webui `hunkPatch`
    /// `a/` side; rename source). `None` while no per-file diff is
    /// loaded (working-tree diff or another view's diff).
    pub diff_old_path: Option<String>,
    /// Hunk cursor for the Changes diff (gap 14): ordinal into the
    /// `@@` headers of `diff_lines`. `J`/`K` move it, `H` applies the
    /// webui hunk action (stage when unstaged, unstage when staged).
    pub diff_hunk_selected: usize,
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
    /// Full diff of the stash selected in the Stash view (`stash-show`),
    /// shown split-right like the webui stash view.
    pub stash_diff_lines: Vec<String>,
    pub stash_diff_title: String,
    /// Conflicts view (`/api/git-ui/conflicts`): files + merge/rebase state.
    pub conflict_files: Vec<String>,
    pub conflict_selected: usize,
    pub merge_in_progress: bool,
    pub rebase_in_progress: bool,
    /// Cleanup view: scan results and the space-toggled selection set.
    pub cleanup_root: Option<String>,
    pub cleanup_repos: Vec<CleanupRepo>,
    pub cleanup_selected: usize,
    /// Log view scope, mirroring the webui log scope cycle
    /// (all → base-current → base). `base` is the configured default
    /// branch ("master" unless the webui option changes it).
    pub log_scope: LogScope,
    /// Webui log page size: 80 per page, hard cap 2000
    /// (`GIT_LOG_PAGE_SIZE` / `GIT_LOG_MAX_LIMIT`).
    pub log_limit: usize,
    /// `has_more` from the last log fetch: `+` grows `log_limit`.
    pub log_has_more: bool,
    /// File filter for the Log view (webui `logFilePath`); set by the
    /// file explorer "show history" entry.
    pub log_file: Option<String>,
    /// Webui `selectedLogCommits`: up to two commits marked with Space
    /// in the Log view; `c` compares the pair ordered by log position
    /// (newest = target, like `compareSelectedLog`).
    pub log_selected: Vec<String>,
    /// Diff search (webui Ctrl+F in the diff): incremental query over
    /// `diff_lines` while typing, `n`/`N` cycle matches.
    pub diff_search_active: bool,
    pub diff_search_query: String,
    /// Indices into `diff_lines` matching the current query.
    pub diff_search_matches: Vec<usize>,
    /// Which match `n`/`N` currently points at.
    pub diff_search_selected: usize,
    pub status: Option<String>,
    pub message: Option<String>,
}

/// One repo found by cleanup-scan with its merged branches and stale
/// worktrees (webui `cleanup-scan` response shape).
#[derive(Debug, Clone, PartialEq)]
pub struct CleanupRepo {
    pub path: String,
    pub branches: Vec<String>,
    pub worktrees: Vec<String>,
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
            diff_old_path: None,
            diff_hunk_selected: 0,
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
            stash_diff_lines: Vec::new(),
            stash_diff_title: String::new(),
            conflict_files: Vec::new(),
            conflict_selected: 0,
            merge_in_progress: false,
            rebase_in_progress: false,
            cleanup_root: None,
            cleanup_repos: Vec::new(),
            cleanup_selected: 0,
            log_scope: LogScope::default(),
            log_limit: LOG_PAGE_SIZE,
            log_has_more: false,
            log_file: None,
            log_selected: Vec::new(),
            diff_search_active: false,
            diff_search_query: String::new(),
            diff_search_matches: Vec::new(),
            diff_search_selected: 0,
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
            GitView::Conflicts => self.refresh_conflicts(api),
            GitView::Cleanup => {
                let root = self
                    .cleanup_root
                    .clone()
                    .unwrap_or_else(|| self.cwd.clone());
                self.cleanup_scan(api, &root)
            }
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
            GitView::Conflicts => {
                self.conflict_selected =
                    move_index(self.conflict_selected, self.conflict_files.len(), delta);
            }
            GitView::Cleanup => {
                self.cleanup_selected =
                    move_index(self.cleanup_selected, self.cleanup_items().len(), delta);
            }
        }
    }

    pub fn selected_file(&self) -> Option<&GitFileEntry> {
        self.files.get(self.file_selected)
    }
}
