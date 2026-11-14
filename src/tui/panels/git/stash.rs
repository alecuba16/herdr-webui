//! Stash view: list, apply, drop.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{parse_diff_lines_with_meta, parse_stash, GitPanel};

impl GitPanel {
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

    pub fn stash_apply(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let stash = self
            .stashes
            .get(self.stash_selected)
            .map(|entry| entry.name.clone())
            .ok_or_else(|| WebApiError::Io("no stash selected".to_string()))?;
        api.git_stash_apply(&self.cwd, &stash)?;
        self.refresh_view(api)
    }

    /// Load the full diff of the selected stash into the split-right pane
    /// (webui stash view shows the selected stash's diff). Response shape
    /// matches the diff route, so the shared parser applies.
    pub fn load_stash_diff(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let stash = self
            .stashes
            .get(self.stash_selected)
            .map(|entry| entry.name.clone())
            .ok_or_else(|| WebApiError::Io("no stash selected".to_string()))?;
        let data = api.git_stash_show(&self.cwd, &stash)?;
        let (lines, _meta) = parse_diff_lines_with_meta(&data);
        self.stash_diff_lines = lines;
        self.stash_diff_title = stash;
        Ok(())
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

#[cfg(test)]
mod coverage_tests {
    use super::super::GitStashEntry;

    #[test]
    fn stash_actions_require_a_selection() {
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
        let mut panel = crate::tui::panels::GitPanel::new("/repo");
        // No stashes loaded: both guards fire before any api call.
        let err = panel.stash_apply(&api).unwrap_err();
        assert!(err.to_string().contains("no stash selected"));
        let err = panel.stash_drop(&api).unwrap_err();
        assert!(err.to_string().contains("no stash selected"));

        // With a selection the api call runs and fails against the
        // dead endpoint.
        panel.stashes = vec![GitStashEntry {
            name: "stash@{0}".into(),
            message: "wip".into(),
        }];
        panel.stash_selected = 0;
        assert!(panel.stash_apply(&api).is_err());
        assert!(panel.stash_drop(&api).is_err());
    }
}
