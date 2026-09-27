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
