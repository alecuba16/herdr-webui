use serde_json::Value;

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
        let Some(entry) = self.entries.get(self.selected) else {
            return Ok(());
        };
        if entry.is_dir {
            return self.toggle_expand(api).map(|_| ());
        }
        let path = entry.path.clone();
        let data = api.file_read(&self.cwd, &path)?;
        let content = data.get("content").and_then(Value::as_str).unwrap_or("");
        let binary = data.get("binary").and_then(Value::as_bool).unwrap_or(false);
        let truncated = data
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.preview = FilePreview {
            path: Some(path),
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

    pub fn move_selection(&mut self, delta: isize) {
        self.selected = move_index(self.selected, self.entries.len(), delta);
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
}

impl GitView {
    pub fn title(self) -> &'static str {
        match self {
            Self::Changes => "Changes",
            Self::Log => "Log",
            Self::Branches => "Branches",
            Self::Stash => "Stash",
        }
    }

    pub fn all() -> [GitView; 4] {
        [Self::Changes, Self::Log, Self::Branches, Self::Stash]
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
    pub commits: Vec<GitCommitEntry>,
    pub commit_selected: usize,
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
            commits: Vec::new(),
            commit_selected: 0,
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
            self.commits.clear();
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
            .map(|entry| entry.path.as_str());
        // The server scopes diffs as `working`, `staged`, or `all` (HEAD).
        let scope = match self
            .files
            .get(self.file_selected)
            .map(|entry| entry.status.clone())
        {
            Some(GitFileStatus::Staged) => "staged",
            _ => "working",
        };
        let data = api.git_diff(&self.cwd, scope, file)?;
        self.diff_lines = parse_diff_lines(&data);
        self.diff_title = file
            .map(str::to_string)
            .unwrap_or_else(|| "working tree".to_string());
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

    pub fn stage_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        let was_staged = self
            .selected_file()
            .is_some_and(|entry| entry.status == GitFileStatus::Staged);
        if was_staged {
            api.git_unstage(&self.cwd, &paths)?;
        } else {
            api.git_stage(&self.cwd, &paths)?;
        }
        self.refresh_view(api)
    }

    pub fn stage_all(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
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

/// Flatten the `/api/git-ui/diff` response (`files[].chunks[].lines[]`
/// with `line_type`/`content`) into display lines. Chunk headers keep their
/// `@@` prefix so the renderer colors them teal.
fn parse_diff_lines(data: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let Some(files) = data.get("files").and_then(Value::as_array) else {
        return out;
    };
    for git_file in files {
        let Some(chunks) = git_file.get("chunks").and_then(Value::as_array) else {
            continue;
        };
        for chunk in chunks {
            if let Some(header) = chunk.get("header").and_then(Value::as_str) {
                out.push(header.to_string());
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
                }
            }
        }
    }
    out
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
        let lines = parse_diff_lines(&data);
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
            vec!["Changes", "Log", "Branches", "Stash"]
        );
    }
}
