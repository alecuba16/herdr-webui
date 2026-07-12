use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TuiMode {
    Navigate,
    Attach,
    Help,
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
}

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
    }
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
