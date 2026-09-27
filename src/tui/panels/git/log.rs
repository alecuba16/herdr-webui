//! Log and per-file History views: commit list loading and commit diffs.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{parse_commit, parse_diff_lines_with_meta, GitPanel};

impl GitPanel {
    pub fn refresh_log(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = api.git_log(&self.cwd, 100, false)?;
        self.commits = data
            .get("commits")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_commit).collect())
            .unwrap_or_default();
        if self.commit_selected >= self.commits.len() {
            self.commit_selected = self.commits.len().saturating_sub(1);
        }
        Ok(())
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
}
