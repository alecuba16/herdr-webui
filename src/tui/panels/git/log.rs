//! Log and per-file History views: commit list loading and commit diffs.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{parse_commit, parse_diff_lines_with_meta, GitPanel};

/// Webui log page size (`GIT_LOG_PAGE_SIZE`).
pub(crate) const LOG_PAGE_SIZE: usize = 80;
/// Webui log hard cap (`GIT_LOG_MAX_LIMIT`).
pub(crate) const LOG_MAX_LIMIT: usize = 2000;
/// Webui `gitLogDefaultBranch`: the configured default base branch,
/// falling back to "master".
pub(crate) const LOG_DEFAULT_BASE: &str = "master";

/// Log scope cycle, mirroring the webui `cycleLogScope` order
/// (all → base-current → base). API names match `GitLogScope::from_query`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LogScope {
    All,
    #[default]
    BaseCurrent,
    Base,
}

impl LogScope {
    pub fn api_name(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::BaseCurrent => "base-current",
            Self::Base => "base",
        }
    }

    /// Webui cycle order: all → base-current → base → all.
    pub fn next(self) -> Self {
        match self {
            Self::All => Self::BaseCurrent,
            Self::BaseCurrent => Self::Base,
            Self::Base => Self::All,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::BaseCurrent => "base+current",
            Self::Base => "base",
        }
    }
}

impl GitPanel {
    /// Fetch the Log view commits with the current scope, page limit and
    /// file filter (webui `renderLog`). Keeps `commit_selected` clamped;
    /// `+` (load more) grows `log_limit` by one page before calling.
    pub fn refresh_log(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = api.git_log_scoped(
            &self.cwd,
            self.log_scope.api_name(),
            LOG_DEFAULT_BASE,
            self.log_limit,
            self.log_file.as_deref(),
        )?;
        self.commits = data
            .get("commits")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_commit).collect())
            .unwrap_or_default();
        self.log_has_more = data
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if self.commit_selected >= self.commits.len() {
            self.commit_selected = self.commits.len().saturating_sub(1);
        }
        Ok(())
    }

    /// Webui `loadMoreLog`: one more page, capped at `LOG_MAX_LIMIT`.
    pub fn log_load_more(&mut self) -> bool {
        if !self.log_has_more {
            return false;
        }
        self.log_limit = (self.log_limit + LOG_PAGE_SIZE).min(LOG_MAX_LIMIT);
        true
    }

    /// Webui `cycleLogScope`: advance the scope and reset the page size.
    pub fn cycle_log_scope(&mut self) {
        self.log_scope = self.log_scope.next();
        self.log_limit = LOG_PAGE_SIZE;
    }

    /// Hash of the commit selected in Log/History, if any.
    pub fn selected_commit_hash(&self) -> Option<&str> {
        self.commits
            .get(self.commit_selected)
            .map(|commit| commit.hash.as_str())
    }

    /// Load the per-file history for the file selected in Changes. The
    /// History view reuses `commits` + `commit_selected` for rendering.
    pub fn refresh_history(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let Some(file) = self
            .selected_file()
            .map(|entry| entry.path.clone())
            .or_else(|| self.history_file.clone())
        else {
            self.commits = Vec::new();
            self.commit_selected = 0;
            return Ok(());
        };
        self.history_file = Some(file.clone());
        let data = api.git_file_history(&self.cwd, &file)?;
        self.commits = data
            .get("commits")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_commit).collect())
            .unwrap_or_default();
        if self.commit_selected >= self.commits.len() {
            self.commit_selected = self.commits.len().saturating_sub(1);
        }
        // The previous diff (working tree or an older commit) does not
        // belong to this view; clear it so the pane shows the Enter hint
        // until a commit is selected. Meta must stay parallel to lines.
        self.diff_lines.clear();
        self.diff_meta.clear();
        self.diff_title = String::new();
        Ok(())
    }

    /// Load the selected commit's diff into the diff pane (webui history
    /// `showHistoryCommit`: compare `hash^..hash`, scoped to the history
    /// file like the webui `compareFilePaths`).
    pub fn load_commit_diff(&mut self, api: &WebApiClient, hash: &str) -> Result<(), WebApiError> {
        let base = format!("{hash}^");
        let data = api.git_compare(&self.cwd, &base, hash, self.history_file.as_deref())?;
        let (lines, meta) = parse_diff_lines_with_meta(&data);
        self.diff_lines = lines;
        self.diff_meta = meta;
        self.diff_title = format!("{hash}{}", {
            let file = self.history_file.as_deref().unwrap_or("");
            if file.is_empty() {
                String::new()
            } else {
                format!(" · {file}")
            }
        });
        Ok(())
    }

    /// Webui log "compare with parent": read-only diff of `hash^..hash`
    /// into the Log diff pane, scoped to `log_file` when set.
    pub fn log_compare_parent(
        &mut self,
        api: &WebApiClient,
        hash: &str,
    ) -> Result<(), WebApiError> {
        let base = format!("{hash}^");
        let data = api.git_compare(&self.cwd, &base, hash, self.log_file.as_deref())?;
        let (lines, meta) = parse_diff_lines_with_meta(&data);
        self.diff_lines = lines;
        self.diff_meta = meta;
        self.diff_title = format!("{hash}{}", {
            let file = self.log_file.as_deref().unwrap_or("");
            if file.is_empty() {
                String::new()
            } else {
                format!(" · {file}")
            }
        });
        Ok(())
    }

    /// Webui log tag action: create `tag_name` on the selected commit.
    pub fn log_tag(&mut self, api: &WebApiClient, tag_name: &str) -> Result<(), WebApiError> {
        let Some(hash) = self.selected_commit_hash().map(str::to_string) else {
            return Err(WebApiError::Api("no commit selected".to_string()));
        };
        api.git_tag(&self.cwd, tag_name, &hash)?;
        Ok(())
    }

    /// Webui log reset action: reset the current branch to the selected
    /// commit with mode soft/mixed/hard. The server enforces the typed
    /// `"reset hard"` confirmation for hard mode; the prompt layer
    /// already demanded a typed `y` on top of that.
    pub fn log_reset(&mut self, api: &WebApiClient, mode: &str) -> Result<(), WebApiError> {
        let Some(hash) = self.selected_commit_hash().map(str::to_string) else {
            return Err(WebApiError::Api("no commit selected".to_string()));
        };
        let confirmation = if mode == "hard" { "reset hard" } else { "" };
        api.git_reset(&self.cwd, &hash, mode, confirmation)?;
        Ok(())
    }

    /// Webui log rebase action: rebase the current branch with the
    /// selected commit as `upstream` (the webui modal asks for upstream
    /// and onto; the TUI reuses the selected commit as upstream and lets
    /// the server pick the default onto).
    pub fn log_rebase(&mut self, api: &WebApiClient, upstream: &str) -> Result<(), WebApiError> {
        api.git_rebase(&self.cwd, upstream, None, false, "rebase selected")?;
        Ok(())
    }
}
