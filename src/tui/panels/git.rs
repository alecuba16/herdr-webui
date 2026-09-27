//! Git management panel: changes, log, branches, stash, history views.

use serde_json::Value;
use std::collections::HashMap;

use crate::tui::model::value_str;
use crate::tui::web_api::{WebApiClient, WebApiError};

use super::files::move_index;

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
        self.diff_title = file.clone().unwrap_or_else(|| "working tree".to_string());
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
pub(super) fn parse_blame_authors(text: &str) -> HashMap<usize, String> {
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
pub(super) fn parse_diff_lines_with_meta(
    data: &Value,
) -> (Vec<String>, Vec<Option<GitDiffLineMeta>>) {
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
                        old_line: line
                            .get("old_line_number")
                            .and_then(Value::as_u64)
                            .map(|v| v as usize),
                        new_line: line
                            .get("new_line_number")
                            .and_then(Value::as_u64)
                            .map(|v| v as usize),
                    }));
                }
            }
        }
    }
    (out, meta)
}

pub(super) fn parse_git_files(data: &Value) -> Vec<GitFileEntry> {
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

pub(super) fn parse_commit(value: &Value) -> GitCommitEntry {
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

pub(super) fn parse_branch(value: &Value) -> GitBranchEntry {
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

pub(super) fn parse_stash(value: &Value) -> GitStashEntry {
    GitStashEntry {
        name: value_str(value, &["name", "stash"])
            .unwrap_or_default()
            .to_string(),
        message: value_str(value, &["message", "subject"])
            .unwrap_or_default()
            .to_string(),
    }
}
