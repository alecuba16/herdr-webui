//! Search palette (gap 5): the Ctrl+B `/` overlay that searches
//! workspaces, panels, agents, files and content, webui
//! `searchPalette` parity.
//!
//! Webui behavior mirrored here:
//! - local candidates (workspaces, panels, agents) are scored with the
//!   desktop `searchScore` (exact 0, prefix 1, substring 10+index,
//!   otherwise dropped), sorted by score then title, capped at 12;
//! - navigation always targets a concrete pane/workspace (desktop
//!   rule): Enter on a target result selects the workspace, then the
//!   first pane of its tab so `Enter attach` works on the next key;
//! - file hits reveal the file in the Files screen tree; content hits
//!   open the file preview at the match line.
//!
//! Known deviations from the desktop (documented, deliberate):
//! - the desktop fetches file/content hits on every keystroke with a
//!   180ms debounce (`oninput` → `scheduleSearch`); the TUI fetches
//!   once on Enter commit instead, because a synchronous per-key
//!   web request would stall typing. The Files screen filter already
//!   set this commit-on-Enter precedent;
//! - the desktop pages path results at 100 and content at 50 files;
//!   the palette overlays cap at 12 files and 8 content rows to fit
//!   the 20-row window (Enter commits with the same caps, and the
//!   Files screen search remains the paginated interface).

use serde_json::Value;

use crate::tui::model::{value_str, TuiSnapshot};
use crate::tui::web_api::{WebApiClient, WebApiError};

/// Cap on local candidates (desktop `slice(0, 12)`).
const MAX_LOCAL_RESULTS: usize = 12;
/// Cap on file-search hits shown in the palette.
const MAX_FILE_RESULTS: usize = 12;
/// Cap on content-search files shown in the palette.
const MAX_CONTENT_RESULTS: usize = 8;

/// One palette row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchCandidate {
    /// A workspace: navigation targets the workspace (and its first
    /// pane, so the selection is concrete).
    Workspace { id: String, label: String },
    /// A panel (tab): navigation targets the tab's first pane.
    Panel {
        id: String,
        label: String,
        workspace_id: String,
    },
    /// An agent pane.
    Agent { pane_id: String, label: String },
    /// A file or directory hit from the file search.
    File {
        path: String,
        name: String,
        is_dir: bool,
    },
    /// A content search hit: jump target (file, 1-based line).
    Content {
        file: String,
        line: usize,
        name: String,
    },
}

impl SearchCandidate {
    /// Human-facing label shown in the palette rows.
    pub fn title(&self) -> &str {
        match self {
            SearchCandidate::Workspace { label, .. }
            | SearchCandidate::Panel { label, .. }
            | SearchCandidate::Agent { label, .. } => label,
            SearchCandidate::File { name, .. } | SearchCandidate::Content { name, .. } => name,
        }
    }

    /// Two-letter icon prefix (desktop `ws` / `pn` / `ag`).
    pub fn icon(&self) -> &'static str {
        match self {
            SearchCandidate::Workspace { .. } => "ws",
            SearchCandidate::Panel { .. } => "pn",
            SearchCandidate::Agent { .. } => "ag",
            SearchCandidate::File { is_dir: true, .. } => "dir",
            SearchCandidate::File { .. } => "file",
            SearchCandidate::Content { .. } => "cnt",
        }
    }
}

/// Palette state: query, selected index, and the committed result rows.
#[derive(Debug, Default)]
pub struct SearchPalette {
    /// The query being typed (visible in the palette input line).
    pub query: String,
    /// Index into `results` of the cursor.
    pub selected: usize,
    /// Rows to show; refreshed from local candidates while typing and
    /// extended by file/content hits after an Enter commit.
    pub results: Vec<SearchCandidate>,
    /// True once Enter has committed the query (runs the file/content
    /// fetches and closes local-only live filtering).
    pub committed: bool,
}

impl SearchPalette {
    /// Reset for a fresh open (desktop `createSearchPaletteState`).
    pub fn open(&mut self) {
        self.query.clear();
        self.selected = 0;
        self.results.clear();
        self.committed = false;
    }

    /// Live-filter local candidates (workspaces, panels, agents) while
    /// typing. Desktop scores every candidate against the query with
    /// `searchScore` and keeps the top 12. Any query change drops the
    /// committed state: fetched rows were for the old query, so the
    /// next Enter must re-commit instead of navigating stale results.
    pub fn refresh_local(&mut self, snapshot: &TuiSnapshot) {
        self.results = local_candidates(snapshot, &self.query);
        self.selected = 0;
        self.committed = false;
    }

    /// Type a printable char into the query and re-filter.
    pub fn push_char(&mut self, ch: char, snapshot: &TuiSnapshot) {
        self.query.push(ch);
        self.refresh_local(snapshot);
    }

    /// Backspace the query and re-filter.
    pub fn pop_char(&mut self, snapshot: &TuiSnapshot) {
        self.query.pop();
        self.refresh_local(snapshot);
    }

    /// Ctrl+U clears the query (prompt-input parity).
    pub fn clear_query(&mut self, snapshot: &TuiSnapshot) {
        self.query.clear();
        self.refresh_local(snapshot);
    }

    /// The row under the cursor (Enter on a committed palette
    /// navigates it).
    pub fn selected_candidate(&self) -> Option<&SearchCandidate> {
        self.results.get(self.selected)
    }

    /// Move the cursor, wrapping around the list (desktop
    /// `moveSearchSelection`).
    pub fn move_selection(&mut self, delta: isize) {
        let len = self.results.len();
        if len == 0 {
            self.selected = 0;
            return;
        }
        let current = self.selected.min(len - 1) as isize;
        self.selected = (current + delta).rem_euclid(len as isize) as usize;
    }

    /// File-search commit (desktop path section): runs the tree search
    /// on the active cwd and appends hits below the local candidates.
    pub fn commit_file_search(
        &mut self,
        api: &WebApiClient,
        cwd: &str,
        root: &str,
    ) -> Result<usize, WebApiError> {
        let data = api.file_search(cwd, root, self.query.trim(), 0, MAX_FILE_RESULTS, false)?;
        let mut hits: Vec<SearchCandidate> = parse_file_hits(&data);
        hits.truncate(MAX_FILE_RESULTS);
        self.results.extend(hits);
        Ok(self.results.len())
    }

    /// Content-search commit (desktop content section): runs the
    /// content search and appends the matching files (first match line
    /// as the jump target).
    pub fn commit_content_search(
        &mut self,
        api: &WebApiClient,
        cwd: &str,
        root: &str,
    ) -> Result<usize, WebApiError> {
        let data = api.content_search(
            cwd,
            root,
            self.query.trim(),
            0,
            MAX_CONTENT_RESULTS,
            false,
            false,
        )?;
        let hits = parse_content_hits(&data);
        self.results.extend(hits);
        Ok(self.results.len())
    }
}

/// Desktop `searchScore`: -1 (no match) / 0 (exact) / 1 (prefix) /
/// `10 + indexOf` (substring).
fn search_score(text: &str, needle: &str) -> isize {
    let index = match text.find(needle) {
        Some(index) => index,
        None => return -1,
    };
    if text == needle {
        0
    } else if text.starts_with(needle) {
        1
    } else {
        10 + index as isize
    }
}

/// Collect the local candidates for a query: workspaces, panels, and
/// agents from the snapshot, scored and capped (desktop
/// `searchCandidates`).
fn local_candidates(snapshot: &TuiSnapshot, query: &str) -> Vec<SearchCandidate> {
    // Desktop returns no candidates for an empty query (`if (!needle)
    // return []`): nothing renders until the user types.
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(isize, String, SearchCandidate)> = Vec::new();
    for workspace in &snapshot.workspaces {
        let label = workspace.label.to_lowercase();
        let text = format!("workspace {} {}", label, workspace.id.to_lowercase());
        let score = search_score(&text, &needle);
        if score >= 0 {
            scored.push((
                score,
                workspace.label.clone(),
                SearchCandidate::Workspace {
                    id: workspace.id.clone(),
                    label: workspace.label.clone(),
                },
            ));
        }
    }
    for tab in &snapshot.tabs {
        let label = tab.label.to_lowercase();
        let text = format!("panel {} {}", label, tab.id.to_lowercase());
        let score = search_score(&text, &needle);
        if score >= 0 {
            scored.push((
                score,
                tab.label.clone(),
                SearchCandidate::Panel {
                    id: tab.id.clone(),
                    label: tab.label.clone(),
                    workspace_id: tab.workspace_id.clone(),
                },
            ));
        }
    }
    for agent in &snapshot.agents {
        let label = agent
            .display_agent
            .clone()
            .or_else(|| agent.agent.clone())
            .unwrap_or_else(|| "agent".to_string());
        let text = format!(
            "agent {} {} {}",
            label.to_lowercase(),
            agent.pane_id.to_lowercase(),
            agent.terminal_id.to_lowercase()
        );
        let score = search_score(&text, &needle);
        if score >= 0 {
            scored.push((
                score,
                label.clone(),
                SearchCandidate::Agent {
                    pane_id: agent.pane_id.clone(),
                    label,
                },
            ));
        }
    }
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(MAX_LOCAL_RESULTS)
        .map(|(_, _, candidate)| candidate)
        .collect()
}

fn parse_file_hits(data: &Value) -> Vec<SearchCandidate> {
    data.get("entries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = value_str(item, &["name"])?.to_string();
                    let is_dir = value_str(item, &["kind"]) == Some("dir");
                    let path = value_str(item, &["path"])?.to_string();
                    Some(SearchCandidate::File { path, name, is_dir })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_content_hits(data: &Value) -> Vec<SearchCandidate> {
    data.get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    let path = value_str(file, &["path"])?.to_string();
                    let name = value_str(file, &["name"]).unwrap_or_default().to_string();
                    let line = file
                        .get("matches")
                        .and_then(Value::as_array)
                        .and_then(|matches| matches.first())
                        .and_then(|m| {
                            m.get("line")
                                .and_then(Value::as_u64)
                                .or_else(|| m.get("start_line").and_then(Value::as_u64))
                        })
                        .unwrap_or(1) as usize;
                    Some(SearchCandidate::Content {
                        file: path,
                        line,
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> TuiSnapshot {
        TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [
                    {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                    {"workspace_id":"ws_2","label":"Repo two","cwd":"/two","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_2"}
                ],
                "tabs": [
                    {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"},
                    {"tab_id":"tab_2","workspace_id":"ws_2","label":"Repo shell","focused":false,"pane_count":1,"agent_status":"idle"}
                ],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
            }
        }))
    }

    #[test]
    fn open_resets_and_empty_query_lists_nothing() {
        let snap = snapshot();
        let mut palette = SearchPalette {
            query: "old".to_string(),
            selected: 3,
            committed: true,
            ..Default::default()
        };
        palette.open();
        assert_eq!(palette.query, "");
        assert_eq!(palette.selected, 0);
        assert!(palette.results.is_empty());
        assert!(!palette.committed);
        // An empty query never matches (desktop scores against the
        // typed text, so nothing renders until the user types).
        palette.refresh_local(&snap);
        assert!(palette.results.is_empty());
    }

    #[test]
    fn typing_live_filters_local_candidates() {
        let snap = snapshot();
        let mut palette = SearchPalette::default();
        palette.push_char('r', &snap);
        palette.push_char('e', &snap);
        palette.push_char('p', &snap);
        assert_eq!(palette.query, "rep");
        // "panel repo shell tab_2" (score 10+6) outranks the two
        // "workspace repo ..." workspaces (score 10+10); the agent
        // text ("agent jcode pane_1 term_1") never matches "rep".
        assert_eq!(palette.results.len(), 3, "two workspaces + one tab");
        assert!(matches!(palette.results[0], SearchCandidate::Panel { .. }));
        assert!(matches!(
            palette.results[1],
            SearchCandidate::Workspace { .. }
        ));
        assert!(matches!(
            palette.results[2],
            SearchCandidate::Workspace { .. }
        ));
        // Backspace re-filters and clears the cursor.
        palette.move_selection(1);
        palette.pop_char(&snap);
        assert_eq!(palette.query, "re");
        assert_eq!(palette.selected, 0);
        // Ctrl+U clears.
        palette.clear_query(&snap);
        assert_eq!(palette.query, "");
        assert!(palette.results.is_empty());
    }

    #[test]
    fn scoring_mirrors_desktop_searchscore() {
        assert_eq!(search_score("repo", "repo"), 0);
        assert_eq!(search_score("repo two", "repo"), 1);
        assert_eq!(search_score("workspace repo", "repo"), 10 + 10);
        assert_eq!(search_score("repo", "zzz"), -1);
        // Case folding happens in the callers (both sides lowercase
        // before scoring, like the desktop searchText/needle).
        assert_eq!(search_score("REPO".to_lowercase().as_str(), "repo"), 0);
    }

    #[test]
    fn selection_moves_with_wraparound() {
        let snap = snapshot();
        let mut palette = SearchPalette::default();
        palette.push_char('r', &snap);
        palette.push_char('e', &snap);
        palette.push_char('p', &snap);
        let len = palette.results.len();
        assert_eq!(len, 3);
        palette.move_selection(1);
        assert_eq!(palette.selected, 1);
        palette.move_selection(1);
        assert_eq!(palette.selected, 2, "second to last");
        palette.move_selection(1);
        assert_eq!(palette.selected, 0, "wraps forward");
        palette.move_selection(-1);
        assert_eq!(palette.selected, len - 1, "wraps backwards");
        // On an empty list the cursor stays put.
        palette.results.clear();
        palette.move_selection(1);
        assert_eq!(palette.selected, 0);
    }

    #[test]
    fn parse_file_hits_reads_entries_and_kinds() {
        let data = json!({
            "entries": [
                {"name":"src/","path":"/repo/src","kind":"dir"},
                {"name":"main.rs","path":"/repo/main.rs","kind":"file"},
                {"name":"broken"}
            ]
        });
        let hits = parse_file_hits(&data);
        assert_eq!(hits.len(), 2);
        assert!(
            matches!(&hits[0], SearchCandidate::File { path, is_dir: true, .. } if path == "/repo/src")
        );
        assert!(
            matches!(&hits[1], SearchCandidate::File { path, is_dir: false, .. } if path == "/repo/main.rs")
        );
        // Missing keys drop the row instead of panicking.
        assert!(parse_file_hits(&json!({})).is_empty());
    }

    #[test]
    fn parse_content_hits_takes_the_first_match_line() {
        let data = json!({
            "files": [
                {"path":"/repo/a.rs","name":"a.rs","matches":[{"line":12},{"line":30}]},
                {"path":"/repo/b.rs","name":"b.rs","matches":[{"start_line":7}]},
                {"path":"/repo/c.rs","name":"c.rs"}
            ]
        });
        let hits = parse_content_hits(&data);
        assert_eq!(hits.len(), 3);
        assert!(
            matches!(&hits[0], SearchCandidate::Content { file, line: 12, .. } if file == "/repo/a.rs")
        );
        assert!(matches!(&hits[1], SearchCandidate::Content { line: 7, .. }));
        // No matches at all still yields a row with a safe default.
        assert!(matches!(&hits[2], SearchCandidate::Content { line: 1, .. }));
    }
}
