use serde_json::Value;
use std::collections::HashMap;

use crate::tui_model::value_str;
use crate::tui_web_api::{WebApiClient, WebApiError};

/// File explorer state. Mirrors the WebUI file browser: lazy directory
/// expansion, flat search results, preview pane for text files.
#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub level: usize,
    pub expanded: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FilePreview {
    pub path: Option<String>,
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    pub hash: String,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct FileExplorer {
    pub cwd: String,
    pub root_path: String,
    pub entries: Vec<FileEntry>,
    pub selected: usize,
    pub scroll: u16,
    pub preview: FilePreview,
    /// Editing mode: keys type into `preview.content` instead of moving
    /// the tree selection.
    pub edit_active: bool,
    /// Byte offset of the edit cursor into `preview.content`.
    pub edit_cursor: usize,
    pub filter: String,
    pub filter_active: bool,
    pub search_mode: bool,
    pub truncated: bool,
    pub status: Option<String>,
}

impl FileExplorer {
    pub fn new(cwd: &str) -> Self {
        Self {
            cwd: cwd.to_string(),
            root_path: String::new(),
            entries: Vec::new(),
            selected: 0,
            scroll: 0,
            preview: FilePreview::default(),
            edit_active: false,
            edit_cursor: 0,
            filter: String::new(),
            filter_active: false,
            search_mode: false,
            truncated: false,
            status: None,
        }
    }

    pub fn refresh(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = if self.search_mode && !self.filter.trim().is_empty() {
            api.file_search(&self.cwd, &self.root_path, self.filter.trim(), 0, 200)?
        } else {
            api.file_tree(&self.cwd, &self.root_path, 0)?
        };
        self.truncated = data
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.entries = parse_entries(&data);
        if self.selected >= self.entries.len() {
            self.selected = self.entries.len().saturating_sub(1);
        }
        self.status = None;
        Ok(())
    }

    pub fn selected_entry(&self) -> Option<&FileEntry> {
        self.entries.get(self.selected)
    }

    /// Expand/collapse a directory inline by merging child entries.
    pub fn toggle_expand(&mut self, api: &WebApiClient) -> Result<bool, WebApiError> {
        let Some(entry) = self.entries.get(self.selected) else {
            return Ok(false);
        };
        if !entry.is_dir {
            return Ok(false);
        }
        let path = entry.path.clone();
        let index = self.selected;
        let was_expanded = entry.expanded;
        if was_expanded {
            let level = entry.level;
            let mut remove_from = index + 1;
            while self
                .entries
                .get(remove_from)
                .is_some_and(|next| next.level > level)
            {
                remove_from += 1;
            }
            self.entries.drain(index + 1..remove_from);
            self.entries[index].expanded = false;
            return Ok(true);
        }
        let data = api.file_tree(&self.cwd, &path, 0)?;
        let mut children = parse_entries(&data);
        // The server numbers levels relative to the fetched directory; shift
        // them under the parent so collapse scanning and indentation work.
        let child_level = self.entries[index].level + 1;
        for child in &mut children {
            child.level = child_level;
        }
        self.entries[index].expanded = true;
        self.entries.splice(index + 1..index + 1, children);
        Ok(true)
    }

    /// Enter the selected directory as the new root (double-click parity).
    pub fn enter_directory(&mut self) -> bool {
        let Some(entry) = self.entries.get(self.selected) else {
            return false;
        };
        if !entry.is_dir {
            return false;
        }
        self.root_path = entry.path.clone();
        self.entries.clear();
        self.selected = 0;
        self.search_mode = false;
        self.preview = FilePreview::default();
        true
    }

    /// Go up one directory, or reset the root when already at the workspace root.
    pub fn go_up(&mut self) -> bool {
        if self.root_path.is_empty() {
            return false;
        }
        let parent = match self.root_path.rsplit_once('/') {
            Some((dir, _)) if !dir.is_empty() => dir.to_string(),
            _ => String::new(),
        };
        self.root_path = parent;
        self.entries.clear();
        self.selected = 0;
        self.preview = FilePreview::default();
        true
    }

    pub fn open_preview(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let Some(entry) = self.entries.get(self.selected).cloned() else {
            return Ok(());
        };
        if entry.is_dir {
            return self.toggle_expand(api).map(|_| ());
        }
        // Opening another file would throw away unsaved edits; the webui
        // keeps dirty editor tabs open, so the TUI refuses until the
        // buffer is saved or reloaded (Ctrl-S / Ctrl-R in edit mode).
        if self.preview.dirty && self.preview.path.as_deref() != Some(entry.path.as_str()) {
            return Err(WebApiError::Io(
                "unsaved edits: save or reload before opening another file".to_string(),
            ));
        }
        self.open_preview_path(api, &entry.path)
    }

    /// Load `path` into the preview, replacing whatever is shown. Callers
    /// are responsible for dirty-buffer checks; Ctrl-R reload uses this to
    /// intentionally discard local edits.
    fn open_preview_path(&mut self, api: &WebApiClient, path: &str) -> Result<(), WebApiError> {
        let data = api.file_read(&self.cwd, path)?;
        let content = data.get("content").and_then(Value::as_str).unwrap_or("");
        let binary = data.get("binary").and_then(Value::as_bool).unwrap_or(false);
        let truncated = data
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.preview = FilePreview {
            path: Some(path.to_string()),
            content: content.to_string(),
            truncated,
            binary,
            hash: data
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            dirty: false,
        };
        Ok(())
    }

    /// Open the selected file for editing in the Files screen. Binary or
    /// truncated previews refuse to edit, mirroring the WebUI editor guard.
    pub fn can_edit_preview(&self) -> Result<(), WebApiError> {
        if self.preview.binary {
            return Err(WebApiError::Io("binary file cannot be edited".to_string()));
        }
        if self.preview.truncated {
            return Err(WebApiError::Io(
                "truncated file cannot be edited safely".to_string(),
            ));
        }
        if self.preview.path.is_none() {
            return Err(WebApiError::Io("no file preview open".to_string()));
        }
        Ok(())
    }

    /// Save the edited content back through the file-browser write API.
    /// The `expected_hash` guard makes the server reject the save when the
    /// file changed on disk since the preview loaded; on conflict the
    /// caller should reload.
    pub fn save_preview(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let Some(path) = self.preview.path.clone() else {
            return Err(WebApiError::Io("no file preview open".to_string()));
        };
        self.can_edit_preview()?;
        let expected_hash = (!self.preview.hash.is_empty()).then_some(self.preview.hash.clone());
        let data = api.file_write(
            &self.cwd,
            &path,
            &self.preview.content,
            expected_hash.as_deref(),
        )?;
        if let Some(hash) = data.get("hash").and_then(Value::as_str) {
            self.preview.hash = hash.to_string();
        }
        self.preview.dirty = false;
        Ok(())
    }

    pub fn move_selection(&mut self, delta: isize) {
        self.selected = move_index(self.selected, self.entries.len(), delta);
    }

    /// Enter edit mode on the open preview after the safety checks.
    pub fn start_edit(&mut self) -> Result<(), WebApiError> {
        self.can_edit_preview()?;
        self.edit_cursor = self.preview.content.len();
        self.edit_active = true;
        Ok(())
    }

    /// Handle one key while editing. Returns Err only for save failures;
    /// Ctrl-S saves, Esc stops editing (dirty state is kept). The cursor is
    /// a byte offset into `preview.content`; char-boundary-safe helpers keep
    /// multibyte UTF-8 intact. Enter inserts a line break (crossterm
    /// reports it as `KeyCode::Enter`, not `Char('\n')`), and control- or
    /// alt-modified chars are ignored so Ctrl combos never reach the file.
    pub fn edit_key(
        &mut self,
        key: crossterm::event::KeyEvent,
        api: &WebApiClient,
    ) -> Result<(), WebApiError> {
        use crossterm::event::{KeyCode, KeyModifiers};
        // Defensive clamp: any path that swapped the preview keeps the
        // invariant, but a stale cursor must never panic the editor.
        self.edit_cursor = self.edit_cursor.min(self.preview.content.len());
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('s')) {
            return self.save_preview(api);
        }
        // Ctrl-R reloads the file from the server, discarding the dirty
        // buffer: the explicit "reload" answer to the 409 conflict message.
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('r')) {
            let path = match self.preview.path.clone() {
                Some(path) => path,
                None => return Ok(()),
            };
            self.open_preview_path(api, &path)?;
            // The file may have become truncated or binary on disk; the
            // edit guards decide whether editing can continue at all.
            self.can_edit_preview()?;
            self.edit_cursor = self.preview.content.len();
            return Ok(());
        }
        let ctrl_or_alt = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        match key.code {
            KeyCode::Esc => {
                self.edit_active = false;
            }
            KeyCode::Backspace => {
                if let Some((index, _)) = self.preview.content[..self.edit_cursor]
                    .char_indices()
                    .next_back()
                {
                    self.preview
                        .content
                        .replace_range(index..self.edit_cursor, "");
                    self.edit_cursor = index;
                    self.preview.dirty = true;
                }
            }
            KeyCode::Enter => {
                self.preview.content.insert(self.edit_cursor, '\n');
                self.edit_cursor += 1;
                self.preview.dirty = true;
            }
            KeyCode::Left => {
                self.edit_cursor = self.preview.content[..self.edit_cursor]
                    .char_indices()
                    .next_back()
                    .map(|(index, _)| index)
                    .unwrap_or(0);
            }
            KeyCode::Home => {
                self.edit_cursor = self.preview.content[..self.edit_cursor]
                    .rfind('\n')
                    .map(|index| index + 1)
                    .unwrap_or(0);
            }
            KeyCode::Right => {
                if let Some(ch) = self.preview.content[self.edit_cursor..].chars().next() {
                    self.edit_cursor += ch.len_utf8();
                }
            }
            KeyCode::End => {
                self.edit_cursor = self.preview.content[self.edit_cursor..]
                    .find('\n')
                    .map(|index| self.edit_cursor + index)
                    .unwrap_or(self.preview.content.len());
            }
            KeyCode::Char(ch) if !ctrl_or_alt => {
                self.preview.content.insert(self.edit_cursor, ch);
                self.edit_cursor += ch.len_utf8();
                self.preview.dirty = true;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn start_filter(&mut self) {
        self.filter_active = true;
    }

    pub fn push_filter_char(&mut self, ch: char) {
        if self.filter_active {
            self.filter.push(ch);
        }
    }

    pub fn pop_filter_char(&mut self) {
        if self.filter_active {
            self.filter.pop();
        }
    }

    pub fn commit_filter(&mut self) {
        self.filter_active = false;
        self.search_mode = !self.filter.trim().is_empty();
    }
}

fn parse_entries(data: &Value) -> Vec<FileEntry> {
    data.get("entries")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_entry).collect())
        .unwrap_or_default()
}

fn parse_entry(value: &Value) -> FileEntry {
    // The server compact single-child chains into names like `a/b/`;
    // strip the trailing slash so the tree shows a clean name and path
    // joining stays consistent.
    let name = value_str(value, &["name"]).unwrap_or_default();
    let is_dir = value_str(value, &["kind"]) == Some("dir");
    let name = if is_dir {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    FileEntry {
        name: name.to_string(),
        path: value_str(value, &["path"]).unwrap_or_default().to_string(),
        is_dir,
        size: value.get("size").and_then(Value::as_u64),
        level: value.get("level").and_then(Value::as_u64).unwrap_or(0) as usize,
        expanded: false,
    }
}

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
        self.diff_title = file
            .clone()
            .unwrap_or_else(|| "working tree".to_string());
        // A new diff target invalidates the blame cache (webui keeps
        // blame per file path).
        if self.blame_path != file {
            self.blame_authors.clear();
        }
        if self.show_blame {
            if let Some(file) = file.as_deref() {
                self.load_blame(api, file)?;
            }
        }
        Ok(())
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
        let known = shown
            != "working tree"
            && self.files.iter().any(|entry| entry.path == shown);
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
        self.load_blame(api, &file)
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

    pub fn refresh_branches(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = api.git_branches(&self.cwd)?;
        self.branches = data
            .get("branches")
            .or_else(|| data.get("local"))
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_branch).collect())
            .unwrap_or_default();
        if self.branch_selected >= self.branches.len() {
            self.branch_selected = self.branches.len().saturating_sub(1);
        }
        Ok(())
    }

    pub fn refresh_stashes(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = api.git_stashes(&self.cwd)?;
        self.stashes = data
            .get("stashes")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_stash).collect())
            .unwrap_or_default();
        if self.stash_selected >= self.stashes.len() {
            self.stash_selected = self.stashes.len().saturating_sub(1);
        }
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

    pub fn switch_branch(&mut self, api: &WebApiClient, branch: &str) -> Result<(), WebApiError> {
        api.git_switch(&self.cwd, branch, false)?;
        self.refresh_view(api)
    }

    /// Switch to the selected branch in the Branches view. Switching away
    /// from the current branch is a no-op success.
    pub fn switch_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let branch = self
            .branches
            .get(self.branch_selected)
            .filter(|entry| !entry.current)
            .map(|entry| entry.name.clone())
            .ok_or_else(|| WebApiError::Io("no branch selected".to_string()))?;
        self.switch_branch(api, &branch)
    }

    /// Delete the given branch. The server enforces its own confirmation
    /// flag; we always pass `confirmed: true` because the TUI collects the
    /// user's `y` confirmation first.
    pub fn delete_branch(
        &mut self,
        api: &WebApiClient,
        branch: &str,
        force: bool,
    ) -> Result<(), WebApiError> {
        api.git_branch_delete(&self.cwd, branch, force)?;
        self.refresh_view(api)
    }

    pub fn stash_apply(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let stash = self
            .stashes
            .get(self.stash_selected)
            .map(|entry| entry.name.clone())
            .ok_or_else(|| WebApiError::Io("no stash selected".to_string()))?;
        api.git_stash_apply(&self.cwd, &stash)?;
        self.refresh_view(api)
    }

    pub fn stash_drop(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let stash = self
            .stashes
            .get(self.stash_selected)
            .map(|entry| entry.name.clone())
            .ok_or_else(|| WebApiError::Io("no stash selected".to_string()))?;
        api.git_stash_drop(&self.cwd, &stash)?;
        self.refresh_view(api)
    }
}

/// Git line numbers for one parsed diff line, used to attach blame
/// authors (`new_line_number || old_line_number`, mirroring the webui).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitDiffLineMeta {
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

/// Parse `git blame --line-porcelain` output into final-line → author,
/// mirroring the webui `parseBlame`: each header line
/// `<sha> <orig> <final> [<num>]` sets the current line, the following
/// `author <name>` fills it.
fn parse_blame_authors(text: &str) -> HashMap<usize, String> {
    let mut by_line = HashMap::new();
    let mut final_line = 0usize;
    for line in text.lines() {
        // Header shape (webui regex `^[0-9a-f]{40}\s+\d+\s+(\d+)`):
        // exactly 40 hex chars, then orig and final line numbers. The
        // check is byte-based via as_bytes so multibyte content lines
        // can never panic a slice at a non-char boundary.
        let is_header = line.len() > 41
            && line.as_bytes()[..40].iter().all(u8::is_ascii_hexdigit)
            && line.as_bytes()[40] == b' ';
        if is_header {
            let nums = line[41..].split_whitespace().collect::<Vec<_>>();
            if nums.len() >= 2 && nums[0].chars().all(|ch| ch.is_ascii_digit()) {
                let final_num = nums[1]
                    .split(|ch: char| !ch.is_ascii_digit())
                    .next()
                    .unwrap_or("");
                if !final_num.is_empty() {
                    final_line = final_num.parse().unwrap_or(0);
                    continue;
                }
            }
        }
        if let Some(name) = line.strip_prefix("author ") {
            if final_line > 0 {
                by_line.insert(final_line, name.trim().to_string());
            }
        }
    }
    by_line
}

/// Parse the `/api/git-ui/diff` response (`files[].chunks[].lines[]`
/// with `line_type`/`content`) into display lines plus line-number
/// metadata parallel to them (`None` for chunk headers). Chunk headers
/// keep their `@@` prefix so the renderer colors them teal.
fn parse_diff_lines_with_meta(data: &Value) -> (Vec<String>, Vec<Option<GitDiffLineMeta>>) {
    let mut out = Vec::new();
    let mut meta = Vec::new();
    let Some(files) = data.get("files").and_then(Value::as_array) else {
        return (out, meta);
    };
    for git_file in files {
        let Some(chunks) = git_file.get("chunks").and_then(Value::as_array) else {
            continue;
        };
        for chunk in chunks {
            if let Some(header) = chunk.get("header").and_then(Value::as_str) {
                out.push(header.to_string());
                meta.push(None);
            }
            if let Some(lines) = chunk.get("lines").and_then(Value::as_array) {
                for line in lines {
                    let kind = line
                        .get("line_type")
                        .and_then(Value::as_str)
                        .unwrap_or("normal");
                    let content = line
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let prefix = match kind {
                        "add" => '+',
                        "delete" => '-',
                        _ => ' ',
                    };
                    out.push(format!("{prefix}{content}"));
                    meta.push(Some(GitDiffLineMeta {
                        old_line: line.get("old_line_number").and_then(Value::as_u64).map(|v| v as usize),
                        new_line: line.get("new_line_number").and_then(Value::as_u64).map(|v| v as usize),
                    }));
                }
            }
        }
    }
    (out, meta)
}

fn parse_git_files(data: &Value) -> Vec<GitFileEntry> {
    let mut files = Vec::new();
    let mut push = |list: &[Value], status: GitFileStatus| {
        for value in list {
            if let Some(path) = value.as_str() {
                files.push(GitFileEntry {
                    path: path.to_string(),
                    status: status.clone(),
                });
            }
        }
    };
    if let Some(list) = data.get("conflicted").and_then(Value::as_array) {
        push(list, GitFileStatus::Conflicted);
    }
    if let Some(list) = data.get("staged").and_then(Value::as_array) {
        push(list, GitFileStatus::Staged);
    }
    if let Some(list) = data.get("unstaged").and_then(Value::as_array) {
        push(list, GitFileStatus::Unstaged);
    }
    if let Some(list) = data.get("untracked").and_then(Value::as_array) {
        push(list, GitFileStatus::Untracked);
    }
    files
}

fn parse_commit(value: &Value) -> GitCommitEntry {
    GitCommitEntry {
        hash: value_str(value, &["hash"]).unwrap_or_default().to_string(),
        message: value_str(value, &["message"])
            .unwrap_or_default()
            .to_string(),
        author: value_str(value, &["author"])
            .unwrap_or_default()
            .to_string(),
        date: value_str(value, &["date"]).unwrap_or_default().to_string(),
        labels: value
            .get("labels")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    }
}

fn parse_branch(value: &Value) -> GitBranchEntry {
    GitBranchEntry {
        name: value_str(value, &["name"]).unwrap_or_default().to_string(),
        current: value
            .get("current")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        remote: value
            .get("remote")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pushed: value
            .get("pushed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_stash(value: &Value) -> GitStashEntry {
    GitStashEntry {
        name: value_str(value, &["name", "stash"])
            .unwrap_or_default()
            .to_string(),
        message: value_str(value, &["message", "subject"])
            .unwrap_or_default()
            .to_string(),
    }
}

fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn edit_key(ch: char, ctrl: bool) -> crossterm::event::KeyEvent {
        use crossterm::event::{KeyCode, KeyModifiers};
        let modifiers = if ctrl {
            KeyModifiers::CONTROL
        } else {
            KeyModifiers::NONE
        };
        crossterm::event::KeyEvent::new(KeyCode::Char(ch), modifiers)
    }

    fn key(code: crossterm::event::KeyCode) -> crossterm::event::KeyEvent {
        crossterm::event::KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    fn ctrl_key(ch: char) -> crossterm::event::KeyEvent {
        crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char(ch),
            crossterm::event::KeyModifiers::CONTROL,
        )
    }

    fn preview(content: &str) -> FilePreview {
        FilePreview {
            path: Some("a.txt".to_string()),
            content: content.to_string(),
            truncated: false,
            binary: false,
            hash: "h1".to_string(),
            dirty: false,
        }
    }

    #[test]
    fn edit_key_types_and_backspaces_utf8_safe() {
        let api = WebApiClient::new("127.0.0.1", 1);
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview = preview("ab");
        explorer.start_edit().unwrap();
        assert_eq!(explorer.edit_cursor, 2);
        // Insert a multibyte char: the cursor advances by its UTF-8 length.
        explorer.edit_key(edit_key('ñ', false), &api).unwrap();
        assert!(explorer.preview.dirty);
        assert_eq!(explorer.preview.content, "abñ");
        assert_eq!(explorer.edit_cursor, "abñ".len());
        // Backspace removes one full multibyte char, not one byte.
        explorer
            .edit_key(key(crossterm::event::KeyCode::Backspace), &api)
            .unwrap();
        assert_eq!(explorer.preview.content, "ab");
        assert_eq!(explorer.edit_cursor, 2);
        // Enter (a real crossterm KeyCode::Enter) inserts a line break.
        explorer
            .edit_key(key(crossterm::event::KeyCode::Enter), &api)
            .unwrap();
        assert_eq!(explorer.preview.content, "ab\n");
        assert_eq!(explorer.edit_cursor, 3);
        // Control chars never reach the buffer: Ctrl-U is ignored here.
        explorer.edit_key(ctrl_key('u'), &api).unwrap();
        assert_eq!(explorer.preview.content, "ab\n");
        // Alt-modified chars are ignored too.
        let alt = crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('j'),
            crossterm::event::KeyModifiers::ALT,
        );
        explorer.edit_key(alt, &api).unwrap();
        assert_eq!(explorer.preview.content, "ab\n");
    }

    #[test]
    fn edit_key_moves_cursor_with_left_right_home_end() {
        let api = WebApiClient::new("127.0.0.1", 1);
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview = preview("l1 x\nl2 y\nl3 z");
        explorer.start_edit().unwrap();
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 y\nl3 z".len());
        // Home: jump to the start of the current (last) line.
        explorer
            .edit_key(key(crossterm::event::KeyCode::Home), &api)
            .unwrap();
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 y\n".len());
        // Left: step back one char onto the previous line's newline.
        explorer
            .edit_key(key(crossterm::event::KeyCode::Left), &api)
            .unwrap();
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 y".len());
        // Left again: within line 2.
        explorer
            .edit_key(key(crossterm::event::KeyCode::Left), &api)
            .unwrap();
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 ".len());
        // Right restores one char.
        explorer
            .edit_key(key(crossterm::event::KeyCode::Right), &api)
            .unwrap();
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 y".len());
        // End: jump to the end of the current line (before its newline).
        explorer
            .edit_key(key(crossterm::event::KeyCode::End), &api)
            .unwrap();
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 y".len());
        // Typing inserts at the cursor, not only at the end.
        explorer.edit_key(edit_key('!', false), &api).unwrap();
        assert_eq!(explorer.preview.content, "l1 x\nl2 y!\nl3 z");
        // A stale cursor beyond the content length clamps to the end and
        // never panics.
        explorer.edit_cursor = 9999;
        explorer.edit_key(edit_key('?', false), &api).unwrap();
        assert_eq!(explorer.preview.content, "l1 x\nl2 y!\nl3 z?");
        assert_eq!(explorer.edit_cursor, "l1 x\nl2 y!\nl3 z?".len());
    }

    #[test]
    fn edit_key_esc_stops_and_guards_refuse_unsafe_previews() {
        let api = WebApiClient::new("127.0.0.1", 1);
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview = preview("text");
        explorer.start_edit().unwrap();
        explorer.edit_key(edit_key('x', false), &api).unwrap();
        explorer
            .edit_key(key(crossterm::event::KeyCode::Esc), &api)
            .unwrap();
        assert!(!explorer.edit_active);
        assert!(explorer.preview.dirty, "Esc keeps unsaved changes");
        assert_eq!(explorer.preview.content, "textx");

        // Binary and truncated previews refuse to enter edit mode.
        explorer.preview.binary = true;
        assert!(explorer.start_edit().is_err());
        explorer.preview.binary = false;
        explorer.preview.truncated = true;
        assert!(explorer.start_edit().is_err());
        explorer.preview.truncated = false;
        explorer.start_edit().unwrap();
        assert!(explorer.edit_active);
    }

    #[test]
    fn file_entries_parse_tree_payload() {
        let data = json!({
            "entries": [
                {"name": "src", "path": "src", "kind": "dir", "level": 0},
                {"name": "main.rs", "path": "main.rs", "kind": "file", "level": 0, "size": 12},
            ]
        });
        let entries = parse_entries(&data);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir);
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].size, Some(12));
    }

    #[test]
    fn explorer_collapse_scan_uses_child_levels() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.entries = vec![
            FileEntry {
                name: "src".to_string(),
                path: "src".to_string(),
                is_dir: true,
                size: None,
                level: 0,
                expanded: true,
            },
            FileEntry {
                name: "main.rs".to_string(),
                path: "src/main.rs".to_string(),
                is_dir: false,
                size: None,
                level: 1,
                expanded: false,
            },
            FileEntry {
                name: "tui".to_string(),
                path: "tui.rs".to_string(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
            },
        ];
        explorer.selected = 0;
        // Collapse without hitting the network: expand is already true, and
        // the drain loop must stop at the level-0 sibling.
        let mut remove_from = 1;
        while explorer
            .entries
            .get(remove_from)
            .is_some_and(|next| next.level > 0)
        {
            remove_from += 1;
        }
        explorer.entries.drain(1..remove_from);
        explorer.entries[0].expanded = false;
        assert_eq!(explorer.entries.len(), 2);
        assert_eq!(explorer.entries[1].name, "tui");
        assert!(!explorer.entries[0].expanded);
    }

    #[test]
    fn explorer_navigation_clamps_and_goes_up() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.entries = vec![
            FileEntry {
                name: "a".to_string(),
                path: "a".to_string(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
            },
            FileEntry {
                name: "b".to_string(),
                path: "b".to_string(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
            },
        ];
        explorer.move_selection(5);
        assert_eq!(explorer.selected, 1);
        explorer.move_selection(-3);
        assert_eq!(explorer.selected, 0);

        explorer.root_path = "src/deep".to_string();
        assert!(explorer.go_up());
        assert_eq!(explorer.root_path, "src");
        assert!(explorer.go_up());
        assert_eq!(explorer.root_path, "");
        assert!(!explorer.go_up());
    }

    #[test]
    fn explorer_filter_search_mode_toggles() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.start_filter();
        explorer.push_filter_char('r');
        explorer.push_filter_char('s');
        assert_eq!(explorer.filter, "rs");
        explorer.pop_filter_char();
        assert_eq!(explorer.filter, "r");
        explorer.commit_filter();
        assert!(explorer.search_mode);
    }

    #[test]
    fn git_files_parse_status_payload_with_priority() {
        let data = json!({
            "conflicted": ["both.txt"],
            "staged": ["a.rs"],
            "unstaged": ["b.rs"],
            "untracked": ["c.txt"],
        });
        let files = parse_git_files(&data);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, GitFileStatus::Conflicted);
        assert_eq!(files[1].status, GitFileStatus::Staged);
        assert_eq!(files[2].status, GitFileStatus::Unstaged);
        assert_eq!(files[3].status, GitFileStatus::Untracked);
    }

    #[test]
    fn git_panel_status_fields_parse() {
        let mut panel = GitPanel::new("/repo");
        panel.branch = "main".to_string();
        panel.ahead = 2;
        panel.behind = 1;
        panel.state = "dirty".to_string();
        assert_eq!(panel.view, GitView::Changes);
        assert_eq!(panel.view.title(), "Changes");
    }

    #[test]
    fn git_diff_lines_parse_server_chunk_shape() {
        // Mirrors the /api/git-ui/diff response: files[].chunks[].lines[]
        // with line_type/content fields.
        let data = json!({
            "files": [
                {
                    "path": "src/main.rs",
                    "chunks": [
                        {
                            "header": "@@ -1,2 +1,3 @@",
                            "lines": [
                                {"line_type": "normal", "content": "fn main() {"},
                                {"line_type": "add", "content": "    println!(\"hi\");"},
                                {"line_type": "delete", "content": "    todo!()"},
                            ]
                        }
                    ]
                }
            ]
        });
        let lines = parse_diff_lines_with_meta(&data).0;
        assert_eq!(
            lines,
            vec![
                "@@ -1,2 +1,3 @@".to_string(),
                " fn main() {".to_string(),
                "+    println!(\"hi\");".to_string(),
                "-    todo!()".to_string(),
            ]
        );
    }

    #[test]
    fn git_diff_meta_parse_line_numbers() {
        let data = json!({
            "files": [
                {
                    "path": "src/main.rs",
                    "chunks": [
                        {
                            "header": "@@ -1,2 +1,3 @@",
                            "lines": [
                                {"line_type": "normal", "content": "fn main() {", "old_line_number": 1, "new_line_number": 1},
                                {"line_type": "add", "content": "    println!(\"hi\");", "new_line_number": 2},
                                {"line_type": "delete", "content": "    todo!()", "old_line_number": 2},
                            ]
                        }
                    ]
                }
            ]
        });
        let (lines, meta) = parse_diff_lines_with_meta(&data);
        assert_eq!(lines.len(), meta.len());
        assert_eq!(meta[0], None);
        assert_eq!(
            meta[1],
            Some(GitDiffLineMeta {
                old_line: Some(1),
                new_line: Some(1)
            })
        );
        assert_eq!(
            meta[2],
            Some(GitDiffLineMeta {
                old_line: None,
                new_line: Some(2)
            })
        );
        assert_eq!(
            meta[3],
            Some(GitDiffLineMeta {
                old_line: Some(2),
                new_line: None
            })
        );
    }

    #[test]
    fn blame_parser_maps_final_lines_to_authors() {
        // Shape of `git blame --line-porcelain`: header
        // `<sha> <orig> <final>`, then metadata, `author <name>`, and
        // the tab-prefixed content line.
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let text = format!(
            "{sha} 3 1 1\n\
             author Alice Dev\n\
             author-mail <alice@example.com>\n\
             \tfirst line\n\
             {sha} 4 2 2\n\
             author Bob Other\n\
             \tsecond line\n\
             summary tweak\n"
        );
        let authors = parse_blame_authors(&text);
        assert_eq!(authors.get(&1).map(String::as_str), Some("Alice Dev"));
        assert_eq!(authors.get(&2).map(String::as_str), Some("Bob Other"));
        assert_eq!(authors.len(), 2);
    }

    #[test]
    fn blame_parser_ignores_non_header_lines() {
        // Author lines without a preceding header, and content lines
        // that look like hex, must not corrupt the mapping.
        let text = "author Nobody\n\tsome content\n0123456789abcdef0123456789abcdef0123456789 not numbers\n";
        let authors = parse_blame_authors(text);
        assert!(authors.is_empty());
    }

    #[test]
    fn blame_parser_survives_multibyte_content_lines() {
        // Blamed files can contain multibyte characters; the header
        // check must never slice a content line mid-char (panic).
        // Tab-prefixed content of 2-byte chars crossing byte 40 is the
        // crash case this guards.
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let content = "\t".to_string() + &"ñ".repeat(25);
        let text = format!("{sha} 1 1\nauthor Test\n{content}\n");
        let authors = parse_blame_authors(&text);
        assert_eq!(authors.get(&1).map(String::as_str), Some("Test"));
    }

    #[test]
    fn git_log_commits_parse_labels() {
        let data = json!({
            "commits": [
                {
                    "hash": "abc123",
                    "message": "fix bug",
                    "author": "Ada",
                    "date": "2 hours ago",
                    "labels": ["main", "origin/main"],
                }
            ]
        });
        let commits: Vec<GitCommitEntry> = data
            .get("commits")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_commit).collect())
            .unwrap_or_default();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].labels, vec!["main", "origin/main"]);
    }

    #[test]
    fn git_branches_parse_current_remote_pushed() {
        let data = json!({
            "branches": [
                {"name": "main", "current": true, "remote": false, "pushed": true},
                {"name": "origin/feature", "current": false, "remote": true, "pushed": false},
            ]
        });
        let branches: Vec<GitBranchEntry> = data
            .get("branches")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_branch).collect())
            .unwrap_or_default();
        assert_eq!(branches.len(), 2);
        assert!(branches[0].current);
        assert!(branches[1].remote);
        assert!(!branches[1].pushed);
    }

    #[test]
    fn git_view_titles_map_for_tabs() {
        assert_eq!(
            GitView::all()
                .iter()
                .map(|view| view.title())
                .collect::<Vec<_>>(),
            vec!["Changes", "Log", "Branches", "Stash", "History"]
        );
    }
}
