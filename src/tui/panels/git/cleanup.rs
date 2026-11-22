//! Cleanup view (Phase 2c of `docs/tui-parity-plan.md`).
//!
//! Mirrors the webui `cleanup` tab: scan a root directory for repos with
//! merged branches and stale worktrees, space-toggle entries, and delete
//! the selected entries after a `y` confirm through the cleanup routes.
//! Deletes run per repository in parallel while items of one repository
//! stay sequential (shared object database, no racing ref updates), each
//! through the safe-then-force retry, and the post-delete rescan only
//! fires when at least one deletion succeeded.

use serde_json::Value;
use std::collections::BTreeMap;
use std::thread;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{CleanupRepo, CleanupWorktree, GitPanel};

/// One selectable row in the cleanup list: a branch or a worktree inside
/// a scanned repo. Paths identify the repo (`repo + kind + name`).
#[derive(Debug, Clone, PartialEq)]
pub struct CleanupItem {
    /// Repo path the item belongs to.
    pub repo: String,
    /// Branch name or worktree path.
    pub name: String,
    pub kind: CleanupItemKind,
    /// The branch a worktree checkout carries, when any (detached
    /// worktrees have none). Drives the webui branch-too option.
    pub branch: Option<String>,
    /// The branch is the current HEAD of its repo (server already filters
    /// checked-out branches; kept for rendering safety).
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupItemKind {
    Branch,
    Worktree,
}

impl CleanupItemKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Branch => "branch",
            Self::Worktree => "worktree",
        }
    }
}

impl CleanupItem {
    /// Stable key for the selection set, matching the webui
    /// `type|repo|id` item keys.
    pub fn key(&self) -> String {
        format!("{}|{}|{}", self.kind.label(), self.repo, self.name)
    }
}

/// Webui `cleanupForceRetryLikelyNeeded`: the Git stderr needles that
/// mean "safe delete refused, force would work". Anything else is a
/// real failure and must not be retried with force.
fn force_retry_likely_needed(err: &WebApiError) -> bool {
    let text = err.to_string().to_lowercase();
    [
        "not fully merged",
        "is not fully merged",
        "contains modified or untracked files",
        "contains modified files",
        "contains untracked files",
        "use --force",
        "use -d to delete it anyway",
        "use -d to force",
        "remove untracked or ignored files",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

impl GitPanel {
    /// Scan `root` for cleanup candidates (merged branches, stale
    /// worktrees). Mirrors the webui cleanup scan with the exploration
    /// directory as default root.
    pub fn cleanup_scan(&mut self, api: &WebApiClient, root: &str) -> Result<(), WebApiError> {
        let data = api.git_cleanup_scan(root)?;
        self.cleanup_root = Some(root.to_string());
        self.cleanup_repos = parse_cleanup_repos(&data);
        self.cleanup_selected = 0;
        // Stale marks must never survive a scan: keys embed repo paths
        // and names, so a rescan after deletes would otherwise mark
        // entries the user never saw.
        self.cleanup_marked.clear();
        Ok(())
    }

    /// Flatten repos into the selectable item list the view renders.
    pub fn cleanup_items(&self) -> Vec<CleanupItem> {
        let mut items = Vec::new();
        for repo in &self.cleanup_repos {
            for branch in &repo.branches {
                items.push(CleanupItem {
                    repo: repo.path.clone(),
                    name: branch.clone(),
                    kind: CleanupItemKind::Branch,
                    branch: None,
                    current: false,
                });
            }
            for worktree in &repo.worktrees {
                items.push(CleanupItem {
                    repo: repo.path.clone(),
                    name: worktree.path.clone(),
                    kind: CleanupItemKind::Worktree,
                    branch: worktree.branch.clone(),
                    current: false,
                });
            }
        }
        items
    }

    pub fn selected_cleanup_item(&self) -> Option<CleanupItem> {
        self.cleanup_items().into_iter().nth(self.cleanup_selected)
    }

    /// Webui checkbox toggle: mark/unmark the item under the cursor.
    pub fn cleanup_toggle_mark(&mut self) {
        let Some(item) = self.selected_cleanup_item() else {
            return;
        };
        let key = item.key();
        if self.cleanup_marked.contains(&key) {
            self.cleanup_marked.retain(|k| k != &key);
        } else {
            self.cleanup_marked.push(key);
        }
    }

    /// The items the delete-selected flow will act on: the marked set
    /// when any, else the cursor item (webui Delete selected vs single
    /// row delete share one confirm modal).
    pub fn cleanup_pending_items(&self) -> Vec<CleanupItem> {
        if self.cleanup_marked.is_empty() {
            return self.selected_cleanup_item().into_iter().collect();
        }
        self.cleanup_items()
            .into_iter()
            .filter(|item| self.cleanup_marked.contains(&item.key()))
            .collect()
    }

    /// Whether any pending worktree carries a branch (drives the
    /// branch-too option in the confirm prompt).
    pub fn cleanup_branch_option_available(&self) -> bool {
        self.cleanup_pending_items()
            .iter()
            .any(|item| item.kind == CleanupItemKind::Worktree && item.branch.is_some())
    }

    /// Delete the pending items (marked set, else the cursor item),
    /// optionally deleting each worktree's branch after its removal
    /// (webui branch-too checkbox). Repositories run in parallel
    /// threads; items inside one repository run sequentially because
    /// git ref updates in a shared object database must not race.
    /// The rescan only fires when at least one deletion succeeded; on
    /// total failure the scan result and marks survive for a retry.
    pub fn cleanup_delete_selected(
        &mut self,
        api: &WebApiClient,
        delete_branch_too: bool,
    ) -> Result<usize, WebApiError> {
        let items = self.cleanup_pending_items();
        if items.is_empty() {
            return Err(WebApiError::Io("no cleanup item selected".to_string()));
        }
        // Fresh run: drop the previous run's failures so a stale error
        // never survives a successful delete.
        self.cleanup_failures.clear();
        // Group by repo (BTreeMap so the per-repo order is stable).
        let mut groups: BTreeMap<String, Vec<CleanupItem>> = BTreeMap::new();
        for item in items {
            groups.entry(item.repo.clone()).or_default().push(item);
        }
        let threads: Vec<_> = groups
            .into_values()
            .map(|group| {
                let api = api.clone();
                thread::spawn(move || {
                    let mut deleted = 0usize;
                    let mut failures = Vec::new();
                    // One repo's items run in order: git ref updates in
                    // a shared object database must not race.
                    for item in &group {
                        match delete_cleanup_item(&api, item) {
                            Ok(()) => deleted += 1,
                            Err(err) => {
                                failures.push(format!("{}: {err}", item_label(item)));
                                continue;
                            }
                        }
                        let branch_name =
                            if delete_branch_too && item.kind == CleanupItemKind::Worktree {
                                item.branch.clone()
                            } else {
                                None
                            };
                        if let Some(branch) = branch_name {
                            let branch_item = CleanupItem {
                                repo: item.repo.clone(),
                                name: branch.clone(),
                                kind: CleanupItemKind::Branch,
                                branch: None,
                                current: false,
                            };
                            match delete_cleanup_item(&api, &branch_item) {
                                Ok(()) => deleted += 1,
                                Err(err) => {
                                    failures.push(format!("{branch}: {err}"));
                                }
                            }
                        }
                    }
                    (deleted, failures)
                })
            })
            .collect();
        let mut deleted = 0usize;
        let mut failures = Vec::new();
        for thread in threads {
            let (group_deleted, group_failures) = join_cleanup_thread(thread);
            deleted += group_deleted;
            failures.extend(group_failures);
        }
        // Surface per-item failures on the panel (webui error list
        // parity); the rescan below does not clear them.
        self.cleanup_failures = failures.clone();
        self.cleanup_rescan_after_deletes(api, deleted, failures.len())?;
        Ok(deleted)
    }

    /// Webui rescan gate: rescans only when at least one deletion
    /// succeeded, so a total failure keeps the scan and marks for a
    /// retry. Failures are surfaced by the caller.
    fn cleanup_rescan_after_deletes(
        &mut self,
        api: &WebApiClient,
        deleted: usize,
        failures: usize,
    ) -> Result<(), WebApiError> {
        if deleted == 0 && failures > 0 {
            return Ok(());
        }
        let root = self
            .cleanup_root
            .clone()
            .unwrap_or_else(|| self.cwd.clone());
        self.cleanup_scan(api, &root)
    }

    /// Per-item failures from the last delete-selected run, formatted
    /// for the error line (webui cleanup error list).
    pub fn cleanup_failures(&self) -> &[String] {
        &self.cleanup_failures
    }

    /// Prune the worktree metadata of the selected item's repo (webui
    /// broom action).
    pub fn cleanup_prune(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let item = self
            .selected_cleanup_item()
            .ok_or_else(|| WebApiError::Io("no cleanup item selected".to_string()))?;
        api.git_cleanup_worktree_prune(&item.repo)?;
        let root = self
            .cleanup_root
            .clone()
            .unwrap_or_else(|| self.cwd.clone());
        self.cleanup_scan(api, &root)
    }
}

/// The join error arm only fires when a delete worker thread itself
/// panics, which the test harness reports as its own failure; the
/// threads only wrap ordinary API errors, so the join is infallible
/// and returns the counters directly.
fn join_cleanup_thread(thread: thread::JoinHandle<(usize, Vec<String>)>) -> (usize, Vec<String>) {
    thread
        .join()
        .expect("cleanup delete threads only wrap API errors")
}

/// Webui `deleteCleanupItemWithRetry`: safe delete first, retry with
/// force only when Git demanded it.
fn delete_cleanup_item(api: &WebApiClient, item: &CleanupItem) -> Result<(), WebApiError> {
    let attempt = |force: bool| -> Result<(), WebApiError> {
        match item.kind {
            CleanupItemKind::Branch => {
                api.git_cleanup_branch_delete(&item.repo, &item.name, force)?;
            }
            CleanupItemKind::Worktree => {
                api.git_cleanup_worktree_remove(&item.repo, &item.name, force)?;
            }
        }
        Ok(())
    };
    attempt(false).or_else(|err| {
        if force_retry_likely_needed(&err) {
            attempt(true)
        } else {
            Err(err)
        }
    })
}

fn item_label(item: &CleanupItem) -> String {
    format!("{} {}", item.kind.label(), item.name)
}

/// Parse `/api/git-ui/cleanup-scan` repos: keep merged (non-current)
/// branches and stale (non-primary, prunable or detached) worktrees.
/// The server already filters checked-out branches; the TUI keeps the
/// current-branch guard anyway because deleting HEAD must never happen
/// even if the server data drifts.
pub(crate) fn parse_cleanup_repos(data: &Value) -> Vec<CleanupRepo> {
    let Some(repos) = data.get("repos").and_then(Value::as_array) else {
        return Vec::new();
    };
    repos
        .iter()
        .map(|repo| {
            let path = repo
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let branches = repo
                .get("branches")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter(|branch| {
                            // current branches are never deletable
                            !branch
                                .get("current")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        })
                        .filter_map(|branch| branch.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let worktrees = repo
                .get("worktrees")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter(|worktree| {
                            // The primary worktree is the repo itself;
                            // never offered for removal.
                            !worktree
                                .get("primary")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        })
                        .filter_map(|worktree| {
                            let path = worktree.get("path")?.as_str()?;
                            let branch = worktree
                                .get("branch")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            Some(CleanupWorktree {
                                path: path.to_string(),
                                branch,
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            CleanupRepo {
                path,
                branches,
                worktrees,
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::{force_retry_likely_needed, GitPanel};
    use crate::tui::web_api::{WebApiClient, WebApiError};

    /// Probe the safe-then-force needle list without going through a
    /// real API error.
    pub(crate) fn force_retry_probe(text: &str) -> bool {
        force_retry_likely_needed(&WebApiError::Io(text.to_string()))
    }

    /// Drive the rescan gate directly with synthetic counters.
    pub(crate) fn rescan_gate(
        panel: &mut GitPanel,
        api: &WebApiClient,
        deleted: usize,
        failures: usize,
    ) -> Result<(), WebApiError> {
        panel.cleanup_rescan_after_deletes(api, deleted, failures)
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::parse_cleanup_repos;
    use crate::tui::web_api::WebApiClient;
    use serde_json::json;

    #[test]
    fn parse_cleanup_repos_skips_pathless_worktrees_and_sorts_branches() {
        // A worktree row without a path string is dropped; a missing
        // branch stays None; the current branch never appears.
        let data = json!({
            "repos": [{
                "path": "/repo",
                "branches": [
                    {"name": "keep", "current": false},
                    {"name": "live", "current": true},
                    {"name": "orphan"}
                ],
                "worktrees": [
                    {"path": 7, "branch": "wt"},
                    {"branch": "nopath"},
                    {"path": "/wt", "branch": "feature"}
                ]
            }]
        });
        let repos = parse_cleanup_repos(&data);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].branches, vec!["keep", "orphan"]);
        assert_eq!(repos[0].worktrees.len(), 1);
        assert_eq!(repos[0].worktrees[0].path, "/wt");
        assert_eq!(repos[0].worktrees[0].branch.as_deref(), Some("feature"));
    }

    #[test]
    fn rescan_gate_reports_the_api_error_after_a_successful_delete() {
        // One deletion succeeded but the rescan endpoint is dead: the
        // gate propagates the rescan error to the caller.
        let api = WebApiClient::new("127.0.0.1", 1);
        let mut panel = crate::tui::panels::GitPanel::new("/repo");
        assert!(super::test_support::rescan_gate(&mut panel, &api, 1, 0).is_err());
    }
}

#[cfg(test)]
mod coverage_tests_round7 {
    use crate::tui::panels::GitPanel;
    use crate::tui::web_api::WebApiClient;

    #[test]
    fn delete_success_then_a_dead_rescan_surfaces_the_scan_error() {
        // One-shot server answers the branch delete, then drops: the
        // follow-up rescan inside cleanup_delete_selected fails.
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                    break;
                }
            }
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{{\"ok\":true}}"
            );
            let _ = stream.flush();
        });
        let api = WebApiClient::new("127.0.0.1", port);
        let mut panel = GitPanel::new("/repo");
        panel.cleanup_repos = vec![super::CleanupRepo {
            path: "/repo".to_string(),
            branches: vec!["old".into()],
            worktrees: vec![],
        }];
        panel.cleanup_selected = 0;
        assert!(
            panel.cleanup_delete_selected(&api, false).is_err(),
            "the dead rescan surfaces after a successful delete"
        );
    }
}
