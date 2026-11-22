//! Conflicts view (Phase 2b of `docs/tui-parity-plan.md`).
//!
//! Mirrors the webui `conflicts` tab: conflicted file list with per-file
//! resolve actions (ours/parent/remote/mark) and rebase/merge/cherry-pick
//! continue/skip/abort actions while an operation is in progress.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::GitPanel;

/// Resolve mode for one conflicted file (webui `conflict-resolve` modes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictResolveMode {
    /// `ours`: keep HEAD/current side (`git checkout --ours` + `add`).
    Ours,
    /// `base`: keep the parent/base version (index stage 1).
    Parent,
    /// `theirs`: keep the remote/incoming side (`git checkout --theirs`
    /// + `add`).
    Remote,
    /// `mark`: stage the manually edited file as resolved (`git add`).
    MarkResolved,
}

impl ConflictResolveMode {
    pub fn api_name(self) -> &'static str {
        match self {
            Self::Ours => "ours",
            Self::Parent => "base",
            Self::Remote => "theirs",
            Self::MarkResolved => "mark",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ours => "use HEAD",
            Self::Parent => "use parent",
            Self::Remote => "use remote",
            Self::MarkResolved => "mark resolved",
        }
    }
}

/// Rebase/merge/cherry-pick operation action (webui `conflict-action`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictAction {
    MergeAbort,
    MergeContinue,
    RebaseContinue,
    RebaseSkip,
    RebaseAbort,
    CherryPickContinue,
    CherryPickAbort,
}

impl ConflictAction {
    pub fn api_name(self) -> &'static str {
        match self {
            Self::MergeAbort => "merge-abort",
            Self::MergeContinue => "merge-continue",
            Self::RebaseContinue => "rebase-continue",
            Self::RebaseSkip => "rebase-skip",
            Self::RebaseAbort => "rebase-abort",
            Self::CherryPickContinue => "cherry-pick-continue",
            Self::CherryPickAbort => "cherry-pick-abort",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::MergeAbort => "abort merge",
            Self::MergeContinue => "continue merge",
            Self::RebaseContinue => "continue rebase",
            Self::RebaseSkip => "skip rebase commit",
            Self::RebaseAbort => "abort rebase",
            Self::CherryPickContinue => "continue cherry-pick",
            Self::CherryPickAbort => "abort cherry-pick",
        }
    }
}

impl GitPanel {
    /// Load the conflicts list plus merge/rebase-in-progress flags from
    /// `/api/git-ui/conflicts`.
    pub fn refresh_conflicts(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let data = api.git_conflicts(&self.cwd)?;
        self.conflict_files = data
            .get("files")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        self.merge_in_progress = data.get("merge").and_then(Value::as_bool).unwrap_or(false);
        self.rebase_in_progress = data.get("rebase").and_then(Value::as_bool).unwrap_or(false);
        if self.conflict_selected >= self.conflict_files.len() {
            self.conflict_selected = self.conflict_files.len().saturating_sub(1);
        }
        Ok(())
    }

    pub fn selected_conflict(&self) -> Option<&String> {
        self.conflict_files.get(self.conflict_selected)
    }

    /// Resolve the selected conflicted file with the given mode, then
    /// reload the conflicts list (webui refreshes status after resolve).
    pub fn resolve_selected_conflict(
        &mut self,
        api: &WebApiClient,
        mode: ConflictResolveMode,
    ) -> Result<(), WebApiError> {
        let path = self
            .selected_conflict()
            .cloned()
            .ok_or_else(|| WebApiError::Io("no conflicted file selected".to_string()))?;
        api.git_conflict_resolve(&self.cwd, &path, mode.api_name())?;
        self.refresh_conflicts(api)
    }

    /// Run a rebase/merge/cherry-pick continue/skip/abort action, then
    /// reload the conflicts list.
    pub fn conflict_action(
        &mut self,
        api: &WebApiClient,
        action: ConflictAction,
    ) -> Result<(), WebApiError> {
        api.git_conflict_action(&self.cwd, action.api_name())?;
        self.refresh_conflicts(api)
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    #[test]
    fn conflict_actions_require_a_selection_and_hit_the_api() {
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
        let mut panel = crate::tui::panels::GitPanel::new("/repo");
        // No conflict files: the selection guard fires.
        let err = panel
            .resolve_selected_conflict(&api, ConflictResolveMode::Ours)
            .unwrap_err();
        assert!(err.to_string().contains("no conflicted file selected"));

        // With a file selected the api verb runs against the dead
        // endpoint and fails.
        panel.conflict_files = vec!["a.rs".into()];
        panel.conflict_selected = 0;
        assert!(panel
            .resolve_selected_conflict(&api, ConflictResolveMode::Remote)
            .is_err());

        // Continue/skip/abort verbs also run through the api.
        assert!(panel
            .conflict_action(&api, ConflictAction::MergeContinue)
            .is_err());
        assert!(panel
            .conflict_action(&api, ConflictAction::RebaseSkip)
            .is_err());
        assert!(panel
            .conflict_action(&api, ConflictAction::MergeAbort)
            .is_err());
    }

    /// Coverage is off for this fn because the final refused request
    /// exercises the client-side error path while the server thread's
    /// own accept loop simply ends when its listener drops; the
    /// clamp assertion is a direct state check.
    #[cfg_attr(coverage, coverage(off))]
    #[test]
    fn conflict_refresh_clamps_selection_when_the_list_shrinks() {
        // Two conflicts selected at index 1, the refresh answers with
        // one file: the cursor clamps to 0 and the flags parse.
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
                let body = "{\"files\":[\"a.rs\"],\"merge\":true,\"rebase\":false}";
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        let mut panel = crate::tui::panels::GitPanel::new("/repo");
        panel.conflict_files = vec!["a.rs".into(), "b.rs".into()];
        panel.conflict_selected = 1;
        panel.refresh_conflicts(&api).unwrap();
        assert_eq!(panel.conflict_files, vec!["a.rs".to_string()]);
        assert_eq!(panel.conflict_selected, 0);
        assert!(panel.merge_in_progress);
        assert!(!panel.rebase_in_progress);

        // Selection already in range: the clamp guard's false arm,
        // served by the second round.
        panel.conflict_selected = 0;
        panel.refresh_conflicts(&api).unwrap();
        assert_eq!(panel.conflict_selected, 0);

        // Third request: the listener is gone and the client sees a
        // refused connection that leaves the state untouched.
        assert!(panel.refresh_conflicts(&api).is_err());
        assert_eq!(panel.conflict_selected, 0);
    }
}
