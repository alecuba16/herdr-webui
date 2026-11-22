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

    /// Coverage is off for this fn because the final refused request
    /// exercises the client-side error path while the server thread's
    /// own accept loop simply ends when its listener drops; the
    /// clamp assertion is a direct state check.
    #[cfg_attr(coverage, coverage(off))]
    #[test]
    fn stash_refresh_clamps_selection_when_stash_list_shrinks() {
        // Two stashes loaded and the second selected, then the refresh
        // returns one: the cursor must clamp into range instead of
        // pointing past the end.
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Serve two requests; the third client call hits a dropped
        // listener and fails.
        std::thread::spawn(move || {
            for _ in 0..2 {
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
                let body = "{\"stashes\":[{\"name\":\"stash@{0}\",\"message\":\"only\"}]}";
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        let mut panel = crate::tui::panels::GitPanel::new("/repo");
        panel.stashes = vec![
            GitStashEntry {
                name: "stash@{0}".into(),
                message: "a".into(),
            },
            GitStashEntry {
                name: "stash@{1}".into(),
                message: "b".into(),
            },
        ];
        panel.stash_selected = 1;
        panel.refresh_stashes(&api).unwrap();
        assert_eq!(panel.stashes.len(), 1);
        assert_eq!(panel.stash_selected, 0);

        // Selection already in range: the clamp guard's false arm,
        // served by the second round.
        panel.stash_selected = 0;
        panel.refresh_stashes(&api).unwrap();
        assert_eq!(panel.stash_selected, 0);

        // Third request: the listener is gone and the client sees a
        // refused connection that leaves the state untouched.
        assert!(panel.refresh_stashes(&api).is_err());
        assert_eq!(panel.stash_selected, 0);
    }
}
