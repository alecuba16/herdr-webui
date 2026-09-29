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
use std::time::Duration;

use crate::tui::model::{value_str, TuiSnapshot};
use crate::tui::web_api::{WebApiClient, WebApiError};

/// Cap on local candidates (desktop `slice(0, 12)`).
const MAX_LOCAL_RESULTS: usize = 12;
/// Cap on file-search hits shown in the palette.
const MAX_FILE_RESULTS: usize = 12;
/// Cap on content-search files shown in the palette.
const MAX_CONTENT_RESULTS: usize = 8;
/// Cap on recent-workspace rows (desktop `recentWorkspaceCandidates`
/// `slice(0, 8)`).
const MAX_RECENT_RESULTS: usize = 8;
/// Desktop `loadRecent` caches the recents list (including failed
/// loads) for 10s; the palette refetches only outside that window.
const RECENTS_CACHE_TTL: Duration = Duration::from_secs(10);

/// One server-persisted recent workspace (desktop recent-workspaces
/// section, `/api/recent-workspaces`). Path is the reopen target;
/// kind distinguishes workspaces from worktree checkouts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentWorkspace {
    pub path: String,
    pub label: Option<String>,
    pub branch: Option<String>,
    pub kind: Option<String>,
}

impl RecentWorkspace {
    /// Parse one row of the `recent` array from the API response.
    fn from_json(value: &Value) -> Option<Self> {
        let path = value.get("path")?.as_str()?.trim().to_string();
        if path.is_empty() {
            return None;
        }
        let opt = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        Some(Self {
            path,
            label: opt("label"),
            branch: opt("branch"),
            kind: opt("kind"),
        })
    }

    /// Row title: the custom label, else the last path segment, else the
    /// path (desktop `recentWorkspaceCandidates` title rule).
    pub fn title(&self) -> String {
        if let Some(label) = self.label.as_deref() {
            return label.to_string();
        }
        self.path
            .rsplit(['/', '\\'])
            .find(|segment| !segment.is_empty())
            .unwrap_or(self.path.as_str())
            .to_string()
    }

    /// Subtitle: kind, branch, and path joined like the desktop row.
    pub fn subtitle(&self) -> String {
        let kind = match self.kind.as_deref() {
            Some("worktree") => "worktree",
            Some("workspace") => "workspace",
            _ => "workspace",
        };
        [Some(kind), self.branch.as_deref(), Some(self.path.as_str())]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" \u{b7} ")
    }
}

/// Parse the `/api/recent-workspaces` payload. All rows load (the
/// server keeps up to 20); the desktop caps at 8 only after query
/// filtering, so the cap lives in `recent_rows`.
pub fn parse_recent_workspaces(data: &Value) -> Vec<RecentWorkspace> {
    data.get("recent")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(RecentWorkspace::from_json)
                .collect()
        })
        .unwrap_or_default()
}

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
    /// A server-persisted recent workspace (desktop Recent workspaces
    /// section). `is_open` mirrors the desktop disabled state for
    /// entries whose folder is already open in this session; `label` is
    /// the recorded custom label (None keeps the backend naming).
    Recent {
        path: String,
        title: String,
        subtitle: String,
        label: Option<String>,
        is_worktree: bool,
        is_open: bool,
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
            SearchCandidate::Recent { title, .. } => title,
        }
    }

    /// Two-letter icon prefix (desktop `ws` / `pn` / `ag` / `wt`).
    pub fn icon(&self) -> &'static str {
        match self {
            SearchCandidate::Workspace { .. } => "ws",
            SearchCandidate::Panel { .. } => "pn",
            SearchCandidate::Agent { .. } => "ag",
            SearchCandidate::File { is_dir: true, .. } => "dir",
            SearchCandidate::File { .. } => "file",
            SearchCandidate::Content { .. } => "cnt",
            SearchCandidate::Recent { is_worktree, .. } => {
                if *is_worktree {
                    "wt"
                } else {
                    "ws"
                }
            }
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
    /// Server-persisted recent workspaces (desktop Recent workspaces
    /// section), loaded on open and kept until the palette closes.
    pub recents: Vec<RecentWorkspace>,
    /// When the recents fetch last happened (desktop `recentCache`
    /// stamps failed loads too, so a dead server is not retried for
    /// 10s). `None` means no fetch ran yet.
    pub recents_fetched_at: Option<std::time::Instant>,
}

impl SearchPalette {
    /// Reset for a fresh open (desktop `createSearchPaletteState`).
    pub fn open(&mut self) {
        self.query.clear();
        self.selected = 0;
        self.results.clear();
        self.committed = false;
    }

    /// Load the recent workspaces through `/api/recent-workspaces`
    /// (desktop `loadRecent`): a fetch inside the 10s window returns the
    /// cached rows without a request; every other fetch refreshes the
    /// cache, including failed ones (desktop `loadRecent` caches the
    /// empty list on failure too, so a dead server is not hammered on
    /// every palette open). Best effort by design.
    pub fn load_recents(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        if let Some(at) = self.recents_fetched_at {
            if at.elapsed() < RECENTS_CACHE_TTL {
                return Ok(());
            }
        }
        let result = api.recent_workspaces();
        self.recents_fetched_at = Some(std::time::Instant::now());
        let data = result?;
        self.recents = parse_recent_workspaces(&data);
        Ok(())
    }

    /// Drop the recents cache (desktop `invalidateRecent` after an
    /// open/remove/clear so the next palette open refetches).
    pub fn invalidate_recents(&mut self) {
        self.recents_fetched_at = None;
    }

    /// Recent rows for the current query (desktop
    /// `recentWorkspaceCandidates`): subtitle text filters case-
    /// insensitively against the query, capped at 8 AFTER the filter
    /// (so a query can surface entries beyond the first 8 of the
    /// server's 20). `is_open` flags entries whose canonical path
    /// already has an open workspace so they render disabled and
    /// refuse navigation like the desktop.
    pub fn recent_rows(&self, snapshot: &TuiSnapshot) -> Vec<SearchCandidate> {
        let needle = self.query.trim().to_lowercase();
        self.recents
            .iter()
            .filter(|recent| {
                needle.is_empty() || {
                    let haystack =
                        format!("{} {}", recent.title(), recent.subtitle()).to_lowercase();
                    haystack.contains(&needle)
                }
            })
            // Desktop `recentWorkspaceCandidates` slices to 8 AFTER
            // the query filter, so a query can surface entries beyond
            // the first 8 of the server list (up to 20).
            .take(MAX_RECENT_RESULTS)
            .map(|recent| {
                let is_open = snapshot.workspaces.iter().any(|ws| {
                    !ws.cwd.is_empty()
                        && std::path::Path::new(&ws.cwd) == std::path::Path::new(&recent.path)
                });
                SearchCandidate::Recent {
                    path: recent.path.clone(),
                    title: recent.title(),
                    subtitle: recent.subtitle(),
                    label: recent.label.clone(),
                    is_worktree: recent.kind.as_deref() == Some("worktree"),
                    is_open,
                }
            })
            .collect()
    }

    /// Rebuild the results with the recent section placed above the
    /// local candidates (desktop row order: actions, recents, then the
    /// workspace/files/content sections). Only uncommitted palettes
    /// refresh live; after a commit the fetched rows stay until the
    /// query changes or the palette reopens.
    pub fn refresh_local(&mut self, snapshot: &TuiSnapshot) {
        let mut rows = self.recent_rows(snapshot);
        rows.extend(local_candidates(snapshot, &self.query));
        self.results = rows;
        self.selected = 0;
        // Desktop moves the cursor off a disabled row after every
        // render (`renderSearchPalette`): snap to the first
        // selectable row, or 0 when none qualify.
        if self.selected_is_disabled() {
            self.selected = self.selectable_indices().first().copied().unwrap_or(0);
        }
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

    /// Indices Enter can navigate (desktop `selectableSearchResults`
    /// filters out disabled recent rows).
    fn selectable_indices(&self) -> Vec<usize> {
        self.results
            .iter()
            .enumerate()
            .filter(|(_, candidate)| {
                !matches!(candidate, SearchCandidate::Recent { is_open: true, .. })
            })
            .map(|(index, _)| index)
            .collect()
    }

    /// True when the cursor sits on a disabled recent row.
    fn selected_is_disabled(&self) -> bool {
        matches!(
            self.selected_candidate(),
            Some(SearchCandidate::Recent { is_open: true, .. })
        )
    }

    /// Move the cursor, wrapping around the selectable rows (desktop
    /// `moveSearchSelection` skips disabled recents; a cursor parked
    /// on a disabled row behaves like the desktop's -1 `indexOf`, so a
    /// forward move lands on the first selectable row).
    pub fn move_selection(&mut self, delta: isize) {
        let selectable = self.selectable_indices();
        if selectable.is_empty() {
            self.selected = 0;
            return;
        }
        let position = selectable
            .iter()
            .position(|&index| index == self.selected)
            .map(|position| position as isize)
            .unwrap_or(-1);
        let len = selectable.len() as isize;
        let next = (position + delta).rem_euclid(len) as usize;
        self.selected = selectable[next];
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
    fn selection_skips_disabled_recents_like_desktop() {
        // Desktop `moveSearchSelection` walks `selectableSearchResults`
        // (disabled recents filtered) and `renderSearchPalette` snaps
        // the cursor off a disabled row: with a disabled recent at 0
        // and an openable one at 1, the cursor lands on 1 and the
        // arrow keys never visit 0.
        let snap = snapshot();
        let mut palette = SearchPalette {
            recents: vec![
                RecentWorkspace {
                    path: "/repo".to_string(),
                    label: None,
                    branch: None,
                    kind: None,
                },
                RecentWorkspace {
                    path: "/side".to_string(),
                    label: None,
                    branch: None,
                    kind: None,
                },
            ],
            ..SearchPalette::default()
        };
        palette.refresh_local(&snap);
        assert_eq!(palette.selected, 1, "refresh snaps off the disabled row");
        palette.move_selection(1);
        assert_eq!(palette.selected, 1, "single selectable row stays put");
        palette.move_selection(-1);
        assert_eq!(palette.selected, 1);
        // Cursor parked on a disabled row moves like the desktop's
        // `indexOf` -1: forward lands on the first selectable row.
        palette.selected = 0;
        palette.move_selection(1);
        assert_eq!(palette.selected, 1);
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
    fn recent_rows_cap_applies_after_query_filtering() {
        // Desktop slices to 8 AFTER the query filter: with 10 server
        // entries, an empty query shows the first 8, but a query
        // matching only entry 10 still surfaces it.
        let snap = snapshot();
        let recents: Vec<RecentWorkspace> = (0..10)
            .map(|index| RecentWorkspace {
                path: format!("/repo-{index}"),
                label: Some(format!("target-{index}")),
                branch: None,
                kind: None,
            })
            .collect();
        let mut palette = SearchPalette {
            recents,
            ..SearchPalette::default()
        };
        palette.refresh_local(&snap);
        assert_eq!(palette.results.len(), 8, "empty query caps at 8");
        palette.push_char('9', &snap);
        assert_eq!(palette.results.len(), 1, "query reaches beyond the first 8");
        assert!(matches!(
            &palette.results[0],
            SearchCandidate::Recent { path, .. } if path == "/repo-9"
        ));
    }

    #[test]
    fn parse_recent_workspaces_reads_rows_and_drops_broken_entries() {
        let data = json!({
            "recent": [
                {"path":"/repo/main","label":"main repo","branch":"main","kind":"workspace"},
                {"path":"/repo/wt","branch":"feat","kind":"worktree"},
                {"label":"no path"},
                {"path":"   "},
                "not-an-object"
            ]
        });
        let recents = parse_recent_workspaces(&data);
        assert_eq!(recents.len(), 2);
        assert_eq!(recents[0].path, "/repo/main");
        assert_eq!(recents[0].label.as_deref(), Some("main repo"));
        assert_eq!(recents[1].label, None);
        // Titles follow the desktop rule: label first, else the last
        // path segment; the kind falls back to workspace in subtitles.
        assert_eq!(recents[0].title(), "main repo");
        assert_eq!(recents[1].title(), "wt");
        assert!(recents[1].subtitle().contains("worktree"));
        assert!(parse_recent_workspaces(&json!({})).is_empty());
    }

    #[test]
    fn recent_rows_list_above_local_candidates_and_flag_open_paths() {
        let snap = snapshot();
        let mut palette = SearchPalette {
            recents: vec![
                RecentWorkspace {
                    path: "/repo".to_string(),
                    label: None,
                    branch: None,
                    kind: Some("workspace".to_string()),
                },
                RecentWorkspace {
                    path: "/other".to_string(),
                    label: Some("side checkout".to_string()),
                    branch: None,
                    kind: None,
                },
            ],
            ..SearchPalette::default()
        };
        // Empty query: the recent section lists even though the desktop
        // local candidates stay empty until something is typed.
        palette.refresh_local(&snap);
        assert_eq!(palette.results.len(), 2);
        assert!(matches!(
            &palette.results[0],
            SearchCandidate::Recent { is_open: true, .. }
        ));
        assert!(matches!(
            &palette.results[1],
            SearchCandidate::Recent { is_open: false, .. }
        ));

        // Typing filters recents and locals together: "rep" keeps the
        // open /repo recent (disabled rows stay visible like the desktop)
        // plus the matching workspace/panel rows.
        palette.push_char('r', &snap);
        palette.push_char('e', &snap);
        palette.push_char('p', &snap);
        assert!(palette.results.iter().any(|candidate| matches!(
            candidate,
            SearchCandidate::Recent { path, .. } if path == "/repo"
        )));
        assert!(palette
            .results
            .iter()
            .any(|candidate| matches!(candidate, SearchCandidate::Workspace { .. })));
        // The non-matching recent is gone.
        assert!(!palette.results.iter().any(|candidate| matches!(
            candidate,
            SearchCandidate::Recent { path, .. } if path == "/other"
        )));
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
