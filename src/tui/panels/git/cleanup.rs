//! Cleanup view (Phase 2c of `docs/tui-parity-plan.md`).
//!
//! Mirrors the webui `cleanup` tab: scan a root directory for repos with
//! merged branches and stale worktrees, space-toggle entries, and delete
//! the selected entries after a `y` confirm through the cleanup routes.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{CleanupRepo, GitPanel};

/// One selectable row in the cleanup list: a branch or a worktree inside
/// a scanned repo. Paths identify the repo (`repo + kind + name`).
#[derive(Debug, Clone, PartialEq)]
pub struct CleanupItem {
    /// Repo path the item belongs to.
    pub repo: String,
    /// Branch name or worktree path.
    pub name: String,
    pub kind: CleanupItemKind,
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

impl GitPanel {
    /// Scan `root` for cleanup candidates (merged branches, stale
    /// worktrees). Mirrors the webui cleanup scan with the exploration
    /// directory as default root.
    pub fn cleanup_scan(&mut self, api: &WebApiClient, root: &str) -> Result<(), WebApiError> {
        let data = api.git_cleanup_scan(root)?;
        self.cleanup_root = Some(root.to_string());
        self.cleanup_repos = parse_cleanup_repos(&data);
        self.cleanup_selected = 0;
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
                    current: false,
                });
            }
            for worktree in &repo.worktrees {
                items.push(CleanupItem {
                    repo: repo.path.clone(),
                    name: worktree.clone(),
                    kind: CleanupItemKind::Worktree,
                    current: false,
                });
            }
        }
        items
    }

    pub fn selected_cleanup_item(&self) -> Option<CleanupItem> {
        self.cleanup_items().into_iter().nth(self.cleanup_selected)
    }

    /// Delete one cleanup item after the user confirmed. Branches go
    /// through `branch-delete`, worktrees through `worktree-remove`;
    /// after a worktree removal the repo worktree list is re-scanned so
    /// the view reflects the deletion.
    pub fn cleanup_delete(
        &mut self,
        api: &WebApiClient,
        item: &CleanupItem,
    ) -> Result<(), WebApiError> {
        match item.kind {
            CleanupItemKind::Branch => {
                api.git_cleanup_branch_delete(&item.repo, &item.name)?;
            }
            CleanupItemKind::Worktree => {
                api.git_cleanup_worktree_remove(&item.repo, &item.name)?;
                // Re-scan the same root so removed worktrees disappear
                // from the list (branch delete keeps the list; the branch
                // is gone from the repo scan on the next full scan only,
                // so refresh there too for consistency with the webui).
            }
        }
        let root = self
            .cleanup_root
            .clone()
            .unwrap_or_else(|| self.cwd.clone());
        self.cleanup_scan(api, &root)
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
                        .filter_map(|worktree| worktree.get("path").and_then(Value::as_str))
                        .map(str::to_string)
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
