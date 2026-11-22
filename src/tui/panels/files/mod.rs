//! File explorer panel: tree, lazy expansion, filter, preview, edit.
//! Content search lives in the `content_search` submodule.

pub mod content_search;
pub mod find;

use serde_json::Value;

use crate::tui::model::value_str;
use crate::tui::web_api::{WebApiClient, WebApiError};

pub use content_search::{
    content_rows, run_content_search, ContentRow, ContentSearchChunk, ContentSearchFile,
    ContentSearchRow, ContentSearchState,
};
pub use find::{find_ranges, EditorFind};

/// Which set of things `/` searches. Webui `filterKind` cycles
/// Files → Folders → Content → Files (`nextSearchScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchKind {
    File,
    Dir,
    Content,
}

impl SearchKind {
    pub fn next(self) -> Self {
        match self {
            Self::File => Self::Dir,
            Self::Dir => Self::Content,
            Self::Content => Self::File,
        }
    }

    /// Mirrors the webui file/folder search scope labels.
    pub fn label(self) -> &'static str {
        match self {
            Self::File => "Files",
            Self::Dir => "Folders",
            Self::Content => "Content",
        }
    }
}

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
    /// Git status from the tree payload's `git_status` map
    /// ("modified"/"deleted"/"untracked"/"added"/"conflict"/"changed"),
    /// already priority-propagated to parent dirs by the server
    /// (red > yellow > green > blue in the webui tree).
    pub git_status: Option<String>,
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
    /// What `/` searches: files, folders, or file contents
    /// (webui `filterKind` cycle).
    pub search_kind: SearchKind,
    /// Content search results (webui `HerdrContentSearch` state).
    pub content_search: ContentSearchState,
    pub truncated: bool,
    pub status: Option<String>,
    /// Line to scroll the preview to after a content-search jump
    /// (1-based). Render highlights and centers on this line.
    pub preview_jump_line: Option<usize>,
    /// Editor find bar state (Ctrl+F in edit mode).
    pub editor_find: EditorFind,
    /// Recently opened preview paths, most recent first (Tab cycles).
    pub recent_previews: Vec<String>,
    /// Markdown outline flip (gap 22): when set, the preview pane shows
    /// the header outline (`#`/`##`/… lines indented by level, with the
    /// source line number) instead of the raw source. `M` toggles it,
    /// mirroring the webui eye toggle for markdown files.
    pub markdown_outline: bool,
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
            search_kind: SearchKind::File,
            content_search: ContentSearchState::default(),
            truncated: false,
            status: None,
            preview_jump_line: None,
            editor_find: EditorFind::default(),
            recent_previews: Vec::new(),
            markdown_outline: false,
        }
    }

    pub fn refresh(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        // Content search results live in `content_search` state, not the
        // tree; nothing to fetch here (the render path shows them).
        if self.search_mode && self.search_kind == SearchKind::Content {
            return Ok(());
        }
        let data = if self.search_mode && !self.filter.trim().is_empty() {
            api.file_search(
                &self.cwd,
                &self.root_path,
                self.filter.trim(),
                0,
                200,
                self.search_kind == SearchKind::Dir,
            )?
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
    pub(super) fn open_preview_path(
        &mut self,
        api: &WebApiClient,
        path: &str,
    ) -> Result<(), WebApiError> {
        let data = api.file_read(&self.cwd, path)?;
        let content = data.get("content").and_then(Value::as_str).unwrap_or("");
        let binary = data.get("binary").and_then(Value::as_bool).unwrap_or(false);
        let truncated = data
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // Track the recents stack for Tab cycling (most recent first,
        // deduped like a browser tab history).
        self.recent_previews.retain(|seen| seen != path);
        self.recent_previews.insert(0, path.to_string());
        self.recent_previews.truncate(12);
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

    /// Byte cursor of the line `count` lines away from the cursor's
    /// line, keeping the current column where the target line is long
    /// enough and clamping to its end otherwise. `count` negative = up.
    /// The walk stays on char boundaries: the column advance steps by
    /// whole characters, never by raw bytes.
    fn edit_cursor_line_offset(&self, count: isize) -> usize {
        let content = &self.preview.content;
        let cursor = self.edit_cursor;
        // Line containing the cursor: the last `\n` at or before it,
        // so a cursor sitting on a `\n` itself counts as its line's
        // end, matching how the renderer numbers rows.
        let line_start = content[..cursor].rfind('\n').map_or(0, |i| i + 1);
        let column = content[line_start..cursor].chars().count();
        let mut target_start = line_start;
        let up = count < 0;
        let mut remaining = count.unsigned_abs();
        while remaining > 0 {
            if up {
                if target_start == 0 {
                    break;
                }
                target_start = content[..target_start - 1].rfind('\n').map_or(0, |i| i + 1);
            } else {
                match content[target_start..].find('\n') {
                    Some(i) => target_start = target_start + i + 1,
                    None => break,
                }
            }
            remaining -= 1;
        }
        // Column on the target line: advance by characters until the
        // column is spent or the line (or buffer) ends.
        let mut byte = target_start;
        let mut col = column;
        for ch in content[target_start..].chars() {
            if ch == '\n' || col == 0 {
                break;
            }
            byte += ch.len_utf8();
            col -= 1;
        }
        byte
    }

    /// Handle one key while editing. Returns Err only for save failures;
    /// Ctrl-S saves, Esc stops editing (dirty state is kept). The cursor is
    /// a byte offset into `preview.content`; char-boundary-safe helpers keep
    /// multibyte UTF-8 intact. Enter inserts a line break (crossterm
    /// reports it as `KeyCode::Enter`, not `Char('\n')`), and control- or
    /// alt-modified chars are ignored so Ctrl combos never reach the file.
    /// Up/Down move between lines keeping the column, PageUp/PageDown
    /// jump 10 lines like the rest of the TUI.
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
            KeyCode::Up => {
                self.edit_cursor = self.edit_cursor_line_offset(-1);
            }
            KeyCode::Down => {
                self.edit_cursor = self.edit_cursor_line_offset(1);
            }
            // Page keys follow the TUI convention (10 lines, same as
            // the pane scroll and the lens) instead of a screen-sized
            // jump the editor cannot know.
            KeyCode::PageUp => {
                self.edit_cursor = self.edit_cursor_line_offset(-10);
            }
            KeyCode::PageDown => {
                self.edit_cursor = self.edit_cursor_line_offset(10);
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
        // Jump to the first match: the server returns only matches, and
        // refresh() merely clamps the selection, so without this the
        // cursor would stay wherever it was in the pre-filter tree.
        if self.search_mode {
            self.selected = 0;
        }
    }

    /// Cycle to the next recently opened preview (Tab parity with the
    /// webui's open-file tabs, cheap single-buffer approximation).
    pub fn cycle_recent_preview(&mut self, api: &WebApiClient) -> Result<bool, WebApiError> {
        if self.recent_previews.len() < 2 {
            return Ok(false);
        }
        // A dirty buffer blocks switching files (webui keeps dirty
        // editor tabs open); check before touching the rotation so a
        // blocked switch leaves the recents untouched.
        if self.preview.dirty {
            return Ok(false);
        }
        // Rotate the list: the second entry becomes the front.
        let next = self.recent_previews[1].clone();
        let front = self.recent_previews.remove(0);
        self.recent_previews.insert(0, next.clone());
        self.recent_previews.push(front);
        // Re-dedupe so rotation does not duplicate entries.
        let mut seen = Vec::new();
        self.recent_previews.retain(|path| {
            if seen.contains(path) {
                false
            } else {
                seen.push(path.clone());
                true
            }
        });
        self.preview_jump_line = None;
        self.open_preview_path(api, &next)?;
        Ok(true)
    }

    /// Cycle the `/` search scope (webui `toggleFilterKind`:
    /// Files → Folders → Content). Fresh scope resets results.
    pub fn cycle_search_kind(&mut self) {
        self.search_kind = self.search_kind.next();
        self.content_search.clear_results();
        if self.search_mode && self.search_kind != SearchKind::Content {
            self.selected = 0;
        }
    }

    /// Create a new empty file (webui mobile new-file flow): write an
    /// empty file under the current root via `file_write`, then refresh.
    /// The server creates parent directories as needed.
    pub fn create_file(&mut self, api: &WebApiClient, name: &str) -> Result<(), WebApiError> {
        let path = join_root_path(&self.root_path, name);
        if path.is_empty() {
            return Err(WebApiError::Io("file name is required".to_string()));
        }
        api.file_write_create(&self.cwd, &path, "")?;
        self.refresh(api)?;
        self.select_path(&path);
        Ok(())
    }

    /// Create a new directory. The file-browser API has no mkdir
    /// endpoint, so this writes an empty `.gitkeep` marker inside
    /// (documented deviation: the webui has no new-directory flow at
    /// all; the marker keeps the empty dir visible to git and the tree).
    pub fn create_directory(&mut self, api: &WebApiClient, name: &str) -> Result<(), WebApiError> {
        let dir = join_root_path(&self.root_path, name);
        if dir.is_empty() {
            return Err(WebApiError::Io("directory name is required".to_string()));
        }
        let marker = format!("{dir}/.gitkeep");
        api.file_write_create(&self.cwd, &marker, "")?;
        self.refresh(api)?;
        Ok(())
    }

    /// Select the entry with `path` if visible (used after creating a
    /// file so the cursor lands on it).
    pub fn select_path(&mut self, path: &str) {
        if let Some(index) = self.entries.iter().position(|entry| entry.path == path) {
            self.selected = index;
        }
    }

    /// Reveal `path` in the tree (neovim reveal-current-file, webui
    /// "reveal in tree"): expand every ancestor directory lazily and
    /// land the cursor on the file. `root` here is the explorer's own
    /// `cwd` + `root_path` join, because the git-panel file paths are
    /// relative to the repo root while the tree may be scoped deeper.
    pub fn reveal_path(&mut self, api: &WebApiClient, path: &str) -> Result<(), WebApiError> {
        let clean = path.trim_start_matches('/');
        if clean.is_empty() {
            return Err(WebApiError::Io("no file to reveal".to_string()));
        }
        // Walk ancestor directories in order, expanding each one.
        let mut parts: Vec<&str> = clean.split('/').collect();
        parts.pop(); // the file itself is selected, not expanded
        let mut prefix = String::new();
        for part in parts {
            prefix = if prefix.is_empty() {
                part.to_string()
            } else {
                format!("{prefix}/{part}")
            };
            if let Some(index) = self
                .entries
                .iter()
                .position(|entry| entry.path == prefix && entry.is_dir)
            {
                self.selected = index;
                if !self.entries[index].expanded {
                    self.toggle_expand(api)?;
                }
            } else if self
                .entries
                .iter()
                .any(|entry| entry.is_dir && entry.path.starts_with(&format!("{prefix}/")))
            {
                // The server compacts single-child directories at the
                // top level (e.g. `nested/deep` as one entry), so an
                // ancestor may be absent while its children are
                // already visible: nothing to expand, keep walking.
            } else {
                return Err(WebApiError::Io(format!(
                    "cannot reveal {clean}: {prefix} is not in the tree"
                )));
            }
        }
        self.select_path(clean);
        if self
            .selected_entry()
            .is_none_or(|entry| entry.path != clean)
        {
            return Err(WebApiError::Io(format!(
                "cannot reveal {clean}: not found under {}",
                self.root_path
            )));
        }
        Ok(())
    }

    /// Open `path` at `line` (1-based) in the preview, jumping the
    /// scroll so the line is visible (content-search Enter).
    pub fn open_preview_at_line(
        &mut self,
        api: &WebApiClient,
        path: &str,
        line: usize,
    ) -> Result<(), WebApiError> {
        // Same dirty-buffer guard as opening any other file.
        if self.preview.dirty && self.preview.path.as_deref() != Some(path) {
            return Err(WebApiError::Io(
                "unsaved edits: save or reload before opening another file".to_string(),
            ));
        }
        self.open_preview_path(api, path)?;
        self.preview_jump_line = Some(line.max(1));
        Ok(())
    }

    /// Markdown outline flip (gap 22): `M` on the Files screen toggles
    /// the outline view when the open preview is a markdown file,
    /// mirroring the webui eye toggle. Returns the new state so the
    /// caller can report it; None when no markdown preview is open.
    pub fn toggle_markdown_outline(&mut self) -> Option<bool> {
        let is_markdown = self
            .preview
            .path
            .as_deref()
            .is_some_and(|path| path.ends_with(".md") || path.ends_with(".markdown"));
        if !is_markdown || self.edit_active {
            return None;
        }
        self.markdown_outline = !self.markdown_outline;
        Some(self.markdown_outline)
    }
}

pub use crate::markdown::parse_markdown_outline;

/// Join a typed name under the current root, stripping leading slashes
/// (webui mobile `joinPath`).
fn join_root_path(root: &str, name: &str) -> String {
    let name = name.trim().trim_start_matches('/');
    if name.is_empty() {
        return String::new();
    }
    if root.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), name)
    }
}

pub(super) fn parse_entries(data: &Value) -> Vec<FileEntry> {
    let git_status = data.get("git_status").and_then(Value::as_object);
    data.get("entries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| parse_entry_with_status(item, git_status))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_entry_with_status(
    value: &Value,
    git_status: Option<&serde_json::Map<String, Value>>,
) -> FileEntry {
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
    let path = value_str(value, &["path"]).unwrap_or_default().to_string();
    let git_status = git_status
        .and_then(|map| map.get(&path))
        .and_then(Value::as_str)
        .map(str::to_string);
    FileEntry {
        name: name.to_string(),
        path,
        is_dir,
        size: value.get("size").and_then(Value::as_u64),
        level: value.get("level").and_then(Value::as_u64).unwrap_or(0) as usize,
        expanded: false,
        git_status,
    }
}

pub(super) fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> FileEntry {
        FileEntry {
            name: name.to_string(),
            path: name.to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        }
    }

    #[test]
    fn filter_name_spans_split_matched_substring() {
        use crate::tui::render::filter_name_spans;

        let spans = filter_name_spans("README.md", "read", true);
        // The empty before-span is dropped: only non-empty spans render.
        assert_eq!(
            spans,
            vec![("READ".to_string(), true), ("ME.md".to_string(), false)]
        );

        // Match in the middle keeps both sides.
        let spans = filter_name_spans("main.rs", "in", true);
        assert_eq!(
            spans,
            vec![
                ("ma".to_string(), false),
                ("in".to_string(), true),
                (".rs".to_string(), false)
            ]
        );

        // Whole-name match: matched span only, no empty edges.
        let spans = filter_name_spans("read", "read", true);
        assert_eq!(spans, vec![("read".to_string(), true)]);

        // Multibyte names stay whole after the split.
        let spans = filter_name_spans("ca\u{f1}\u{f3}n.md", "\u{f1}\u{f3}", true);
        assert_eq!(
            spans,
            vec![
                ("ca".to_string(), false),
                ("\u{f1}\u{f3}".to_string(), true),
                ("n.md".to_string(), false)
            ]
        );
    }

    #[test]
    fn filter_name_spans_off_and_no_match_fall_back_to_one_span() {
        use crate::tui::render::filter_name_spans;

        // Highlight off: whole name, unmatched.
        assert_eq!(
            filter_name_spans("README.md", "read", false),
            vec![("README.md".to_string(), false)]
        );
        // Whitespace-only query never highlights (refresh trims it).
        assert_eq!(
            filter_name_spans("README.md", "   ", true),
            vec![("README.md".to_string(), false)]
        );
        // No occurrence in the displayed name: one plain span (server
        // matched on the path).
        assert_eq!(
            filter_name_spans("main.rs", "mod", true),
            vec![("main.rs".to_string(), false)]
        );
    }

    #[test]
    fn commit_filter_jumps_to_first_match() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.entries = vec![entry("design.md"), entry("render.rs"), entry("search.rs")];
        explorer.selected = 2;

        explorer.start_filter();
        for ch in "render".chars() {
            explorer.push_filter_char(ch);
        }
        explorer.commit_filter();
        assert!(explorer.search_mode);
        assert!(!explorer.filter_active);
        assert_eq!(explorer.selected, 0, "commit jumps to the first match");

        // Esc-style cancel (empty query) leaves search mode and keeps
        // the selection where it is: jump-to-first is a commit-only move.
        explorer.selected = 1;
        explorer.filter.clear();
        explorer.commit_filter();
        assert!(!explorer.search_mode);
        assert_eq!(explorer.selected, 1);
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    #[test]
    fn open_preview_at_line_refuses_dirty_buffer_on_a_new_file() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview = FilePreview {
            path: Some("src/old.rs".to_string()),
            content: "unsaved".to_string(),
            truncated: false,
            binary: false,
            hash: "h".to_string(),
            dirty: true,
        };
        // No server needed: the dirty guard fires before any request.
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
        let err = explorer
            .open_preview_at_line(&api, "src/other.rs", 3)
            .unwrap_err();
        assert!(
            err.to_string().contains("unsaved edits"),
            "dirty buffer blocks the jump"
        );
        // Same path jumps even when dirty (reload semantics).
        assert_eq!(explorer.preview.path.as_deref(), Some("src/old.rs"));
    }

    #[test]
    fn cycle_search_kind_resets_selection_outside_content_scope() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.search_mode = true;
        explorer.selected = 4;
        explorer.content_search.files.push(ContentSearchFile {
            path: "a".into(),
            name: "a".into(),
            match_count: 1,
            chunks: vec![],
            truncated: false,
            first_match_line: 1,
        });
        explorer.cycle_search_kind();
        assert_eq!(explorer.search_kind, SearchKind::Dir);
        assert_eq!(explorer.selected, 0, "non-content scope resets cursor");
        assert!(explorer.content_search.files.is_empty());
        // Content scope keeps the cursor (content rows own it).
        explorer.selected = 2;
        explorer.cycle_search_kind();
        assert_eq!(explorer.search_kind, SearchKind::Content);
        assert_eq!(explorer.selected, 2);
    }
}

#[cfg(test)]
mod coverage_tests_round2 {
    use super::*;

    #[test]
    fn create_directory_requires_a_name() {
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
        let mut explorer = FileExplorer::new("/repo");
        // Empty name: guard fires before the api call.
        let err = explorer.create_directory(&api, "  ").unwrap_err();
        assert!(err.to_string().contains("directory name is required"));
    }
}

#[cfg(test)]
mod coverage_tests_round3 {
    use super::*;

    fn files_api_server(body: serde_json::Value) -> crate::tui::web_api::WebApiClient {
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            // Loop: each verb is followed by a tree refresh, so every
            // explorer call needs its own response.
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header
                        .trim()
                        .to_ascii_lowercase()
                        .strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut payload = vec![0u8; content_length];
                if content_length > 0 {
                    use std::io::Read as _;
                    let _ = reader.read_exact(&mut payload);
                }
                let response = body.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                );
            }
        });
        // Probe A: connect, hold, drop without bytes. The hold ensures
        // the server accepted and parked in the request-line read, so
        // the EOF continue arm runs (a pre-accept close can be
        // discarded from the backlog on macOS).
        {
            let probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(probe);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // Probe B: headers without the blank line, held then dropped:
        // the header loop's read_line returns 0 and the EOF break
        // fires mid-headers.
        {
            use std::io::Write as _;
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = probe.write_all(b"POST /probe HTTP/1.1\r\nX-Hang: up");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        crate::tui::web_api::WebApiClient::new("127.0.0.1", port)
    }

    #[test]
    fn create_file_and_directory_succeed_and_refresh_selects_the_new_path() {
        let api = files_api_server(serde_json::json!({
            "entries": [
                {"name": "new.txt", "path": "/repo/new.txt", "is_dir": false}
            ],
            "truncated": false
        }));
        let mut explorer = FileExplorer::new("/repo");
        explorer.create_file(&api, "new.txt").unwrap();
        assert_eq!(explorer.selected, 0, "new file selected after refresh");
        assert!(explorer.status.is_none(), "refresh clears status");

        let mut explorer = FileExplorer::new("/repo");
        explorer.create_directory(&api, "sub").unwrap();
        assert!(explorer.status.is_none(), "refresh clears status");
    }

    #[test]
    fn refresh_clamps_a_stale_selection_past_the_entries() {
        let api = files_api_server(serde_json::json!({
            "entries": [
                {"name": "a.txt", "path": "/repo/a.txt", "is_dir": false}
            ]
        }));
        let mut explorer = FileExplorer::new("/repo");
        explorer.selected = 99;
        explorer.refresh(&api).unwrap();
        assert_eq!(explorer.selected, 0, "selection clamped to the last entry");
    }

    #[test]
    fn refresh_survives_a_probe_connection_that_sends_nothing() {
        use std::io::{BufRead as _, Write as _};
        // files_api_server loops over connections; a probe that opens
        // and drops without a request hits the empty-read continue and
        // the next (real) connection still gets served.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header
                        .trim()
                        .to_ascii_lowercase()
                        .strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                use std::io::Read as _;
                let mut payload = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut payload);
                }
                let body = serde_json::json!({
                    "entries": [
                        {"name": "a.txt", "path": "/repo/a.txt", "is_dir": false}
                    ]
                })
                .to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        // Probe A: connect and hold until the server has accepted and
        // parked in read_line (an immediate close can be discarded from
        // the backlog pre-accept on macOS, never reaching the reader),
        // then drop so the request-line read returns 0: the EOF
        // continue arm.
        let probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        drop(probe);
        std::thread::sleep(std::time::Duration::from_millis(50));
        // Probe B: headers without the terminating blank line, held
        // then dropped: the header loop's read_line returns 0 and the
        // EOF break fires mid-headers.
        {
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nX-Hang: up")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Probe C: a well-formed bodied request so read_exact consumes
        // a real payload; no answer needed.
        {
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        let mut explorer = FileExplorer::new("/repo");
        explorer.refresh(&api).unwrap();
        assert_eq!(explorer.selected, 0);
    }
}
