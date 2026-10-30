use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TuiMode {
    Navigate,
    Attach,
    Help,
    /// Quit confirmation overlay: `y`/Enter quits, `n`/Esc cancels.
    /// All quit paths (Ctrl+B q, plain q, Esc on the Terminal screen)
    /// land here first so nobody leaves the TUI by accident.
    ConfirmQuit,
    /// Settings overlay (webui Settings modal, prefix `S`): read-only
    /// display of the API base, theme mode, refresh interval, and
    /// the git/exploration roots, plus a theme toggle (`t`).
    Settings,
    /// Worktree/workspaces browser overlay (webui worktree open modal,
    /// prefix `W`): discovered worktrees of the selected workspace folder
    /// (fallback: the exploration default/home), j/k moves, Enter opens
    /// through `worktree.open`, Esc closes.
    WorktreeList,
    /// Search palette overlay (webui search palette, prefix `/`):
    /// single-line query over workspaces, panels, agents, files and
    /// content; j/k moves, Enter commits/navigates, Esc closes.
    SearchPalette,
    /// Branch picker overlay (desktop location-bar branch popover,
    /// prefix `v`): local branches of the selected workspace repo with
    /// the current branch pinned first, type-to-filter, j/k cursor.
    /// Enter switches through `git.switch`, or reroutes to the sibling
    /// worktree already holding the branch (`worktree.open`), or
    /// creates the branch when the filter names no existing one.
    BranchPicker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarFocus {
    Workspaces,
    Agents,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiWorkspace {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub focused: bool,
    pub agent_status: String,
    pub pane_count: usize,
    pub tab_count: usize,
    pub active_tab_id: Option<String>,
    /// Git worktree identity of the workspace folder, the client-side
    /// counterpart of the webui `workspace.worktree` stamp. `None` means
    /// the folder is a plain directory or the backend has no data yet,
    /// so callers fall back to pre-stamp rendering.
    pub worktree: Option<TuiWorktreeStamp>,
}

/// Worktree identity for a workspace: which repository the checkout
/// belongs to, whether it is the main checkout or a linked lane, and
/// the checked-out branch. Mirrors the fields the webui wrapper stamps
/// per workspace and the external client protocol carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiWorktreeStamp {
    /// Repository root (main checkout path). Drives the main-vs-linked
    /// call together with the workspace folder itself.
    pub repo_root: String,
    /// Display name of the repository (basename of the root).
    pub repo_name: String,
    /// Checked-out branch, empty when git reports detached HEAD.
    pub branch: String,
    /// True when the workspace folder is a linked worktree checkout
    /// rather than the repository's main working tree.
    pub is_linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiTab {
    pub id: String,
    pub workspace_id: String,
    pub label: String,
    pub focused: bool,
    pub pane_count: usize,
    pub agent_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiPane {
    pub id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub label: Option<String>,
    pub agent: Option<String>,
    pub display_agent: Option<String>,
    pub agent_status: String,
    pub cwd: String,
    pub focused: bool,
    /// Chat-transcript provider state (design section 6, TUI parity):
    /// same wire shape the webui gate reads. None = no provider at all
    /// (shell panes, unsupported agents, old backends without the field)
    /// so the lens gate defaults off and old backends keep working.
    pub agent_session: Option<TuiAgentSession>,
}

/// `agent_session` wire shape, pinned once (design section 6):
/// null | { kind, resolvable, session_id? } | { kind, resolvable: false,
/// reason }. Parsed per-field defensively — no deny_unknown_fields, no
/// typed enum coupling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiAgentSession {
    pub kind: String,
    pub resolvable: bool,
    pub session_id: Option<String>,
    pub reason: Option<String>,
}

impl TuiAgentSession {
    /// The webui `chatSupported()` equivalent: a supported provider kind
    /// with a non-null agent_session. `resolvable: false` still counts as
    /// supported (the user sees the refusal instead of turns).
    pub fn chat_supported(&self) -> bool {
        SUPPORTED_CHAT_AGENTS.contains(&self.kind.as_str())
    }
}

/// Agent kinds with a transcript provider. Mirrors the webui
/// `SUPPORTED_CHAT_AGENTS` set (lens.js).
pub const SUPPORTED_CHAT_AGENTS: &[&str] = &["jcode"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiAgent {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub terminal_id: String,
    pub agent: Option<String>,
    pub display_agent: Option<String>,
    pub status: String,
    pub title: Option<String>,
    pub cwd: String,
    pub focused: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TuiSnapshot {
    pub workspaces: Vec<TuiWorkspace>,
    pub tabs: Vec<TuiTab>,
    pub panes: Vec<TuiPane>,
    pub agents: Vec<TuiAgent>,
}

impl TuiSnapshot {
    pub fn from_backend_response(value: &Value) -> Self {
        let snapshot = value.get("snapshot").unwrap_or(value);
        Self {
            workspaces: parse_array(snapshot, "workspaces", parse_workspace),
            tabs: parse_array(snapshot, "tabs", parse_tab),
            panes: parse_array(snapshot, "panes", parse_pane),
            agents: parse_array(snapshot, "agents", parse_agent),
        }
    }

    pub fn workspace_tabs(&self, workspace_id: &str) -> Vec<&TuiTab> {
        self.tabs
            .iter()
            .filter(|tab| tab.workspace_id == workspace_id)
            .collect()
    }

    pub fn workspace_panes(&self, workspace_id: &str) -> Vec<&TuiPane> {
        self.panes
            .iter()
            .filter(|pane| pane.workspace_id == workspace_id)
            .collect()
    }
}

pub fn snapshot_summary(snapshot: &TuiSnapshot, ping: Option<&Value>) -> String {
    let version = ping
        .and_then(|value| value_str(value, &["version"]))
        .unwrap_or("unknown");
    let protocol = ping
        .and_then(|value| value_u64(value, &["protocol"]))
        .unwrap_or(0);
    format!(
        "Herdr WebUI TUI: backend {version} protocol {protocol}, {} workspaces, {} tabs, {} panes, {} agents",
        snapshot.workspaces.len(),
        snapshot.tabs.len(),
        snapshot.panes.len(),
        snapshot.agents.len()
    )
}

fn parse_array<T>(snapshot: &Value, key: &str, parse: fn(&Value) -> T) -> Vec<T> {
    snapshot
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse).collect())
        .unwrap_or_default()
}

fn parse_workspace(value: &Value) -> TuiWorkspace {
    TuiWorkspace {
        id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        label: value_str(value, &["label"])
            .unwrap_or("Workspace")
            .to_string(),
        cwd: value_str(value, &["cwd", "foreground_cwd"])
            .unwrap_or("")
            .to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
        agent_status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
        pane_count: value_u64(value, &["pane_count"]).unwrap_or(0) as usize,
        tab_count: value_u64(value, &["tab_count"]).unwrap_or(0) as usize,
        active_tab_id: value_str(value, &["active_tab_id"]).map(str::to_string),
        worktree: parse_worktree_stamp(value),
    }
}

/// Parse the `worktree` identity stamp a backend may attach to a
/// workspace row. External sessions and the builtin rows arriving
/// through the webui wrapper carry `{repo_root, repo_name, branch,
/// is_linked_worktree, ...}`. The linked flag from the wire can mark
/// every row linked (the builtin `worktree list` parser cannot tell
/// main from lane), so the trusted call is the folder-vs-root path
/// comparison, identical to the wrapper's rule: a checkout that is not
/// the repository root is a linked lane. Without a repo root the
/// stamp is malformed and stays unparsed (callers render as before).
fn parse_worktree_stamp(workspace: &Value) -> Option<TuiWorktreeStamp> {
    let stamp = workspace.get("worktree")?;
    let repo_root = value_str(stamp, &["repo_root"])?.to_string();
    let checkout_path = value_str(stamp, &["checkout_path", "path"])
        .or_else(|| value_str(workspace, &["cwd"]))?
        .to_string();
    Some(TuiWorktreeStamp {
        repo_name: value_str(stamp, &["repo_name"]).unwrap_or("").to_string(),
        branch: value_str(stamp, &["branch"]).unwrap_or("").to_string(),
        is_linked: !same_checkout_path(&checkout_path, &repo_root),
        repo_root,
    })
}

/// Path equality for git checkouts: exact first, then canonicalized on
/// both sides so a workspace opened through one spelling of a symlinked
/// prefix (/tmp vs /private/tmp on macOS) still matches the path git
/// reports under the other spelling. Canonicalize failures fall back
/// to the exact comparison result.
pub(crate) fn same_checkout_path(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let canonical = |path: &str| std::fs::canonicalize(path).ok();
    match (canonical(left), canonical(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Fold a `worktree.list` reply into the identity stamp for the
/// workspace folder at `cwd`, applying the wrapper's rule: take the
/// row whose checkout is the folder, then call it linked when that
/// checkout is not the repository root the reply's source reports.
/// The main checkout therefore stamps `is_linked == false` even
/// though the builtin row flag says linked for every row (the
/// porcelain parser cannot tell main from lane). A reply whose rows
/// do not name the folder (plain folder, broken git, or a subfolder
/// of a checkout opened as workspace) has no identity to stamp.
///
/// The branch is a plain copy from the row because `worktree list
/// --porcelain` reports the checked-out branch; detached rows keep
/// the empty branch they came with.
pub(crate) fn parse_worktree_list_response(
    response: &Value,
    cwd: &str,
) -> Option<TuiWorktreeStamp> {
    let rows = response.get("worktrees").and_then(Value::as_array)?;
    let repo_root = response
        .pointer("/source/repo_root")
        .and_then(Value::as_str)
        .map(str::to_string);
    let repo_name = response
        .pointer("/source/repo_name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let row = rows.iter().find(|row| {
        row.get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| same_checkout_path(path, cwd))
    })?;
    let checkout_path = row
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(cwd)
        .to_string();
    let branch = row
        .get("branch")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let repo_root = repo_root.unwrap_or_else(|| checkout_path.clone());
    let repo_name = repo_name.unwrap_or_else(|| path_basename(&repo_root));
    let is_linked = !same_checkout_path(&checkout_path, &repo_root);
    Some(TuiWorktreeStamp {
        repo_root,
        repo_name,
        branch,
        is_linked,
    })
}

/// Final path segment: the checkout folder's display name, matching
/// the webui worktree row title fallback (basename of the checkout
/// path).
fn path_basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn parse_tab(value: &Value) -> TuiTab {
    TuiTab {
        id: value_str(value, &["tab_id"])
            .unwrap_or_default()
            .to_string(),
        workspace_id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        label: value_str(value, &["label"]).unwrap_or("Tab").to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
        pane_count: value_u64(value, &["pane_count"]).unwrap_or(0) as usize,
        agent_status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
    }
}

fn parse_pane(value: &Value) -> TuiPane {
    TuiPane {
        id: value_str(value, &["pane_id"])
            .unwrap_or_default()
            .to_string(),
        terminal_id: value_str(value, &["terminal_id"])
            .unwrap_or_default()
            .to_string(),
        workspace_id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        tab_id: value_str(value, &["tab_id"])
            .unwrap_or_default()
            .to_string(),
        label: value_str(value, &["label"]).map(str::to_string),
        agent: value_str(value, &["agent"]).map(str::to_string),
        display_agent: value_str(value, &["display_agent"]).map(str::to_string),
        agent_status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
        cwd: value_str(value, &["foreground_cwd", "cwd"])
            .unwrap_or("")
            .to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
        // Defensive per-field parse (design section 6): absent field ->
        // None (old backends), null -> None, unknown reason strings
        // still parse (reason is only copy text).
        agent_session: value
            .get("agent_session")
            .filter(|session| session.is_object())
            .map(|session| TuiAgentSession {
                kind: value_str(session, &["kind"]).unwrap_or("").to_string(),
                resolvable: session
                    .get("resolvable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                session_id: value_str(session, &["session_id"]).map(str::to_string),
                reason: value_str(session, &["reason"]).map(str::to_string),
            }),
    }
}

fn parse_agent(value: &Value) -> TuiAgent {
    TuiAgent {
        pane_id: value_str(value, &["pane_id"])
            .unwrap_or_default()
            .to_string(),
        workspace_id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        tab_id: value_str(value, &["tab_id"])
            .unwrap_or_default()
            .to_string(),
        terminal_id: value_str(value, &["terminal_id"])
            .unwrap_or_default()
            .to_string(),
        agent: value_str(value, &["agent"]).map(str::to_string),
        display_agent: value_str(value, &["display_agent"]).map(str::to_string),
        status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
        title: value_str(value, &["title", "name"]).map(str::to_string),
        cwd: value_str(value, &["foreground_cwd", "cwd"])
            .unwrap_or("")
            .to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
    }
}

pub(crate) fn value_str<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

pub(crate) fn value_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_u64))
}

fn value_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_bool))
}
