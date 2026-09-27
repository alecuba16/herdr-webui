//! File explorer panel: tree, lazy expansion, filter, preview, edit.

use serde_json::Value;

use crate::tui::model::value_str;
use crate::tui::web_api::{WebApiClient, WebApiError};

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

pub(super) fn parse_entries(data: &Value) -> Vec<FileEntry> {
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

pub(super) fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}
