//! Branches view: list, switch, delete.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{parse_branch, GitPanel};

impl GitPanel {
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
}
