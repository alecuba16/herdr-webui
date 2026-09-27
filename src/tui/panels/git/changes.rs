//! Changes view: diff loading, blame, staging, commit, push/pull/fetch.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{
    parse_blame_authors, parse_diff_lines_with_meta, parse_diff_old_path, GitFileStatus, GitPanel,
};

impl GitPanel {
    pub fn refresh_diff(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let file = self
            .files
            .get(self.file_selected)
            .map(|entry| entry.path.clone());
        // The server scopes diffs as `working`, `staged`, or `all` (HEAD).
        let scope = match self
            .files
            .get(self.file_selected)
            .map(|entry| entry.status.clone())
        {
            Some(GitFileStatus::Staged) => "staged",
            _ => "working",
        };
        let data = api.git_diff(&self.cwd, scope, file.as_deref())?;
        let (lines, meta) = parse_diff_lines_with_meta(&data);
        self.diff_lines = lines;
        self.diff_meta = meta;
        self.diff_title = file.clone().unwrap_or_else(|| "working tree".to_string());
        // Hunk actions need the `a/` side for the apply-patch header
        // (webui hunkPatch); only a per-file diff carries it.
        self.diff_old_path = file.as_deref().and_then(|_| parse_diff_old_path(&data));
        // A new diff shifts hunk boundaries: reset the hunk cursor.
        self.diff_hunk_selected = 0;
        // A new diff invalidates the diff search matches (line indices
        // shifted); keep the query so re-running `/` resumes it.
        self.diff_search_matches.clear();
        self.diff_search_selected = 0;
        if !self.diff_search_query.trim().is_empty() {
            self.refresh_diff_search_matches();
        }
        // A new diff target invalidates the blame cache (webui keeps
        // blame per file path).
        if self.blame_path != file {
            self.blame_authors.clear();
        }
        // Blame follows the loaded diff (the webui keeps blame per file
        // path); reload it whenever a diff refreshes with blame shown.
        let Some(file) = file.as_deref().filter(|_| self.show_blame) else {
            return Ok(());
        };
        self.load_blame(api, file)
    }

    /// Toggle blame annotation (webui `gitShortcuts.blame`, prefix `m`).
    /// Blame follows the diff being shown (webui `view.file`), not the
    /// raw selection: in the TUI the selection can move after Enter
    /// loaded a diff, and webui blame annotates the shown file.
    /// Toggling off keeps the cache in case blame is re-enabled.
    pub fn toggle_blame(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        self.show_blame = !self.show_blame;
        if !self.show_blame {
            return Ok(());
        }
        // The shown file is the diff target if one is loaded, else the
        // selection (Enter will load that diff next).
        let shown = self.diff_title.trim();
        let known = shown != "working tree" && self.files.iter().any(|entry| entry.path == shown);
        let file = if known {
            shown.to_string()
        } else {
            self.files
                .get(self.file_selected)
                .map(|entry| entry.path.clone())
                .ok_or_else(|| {
                    self.show_blame = false;
                    WebApiError::Io("no file selected".to_string())
                })?
        };
        // A failed blame load must not leave the toggle on with no
        // annotations: revert like the webui's lazy blame never turned on.
        if let Err(err) = self.load_blame(api, &file) {
            self.show_blame = false;
            return Err(err);
        }
        Ok(())
    }

    /// Fetch and parse `--line-porcelain` blame for the file, mirroring
    /// the webui `parseBlame` (final line number → author).
    fn load_blame(&mut self, api: &WebApiClient, file: &str) -> Result<(), WebApiError> {
        if self.blame_path.as_deref() == Some(file) && !self.blame_authors.is_empty() {
            return Ok(());
        }
        let data = api.git_blame(&self.cwd, file, "working")?;
        let text = data.get("text").and_then(Value::as_str).unwrap_or("");
        self.blame_authors = parse_blame_authors(text);
        self.blame_path = Some(file.to_string());
        Ok(())
    }

    /// Stage the selected file. The webui `stageFile` action always stages
    /// (no toggle), so this does too; unstage is the separate `u` shortcut.
    pub fn stage_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        api.git_stage(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    /// Toggle all: if anything is staged, unstage it; otherwise stage
    /// every unstaged and untracked file. Mirrors the webui
    /// `toggleStageAll` behind prefix `G`.
    pub fn toggle_stage_all(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let staged: Vec<String> = self
            .files
            .iter()
            .filter(|entry| entry.status == GitFileStatus::Staged)
            .map(|entry| entry.path.clone())
            .collect();
        if !staged.is_empty() {
            api.git_unstage(&self.cwd, &staged)?;
            return self.refresh_view(api);
        }
        let paths = self
            .files
            .iter()
            .filter(|entry| entry.status != GitFileStatus::Staged)
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return Ok(());
        }
        api.git_stage(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    /// Unstage the selected file. The webui `unstageFile` action always
    /// unstages (no toggle), so this is the explicit counterpart to
    /// `stage_selected`.
    pub fn unstage_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        api.git_unstage(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    /// Move the hunk cursor (gap 14). `J`/`K` parity with the webui
    /// per-hunk buttons: the cursor walks the `@@` headers of the
    /// loaded Changes diff, wrapping around. Returns false when the
    /// diff has no hunks (nothing selectable).
    pub fn move_hunk_selection(&mut self, delta: i32) -> bool {
        let hunks = self.hunk_headers();
        if hunks.is_empty() {
            return false;
        }
        let len = hunks.len();
        let current = self.diff_hunk_selected.min(len - 1);
        let next = if delta >= 0 {
            (current + delta.unsigned_abs() as usize) % len
        } else {
            (current + len - delta.unsigned_abs() as usize % len) % len
        };
        self.diff_hunk_selected = next;
        true
    }

    /// Indices of the `@@` chunk-header lines in the loaded diff.
    fn hunk_headers(&self) -> Vec<usize> {
        self.diff_meta
            .iter()
            .enumerate()
            .filter_map(|(index, meta)| meta.is_none().then_some(index))
            .collect()
    }

    /// Number of `@@` hunks in the loaded diff.
    pub fn hunk_count(&self) -> usize {
        self.hunk_headers().len()
    }

    /// Index (into `diff_lines`) of the `@@` header the hunk cursor
    /// sits on, for highlighting. None when the diff has no hunks.
    pub fn hunk_cursor_line(&self) -> Option<usize> {
        self.hunk_headers().get(self.diff_hunk_selected).copied()
    }

    /// Apply the webui hunk action to the hunk under the cursor
    /// (`stageHunk` when the shown diff is working-tree scope,
    /// `unstageHunk` reverse-cached when it is staged). Mirrors
    /// `git_ui.js applyHunk` + `hunkPatch`: a single-chunk patch
    /// rebuilt from the parsed diff lines, posted to
    /// `/api/git-ui/apply-patch`, then the view and diff refresh.
    pub fn apply_hunk_action(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let file = self.diff_title.trim().to_string();
        if file.is_empty() || file == "working tree" {
            return Err(WebApiError::Io(
                "select a file to load its diff".to_string(),
            ));
        }
        let hunks = self.hunk_headers();
        let Some(&start) = hunks.get(self.diff_hunk_selected.min(hunks.len().saturating_sub(1)))
        else {
            return Err(WebApiError::Io("no hunk selected".to_string()));
        };
        let end = hunks
            .get(self.diff_hunk_selected + 1)
            .copied()
            .unwrap_or(self.diff_lines.len());
        let old_path = self.diff_old_path.clone().unwrap_or_else(|| file.clone());
        let mut patch = String::new();
        patch.push_str(&format!("diff --git a/{old_path} b/{file}\n"));
        patch.push_str(&format!("--- a/{old_path}\n"));
        patch.push_str(&format!("+++ b/{file}\n"));
        for line in &self.diff_lines[start..end] {
            patch.push_str(line);
            patch.push('\n');
        }
        // Working-tree diff stages the hunk; a staged diff unstages it
        // (webui renders exactly one button per scope, never a toggle).
        let staged = self
            .files
            .iter()
            .find(|entry| entry.path == file)
            .is_some_and(|entry| entry.status == GitFileStatus::Staged);
        api.git_apply_patch(&self.cwd, &patch, staged, true)?;
        self.refresh_view(api)?;
        self.refresh_diff(api)
    }

    pub fn discard_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        api.git_discard(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    pub fn stash_changes(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_stash(&self.cwd)?;
        self.refresh_view(api)
    }

    pub fn commit(
        &mut self,
        api: &WebApiClient,
        title: &str,
        amend: bool,
    ) -> Result<(), WebApiError> {
        api.git_commit(&self.cwd, title, None, amend)?;
        self.refresh_view(api)
    }

    pub fn pull(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_pull(&self.cwd, "rebase")?;
        self.refresh_view(api)
    }

    pub fn push(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_push(&self.cwd, "regular")?;
        self.refresh_view(api)
    }

    pub fn fetch(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_fetch(&self.cwd, None)?;
        self.refresh_view(api)
    }
}
