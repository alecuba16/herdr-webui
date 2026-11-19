use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::server_settings::atomic_write;
use crate::WebState;

/// Shared panel/group model for one herdr session, owned by the webui
/// server (docs/ux/shared-panes-design.md). The client bundle keeps
/// gestures and rendering; every record and invariant lives here so all
/// clients connected to the same session converge on one truth.
///
/// Entry shape mirrors the v3 client blob: flat `panels` (each a leaf
/// with tabs/active/wsId/groupId and an optional custom `name`), a
/// `groups` list carrying ordered memberIds plus a row/column layout
/// tree, and a `visible` pointer naming the last writer's subject.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanesEntry {
    pub v: u32,
    #[serde(default)]
    pub panels: Vec<PanelRecord>,
    #[serde(default)]
    pub groups: Vec<GroupRecord>,
    #[serde(default)]
    pub visible: VisiblePointer,
    #[serde(default)]
    pub active_pane_id: Option<String>,
    #[serde(default)]
    pub at: u64,
    #[serde(default)]
    pub next_pane_seq: u64,
    #[serde(default)]
    pub next_group_seq: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisiblePointer {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRecord {
    /// Wire marker the client blob carries (isPaneLeaf requires it).
    /// Healed to "pane" in normalize_entry: a missing or stray value
    /// must never survive into the stored or broadcast entry.
    #[serde(default = "panel_kind_pane")]
    pub kind: String,
    pub pane_id: String,
    #[serde(default)]
    pub tabs: Vec<String>,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub ws_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Custom rail label. None means "derive from tabs/workspace".
    #[serde(default)]
    pub name: Option<String>,
}

fn panel_kind_pane() -> String {
    "pane".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub group_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub member_ids: Vec<String>,
    /// paneId strings or nested {kind, sizes, children} trees. Kept as
    /// raw JSON: the layout shape is a wire contract with the client
    /// renderer, not a server-side enum.
    #[serde(default)]
    pub layout: Value,
    /// Last member this session's split view focused. Groups persist
    /// (survive subject switches as rail chips), so the record carries
    /// the member to restore when the group chip reopens the split.
    /// Healed to None when the named panel is gone.
    #[serde(default)]
    pub focused_pane_id: Option<String>,
}

/// Per-session stores plus the server-wide broadcast channel. Loaded
/// lazily from `panes-<session>.json` sidecars; every mutation persists
/// and broadcasts a full entry snapshot.
pub struct PanesStore {
    pub sessions: Mutex<HashMap<String, PanesEntry>>,
    pub tx: tokio::sync::broadcast::Sender<Value>,
    /// Serializes sidecar writes. save_entry runs OUTSIDE the sessions
    /// mutex on blocking threads, and atomic_write stages every payload
    /// through one shared temp path (panes-<session>.new): two
    /// concurrent saves rename the same temp away, so the loser fails
    /// with ENOENT and the client sees a 500. One lock for all sessions
    /// because the collision is on the sibling temp name, not the
    /// session file itself.
    pub save_lock: Mutex<()>,
}

impl PanesStore {
    pub fn new() -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            tx,
            save_lock: Mutex::new(()),
        })
    }
}

const ENTRY_VERSION: u32 = 3;
const MAX_TABS_PER_PANEL: usize = 200;
const MAX_NAME_CHARS: usize = 120;

// Array caps: entries arrive as full client blobs, and normalize must
// bound what one POST can leave in memory and on disk. 64 panels is
// generous for a human rail (the v3 UI struggles past ~20 chips) yet
// keeps a hostile 2MB body (axum's default limit) from parking tens of
// thousands of records in the store and rewriting them per mutation.
const MAX_PANELS: usize = 64;
const MAX_GROUPS: usize = 64;

/// Sidecar path for one session's shared panes entry. The herdr-webui
/// config dir (next to webui-settings.json) so XDG_CONFIG_HOME keeps
/// test isolation working; the session name rides the file name.
fn panes_sidecar_path(session: &str) -> PathBuf {
    let base = if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(dir).join("herdr-webui")
    } else {
        std::env::var("HOME")
            .map(|home| PathBuf::from(home).join(".config/herdr-webui"))
            .unwrap_or_else(|_| std::env::temp_dir().join("herdr-webui"))
    };
    let safe: String = session
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    base.join(format!("panes-{safe}.json"))
}

fn load_entry(session: &str) -> PanesEntry {
    let Ok(raw) = fs::read_to_string(panes_sidecar_path(session)) else {
        return default_entry();
    };
    serde_json::from_str(&raw).unwrap_or_else(|err| {
        eprintln!("invalid webui-panes.json for session {session}, starting fresh: {err}");
        // Park the corrupt bytes next to the sidecar before the reset
        // overwrites them: a hand-edit or a partial atomic write is
        // recoverable from the .bak, and silent loss makes the reset
        // impossible to audit. Best effort only; a failed rename must
        // not block the fresh start.
        let mut bak = panes_sidecar_path(session);
        bak.set_extension("json.bak");
        let _ = fs::write(&bak, &raw);
        default_entry()
    })
}

fn save_entry(session: &str, entry: &PanesEntry) -> io::Result<()> {
    let path = panes_sidecar_path(session);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string(entry)?;
    atomic_write(&path, payload.as_bytes())
}

fn default_entry() -> PanesEntry {
    PanesEntry {
        v: ENTRY_VERSION,
        panels: vec![PanelRecord {
            kind: "pane".to_string(),
            pane_id: "p1".to_string(),
            tabs: vec![],
            active: None,
            ws_id: None,
            group_id: None,
            name: None,
        }],
        groups: vec![],
        visible: VisiblePointer {
            kind: "panel".to_string(),
            id: "p1".to_string(),
        },
        active_pane_id: None,
        at: crate::unix_now_seconds(),
        next_pane_seq: 2,
        next_group_seq: 1,
    }
}

fn entry_is_seed(entry: &PanesEntry) -> bool {
    // The untouched default: one empty unbound panel and nothing else.
    // A client with real content always wins over the seed.
    entry.panels.len() == 1
        && entry.panels[0].tabs.is_empty()
        && entry.panels[0].ws_id.is_none()
        && entry.panels[0].group_id.is_none()
        && entry.panels[0].pane_id == "p1"
        && entry.groups.is_empty()
}

fn panel_index(entry: &PanesEntry, pane_id: &str) -> Option<usize> {
    entry.panels.iter().position(|p| p.pane_id == pane_id)
}

fn group_index(entry: &PanesEntry, group_id: &str) -> Option<usize> {
    entry.groups.iter().position(|g| g.group_id == group_id)
}

fn live_members(entry: &PanesEntry, group: &GroupRecord) -> Vec<String> {
    group
        .member_ids
        .iter()
        .filter(|id| panel_index(entry, id).is_some())
        .cloned()
        .collect()
}

fn layout_holds(node: &Value, pane_id: &str) -> bool {
    if node.as_str() == Some(pane_id) {
        return true;
    }
    let Some(children) = node.get("children").and_then(Value::as_array) else {
        return false;
    };
    children.iter().any(|child| layout_holds(child, pane_id))
}

fn collect_layout_ids(node: &Value, out: &mut Vec<String>) {
    if let Some(id) = node.as_str() {
        out.push(id.to_string());
        return;
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            collect_layout_ids(child, out);
        }
    }
}

/// Layout surgery, mirroring the client's memberLayoutWithout: drop the
/// paneId from the tree; a split under two children collapses to its
/// survivor, the root collapsing to one child returns that child. A
/// degraded FLAT array filters the id directly (the client twin keeps
/// the array shape, even one member long: normalize only rebuilds a
/// layout that loses members, and a survivor must not read as lost).
fn layout_without(node: &Value, pane_id: &str) -> Option<Value> {
    match node {
        Value::String(id) => (id != pane_id).then(|| node.clone()),
        Value::Null => None,
        Value::Array(items) => {
            let kept: Vec<Value> = items
                .iter()
                .filter(|child| child.as_str() != Some(pane_id))
                .cloned()
                .collect();
            (!kept.is_empty()).then(|| Value::Array(kept))
        }
        _ => {
            let children = node.get("children").and_then(Value::as_array)?;
            let mut kept: Vec<Value> = Vec::new();
            for child in children {
                if let Some(kept_child) = layout_without(child, pane_id) {
                    kept.push(kept_child);
                }
            }
            match kept.len() {
                0 => None,
                1 => Some(kept.remove(0)),
                _ => {
                    let mut next = node.clone();
                    let sizes = next.get("sizes").and_then(Value::as_array).cloned();
                    let sizes = sizes.unwrap_or_default();
                    let next_sizes: Vec<Value> = kept
                        .iter()
                        .enumerate()
                        .map(|(i, _)| {
                            sizes
                                .get(i)
                                .and_then(Value::as_f64)
                                .filter(|v| *v > 0.0)
                                .map(|v| serde_json::json!(v))
                                .unwrap_or(serde_json::json!(1))
                        })
                        .collect();
                    next["children"] = Value::Array(kept);
                    next["sizes"] = Value::Array(next_sizes);
                    Some(next)
                }
            }
        }
    }
}

/// Layout insertion, mirroring the client's layoutWithPanelAt: the new
/// paneId lands at the quadrant the client named, relative to the host
/// pane under the pointer. Same-kind hosts extend, other-kind hosts
/// nest.
fn layout_with_panel_at(
    layout: &Value,
    pane_id: &str,
    axis: &str,
    first: bool,
    host_id: Option<&str>,
) -> Value {
    // A one-child split violates the client contract (isPaneSplit needs
    // >= 2 children): a single pane collapses to a bare leaf string.
    let flat_children = |ids: Vec<String>| -> Value {
        if ids.len() == 1 {
            return Value::String(ids.into_iter().next().expect("one id"));
        }
        serde_json::json!({
            "kind": axis,
            "sizes": ids.iter().map(|_| serde_json::json!(1)).collect::<Vec<_>>(),
            "children": ids,
        })
    };
    if !layout.get("children").and_then(Value::as_array).is_some() {
        // Flat or degraded layout: rebuild as a flat split. Array
        // layouts keep their members (the client twin slices the
        // array; dropping them would strand live members out of the
        // layout until normalize rebuilt it from memberIds).
        let mut ids: Vec<String> = Vec::new();
        if let Some(items) = layout.as_array() {
            for item in items {
                if let Some(id) = item.as_str() {
                    if id != pane_id {
                        ids.push(id.to_string());
                    }
                }
            }
        } else if let Some(id) = layout.as_str() {
            if id != pane_id {
                ids.push(id.to_string());
            }
        }
        if first {
            ids.insert(0, pane_id.to_string());
        } else {
            ids.push(pane_id.to_string());
        }
        return flat_children(ids);
    }
    let mut host_ids: Vec<String> = Vec::new();
    collect_layout_ids(layout, &mut host_ids);
    let host = host_id
        .filter(|id| host_ids.iter().any(|live| live == id))
        .or_else(|| host_ids.first().map(String::as_str));
    let Some(host) = host else {
        let mut ids = host_ids;
        ids.retain(|id| id != pane_id);
        if first {
            ids.insert(0, pane_id.to_string());
        } else {
            ids.push(pane_id.to_string());
        }
        return flat_children(ids);
    };
    let mut next = layout.clone();
    if insert_at_host(&mut next, host, pane_id, axis, first) {
        return next;
    }
    // Host not reachable (corrupt tree): rebuild flat.
    let mut ids = host_ids;
    ids.retain(|id| id != pane_id);
    if first {
        ids.insert(0, pane_id.to_string());
    } else {
        ids.push(pane_id.to_string());
    }
    flat_children(ids)
}

/// Insert paneId beside the host pane inside the tree, in place. Returns
/// false when the host cannot be found.
fn insert_at_host(node: &mut Value, host: &str, pane_id: &str, axis: &str, first: bool) -> bool {
    // Clone-out, mutate, write-back: the same-axis branch reads sizes
    // while children is borrowed, which the borrow checker rejects on
    // in-place mutation.
    let Some(children) = node.get("children").and_then(Value::as_array).cloned() else {
        return false;
    };
    let kind = node.get("kind").and_then(Value::as_str).unwrap_or("");
    let sizes = node.get("sizes").and_then(Value::as_array).cloned();
    let mut children = children;
    let mut sizes = sizes.unwrap_or_default();
    for i in 0..children.len() {
        if children[i].as_str() == Some(host) {
            if kind == axis {
                // Extend the same-axis parent at the host index. Halving
                // mirrors the client: the pair keeps the host's old
                // total, so repeated grows never inflate the row.
                let at = if first { i } else { i + 1 };
                let share = sizes
                    .get(i)
                    .and_then(Value::as_f64)
                    .filter(|v| *v > 0.0)
                    .unwrap_or(1.0);
                let half = share / 2.0;
                children.insert(at, serde_json::json!(pane_id));
                while sizes.len() < children.len() {
                    sizes.push(serde_json::json!(1));
                }
                sizes[i] = serde_json::json!(half);
                sizes.insert(at, serde_json::json!(half));
                node["children"] = Value::Array(children);
                node["sizes"] = Value::Array(sizes);
            } else {
                // Nest under the host.
                let host_value = children[i].clone();
                let nested = if first {
                    serde_json::json!({
                        "kind": axis,
                        "sizes": [1, 1],
                        "children": [pane_id, host_value],
                    })
                } else {
                    serde_json::json!({
                        "kind": axis,
                        "sizes": [1, 1],
                        "children": [host_value, pane_id],
                    })
                };
                children[i] = nested;
                node["children"] = Value::Array(children);
            }
            return true;
        }
        if insert_at_host(&mut children[i], host, pane_id, axis, first) {
            node["children"] = Value::Array(children);
            return true;
        }
    }
    false
}

fn heal_visible(entry: &mut PanesEntry) {
    if !entry.panels.is_empty() {
        // Group pointer survives only with >= 2 live members.
        if entry.visible.kind == "group" {
            if let Some(group) = entry.groups.iter().find(|g| g.group_id == entry.visible.id) {
                if live_members(entry, group).len() >= 2 {
                    return;
                }
            }
        }
        // Panel pointer survives when it names a live panel.
        if entry.visible.kind == "panel" && panel_index(entry, &entry.visible.id).is_some() {
            return;
        }
        let fallback = entry
            .panels
            .iter()
            .find(|p| p.group_id.is_none())
            .or_else(|| entry.panels.first());
        if let Some(fallback) = fallback {
            entry.visible = VisiblePointer {
                kind: "panel".to_string(),
                id: fallback.pane_id.clone(),
            };
        }
    }
}

/// Dissolve every group under two live members, mirroring the client
/// sweep's group half.
fn dissolve_undersized_groups(entry: &mut PanesEntry) {
    let group_ids: Vec<String> = entry
        .groups
        .iter()
        .filter(|g| live_members(entry, g).len() < 2)
        .map(|g| g.group_id.clone())
        .collect();
    for group_id in group_ids {
        if let Some(at) = entry.groups.iter().position(|g| g.group_id == group_id) {
            let group = entry.groups.remove(at);
            // Surviving member heals the visible pointer while the
            // record still names it: dissolve runs on close/ungroup
            // paths where the group was the subject, and the survivor
            // is a live panel so heal_visible keeps it.
            if entry.visible.kind == "group" && entry.visible.id == group.group_id {
                let survivor = live_members(entry, &group)
                    .first()
                    .map(|id| ("panel".to_string(), id.clone()));
                if let Some((kind, id)) = survivor {
                    entry.visible.kind = kind;
                    entry.visible.id = id;
                }
            }
            for id in &group.member_ids {
                if let Some(panel) = entry.panels.iter_mut().find(|p| &p.pane_id == id) {
                    panel.group_id = None;
                }
            }
        }
    }
}

/// Normalize a client-supplied entry: keep only live panels and groups,
/// force group/panel agreement, heal the visible pointer. Mirrors the
/// client's normalizePanelEntry contract so the migration apply can
/// trust incoming blobs only so far.
fn normalize_entry(entry: &mut PanesEntry) {
    entry.v = ENTRY_VERSION;
    // Panel ids must be unique and non-empty; dedupe keeps the first.
    let mut seen: HashSet<String> = HashSet::new();
    entry.panels.retain(|p| {
        // Id charset whitelist: ids flow into inline onclick handlers
        // as single-quoted JS strings (encodeURIComponent leaves ' and
        // a few mark chars intact, escapeAttr does not stop the HTML
        // parser from decoding &#39; back to ' before JS parsing). A
        // poisoned id from a full-entry apply is therefore an XSS
        // vector in every client that renders the session, so anything
        // outside [A-Za-z0-9_-] is dropped here at the source; the
        // client renders what the server normalized, and future
        // clients inherit the guarantee for free. Dropping (not
        // regenerating) is the smaller and safer move: the rail shows
        // the surviving panels instead of silently forking a record's
        // identity under a fresh server-minted id, and the same
        // drop-dead-records philosophy already governs group members
        // (live_members) and stale visible pointers (heal_visible).
        p.pane_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !p.pane_id.is_empty()
            && seen.insert(p.pane_id.clone())
    });
    // Same cap logic as tabs: oversized arrays truncate, the rest of
    // normalize (group dissolve, visible heal) sweeps the fallout.
    if entry.panels.len() > MAX_PANELS {
        entry.panels.truncate(MAX_PANELS);
    }
    for panel in entry.panels.iter_mut() {
        if panel.tabs.len() > MAX_TABS_PER_PANEL {
            panel.tabs.truncate(MAX_TABS_PER_PANEL);
        }
        // Names normalize to trimmed non-empty strings under the length
        // cap; anything else clears back to the derived label.
        panel.name = panel
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty() && name.chars().count() <= MAX_NAME_CHARS)
            .map(str::to_string);
        // Panel kind heal: the client's isPaneLeaf requires kind ===
        // "pane"; a missing or non-"pane" value coerces back the same
        // way the seq counters heal.
        panel.kind = "pane".to_string();
    }
    let mut groups: Vec<GroupRecord> = Vec::new();
    let drained: Vec<GroupRecord> = std::mem::take(&mut entry.groups);
    for group in drained {
        let Some(record) = normalize_group(entry, group) else {
            continue;
        };
        groups.push(record);
    }
    entry.groups = groups;
    // Group ids must be unique; dedupe keeps the first.
    let mut seen_groups: HashSet<String> = HashSet::new();
    entry.groups.retain(|g| {
        // Same charset whitelist as pane ids: group ids ride the same
        // inline-handler sinks (startPaneGroupRename('ENC')).
        g.group_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !g.group_id.is_empty()
            && seen_groups.insert(g.group_id.clone())
    });
    if entry.groups.len() > MAX_GROUPS {
        entry.groups.truncate(MAX_GROUPS);
    }
    // Persistent groups: every well-formed group record survives
    // regardless of the visible subject. The sweep only enforces
    // agreement: a panel whose groupId names no kept group loses it
    // (orphaned by a record that normalize_group dropped for dead
    // members), and members listed by a kept record regain their
    // groupId so client blobs cannot strand a member ungrouped while
    // the record still holds it.
    let kept: HashSet<String> = entry.groups.iter().map(|g| g.group_id.clone()).collect();
    for panel in entry.panels.iter_mut() {
        match panel.group_id.as_deref() {
            Some(id) if !kept.contains(id) => panel.group_id = None,
            _ => {}
        }
    }
    for group in &entry.groups {
        for id in &group.member_ids {
            if let Some(panel) = entry.panels.iter_mut().find(|p| &p.pane_id == id) {
                if panel.group_id.as_deref() != Some(group.group_id.as_str()) {
                    panel.group_id = Some(group.group_id.clone());
                }
            }
        }
    }
    // Id sequence heal: an adopted client entry carries no seq fields
    // (serde defaults them to 0), so the counters must clear the highest
    // minted id or the next panel.create/group.create collides with a
    // live id.
    entry.next_pane_seq = entry.next_pane_seq.max(
        entry
            .panels
            .iter()
            .filter_map(|p| p.pane_id.strip_prefix("p").and_then(|s| s.parse().ok()))
            .max()
            .unwrap_or(0)
            + 1,
    );
    entry.next_group_seq = entry.next_group_seq.max(
        entry
            .groups
            .iter()
            .filter_map(|g| g.group_id.strip_prefix("g").and_then(|s| s.parse().ok()))
            .max()
            .unwrap_or(0)
            + 1,
    );
    heal_visible(entry);
}

fn normalize_group(entry: &PanesEntry, mut group: GroupRecord) -> Option<GroupRecord> {
    if group.group_id.is_empty() {
        return None;
    }
    let mut seen: HashSet<String> = HashSet::new();
    group
        .member_ids
        .retain(|id| panel_index(entry, id).is_some() && seen.insert(id.clone()));
    if group.member_ids.len() < 2 {
        return None;
    }
    // Focus memory must name a live member; a stale pointer (closed or
    // ungrouped panel) heals to None so reopening falls back to the
    // first member.
    if group
        .focused_pane_id
        .as_deref()
        .is_some_and(|id| !group.member_ids.contains(&id.to_string()))
    {
        group.focused_pane_id = None;
    }
    // Every member must appear in the layout; a stale layout rebuilds
    // flat from memberIds (geometry is cheap, membership is not).
    let missing = group
        .member_ids
        .iter()
        .any(|id| !layout_holds(&group.layout, id));
    if missing || !group.layout.is_object() && !group.layout.is_string() {
        group.layout = Value::Array(
            group
                .member_ids
                .iter()
                .map(|id| Value::String(id.clone()))
                .collect(),
        );
    }
    if let Some(name) = group.name.as_ref() {
        if name.trim().is_empty() || name.chars().count() > MAX_NAME_CHARS {
            group.name = None;
        }
    }
    Some(group)
}

/// Mutate the per-session entry, persist, broadcast. One store guard
/// covers read+mutate+insert (mutate runs on a clone inside the guard so
/// a mutate error leaves the map untouched); persist and broadcast run
/// after the guard drops, broadcast only when the disk write succeeded.
/// A client that misses the frame self-heals on the next GET.
async fn apply_panes(
    state: &WebState,
    session: &str,
    mutate: impl FnOnce(&mut PanesEntry) -> Result<(), (StatusCode, String)>,
) -> Result<Value, (StatusCode, String)> {
    let entry = {
        let mut store = state.panes_store.sessions.lock().map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "panes store unavailable".to_string(),
            )
        })?;
        let entry = store
            .entry(session.to_string())
            .or_insert_with(|| load_entry(session))
            .clone();
        let mut next = entry;
        mutate(&mut next)?;
        normalize_entry(&mut next);
        next.at = crate::unix_now_seconds();
        let snapshot = next.clone();
        store.insert(session.to_string(), next);
        snapshot
    };
    let persist = {
        let snapshot = entry.clone();
        let session = session.to_string();
        let save_lock = state.panes_store.clone();
        tokio::task::spawn_blocking(move || {
            // Hold the save lock across stage+rename: concurrent saves for
            // ANY session share the sibling temp name pattern, and without
            // the lock one save renames the temp out from under the
            // other's rename (ENOENT -> 500).
            let _guard = save_lock.save_lock.lock();
            save_entry(&session, &snapshot)
        })
    };
    match persist.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err((StatusCode::INTERNAL_SERVER_ERROR, err.to_string())),
        Err(err) => return Err((StatusCode::INTERNAL_SERVER_ERROR, err.to_string())),
    }
    broadcast_panes(state, session, &entry);
    Ok(entry_public_json(session, &entry))
}

fn entry_public_json(session: &str, entry: &PanesEntry) -> Value {
    let mut value = serde_json::to_value(entry).unwrap_or_else(|_| serde_json::json!({}));
    value["session"] = serde_json::json!(session);
    value
}

fn broadcast_panes(state: &WebState, session: &str, entry: &PanesEntry) {
    let payload = entry_public_json(session, entry);
    let _ = state.panes_store.tx.send(payload);
}

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/workspace-panes", get(panes_get).post(panes_apply))
        .route("/api/workspace-panes/op", post(panes_op))
}

#[allow(clippy::result_large_err)]
fn panes_auth(state: &WebState, headers: &HeaderMap, remote: SocketAddr) -> Result<(), Response> {
    crate::require_auth(state, headers, remote)
}

fn panes_json_error(status: StatusCode, message: String) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn panes_session(headers: &HeaderMap) -> String {
    crate::canonical_session_name(
        headers
            .get("x-herdr-session")
            .and_then(|value| value.to_str().ok()),
    )
}

async fn panes_get(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = panes_auth(&state, &headers, remote) {
        return response;
    }
    let session = panes_session(&headers);
    let snapshot = state
        .panes_store
        .sessions
        .lock()
        .and_then(|mut store| {
            Ok(store
                .entry(session.clone())
                .or_insert_with(|| load_entry(&session))
                .clone())
        })
        .map(|entry| entry_public_json(&session, &entry));
    match snapshot {
        Ok(value) => Json(value).into_response(),
        Err(_) => panes_json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "panes store unavailable".into(),
        ),
    }
}

#[derive(Deserialize)]
struct PanesApplyRequest {
    entry: Value,
}

async fn panes_apply(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<PanesApplyRequest>,
) -> Response {
    if let Err(response) = panes_auth(&state, &headers, remote) {
        return response;
    }
    let session = panes_session(&headers);
    let incoming: PanesEntry = match serde_json::from_value(body.entry.clone()) {
        Ok(entry) => entry,
        Err(err) => {
            return panes_json_error(StatusCode::BAD_REQUEST, format!("invalid entry: {err}"))
        }
    };
    // Seed-overwrite rule: the seed never overwrites real content, real
    // content never overwrites the seed, and two real entries resolve
    // last-writer-wins (the client migration posts once).
    let result = apply_panes(&state, &session, move |current| {
        let incoming_is_seed = entry_is_seed(&incoming);
        let current_is_seed = entry_is_seed(current);
        if !incoming_is_seed && current_is_seed {
            *current = incoming.clone();
            return Ok(());
        }
        if incoming_is_seed && !current_is_seed {
            return Ok(());
        }
        *current = incoming.clone();
        Ok(())
    })
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err((status, message)) => panes_json_error(status, message),
    }
}

/// Op bodies arrive in the client's camelCase wire convention
/// (paneId, groupId, wsId, draggedFirst, ...), matching the entry blob.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanesOpRequest {
    op: String,
    #[serde(default)]
    pane_id: Option<String>,
    #[serde(default)]
    group_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ws_id: Option<String>,
    #[serde(default)]
    neighbor_pane_id: Option<String>,
    #[serde(default)]
    host_pane_id: Option<String>,
    #[serde(default)]
    axis: Option<String>,
    #[serde(default)]
    dragged_first: bool,
    /// Client-side tab sync push: the full tabs/active arrays for the
    /// named pane, applied verbatim after length validation.
    #[serde(default)]
    tabs: Option<Vec<String>>,
    #[serde(default)]
    active: Option<String>,
    /// Last-writer's visible pointer choice (subject switch).
    #[serde(default)]
    visible: Option<Value>,
    /// Focus pointer write (per-client, rides the shared entry).
    #[serde(default)]
    active_pane_id: Option<String>,
    /// Group focus memory (subject.set): the group record stores the
    /// member the client last viewed inside the split, so reopening
    /// restores that member.
    #[serde(default)]
    focused_pane_id: Option<String>,
}

async fn panes_op(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<PanesOpRequest>,
) -> Response {
    if let Err(response) = panes_auth(&state, &headers, remote) {
        return response;
    }
    let session = panes_session(&headers);
    let result = apply_panes(&state, &session, move |entry| apply_op(entry, &body)).await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err((status, message)) => panes_json_error(status, message),
    }
}

fn valid_axis(axis: Option<&str>) -> Option<&'static str> {
    match axis {
        Some("row") => Some("row"),
        Some("column") => Some("column"),
        _ => None,
    }
}

fn trim_name(raw: Option<&str>) -> Result<Option<String>, (StatusCode, String)> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > MAX_NAME_CHARS {
                return Err((StatusCode::BAD_REQUEST, "name too long".to_string()));
            }
            Ok(Some(trimmed))
        }
    }
}

fn apply_op(entry: &mut PanesEntry, op: &PanesOpRequest) -> Result<(), (StatusCode, String)> {
    match op.op.as_str() {
        "panel.create" => {
            let pane_id = format!("p{}", entry.next_pane_seq.max(1));
            entry.next_pane_seq = entry.next_pane_seq.max(1) + 1;
            entry.panels.push(PanelRecord {
                kind: "pane".to_string(),
                pane_id: pane_id.clone(),
                tabs: vec![],
                active: None,
                ws_id: op.ws_id.clone().filter(|id| !id.is_empty()),
                group_id: None,
                name: None,
            });
            Ok(())
        }
        "panel.update" => {
            let pane_id = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let Some(panel) = entry.panels.iter_mut().find(|p| p.pane_id == pane_id) else {
                return Err((StatusCode::NOT_FOUND, "panel not found".into()));
            };
            if let Some(tabs) = op.tabs.as_ref() {
                if tabs.len() > MAX_TABS_PER_PANEL {
                    return Err((StatusCode::BAD_REQUEST, "too many tabs".into()));
                }
                panel.tabs = tabs.clone();
            }
            // The sync push carries the client-resolved workspace
            // binding (adoption ladder, legacy heals): a non-empty wsId
            // updates the binding, an explicit empty string clears it.
            if let Some(ws_id) = op.ws_id.as_deref() {
                panel.ws_id = (!ws_id.is_empty()).then(|| ws_id.to_string());
            }
            if let Some(active) = op.active.as_ref() {
                panel.active = Some(active.clone());
            } else if op.tabs.is_some() {
                panel.active = None;
            }
            if let Some(name) = trim_name(op.name.as_deref())? {
                panel.name = Some(name);
            } else if op.name.is_some() {
                panel.name = None;
            }
            Ok(())
        }
        "panel.rename" => {
            let pane_id = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let name = trim_name(op.name.as_deref())?;
            let Some(panel) = entry.panels.iter_mut().find(|p| p.pane_id == pane_id) else {
                return Err((StatusCode::NOT_FOUND, "panel not found".into()));
            };
            panel.name = name;
            Ok(())
        }
        "panel.close" => {
            let pane_id = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let at = panel_index(entry, &pane_id)
                .ok_or((StatusCode::NOT_FOUND, "panel not found".into()))?;
            if entry.panels.len() <= 1 {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "cannot close the last panel".into(),
                ));
            }
            // Capture the doomed panel's group BEFORE the splice: after
            // the remove there is no record left to read the groupId
            // from. No tab migration: the client drains each view
            // through its own close path (confirm included) before the
            // panel.close arrives, so the doomed tabs die with the
            // panel and the survivor keeps exactly its own views.
            let group_id = entry.panels[at].group_id.clone();
            entry.panels.remove(at);
            if let Some(group_id) = group_id {
                if let Some(group) = entry.groups.iter_mut().find(|g| g.group_id == group_id) {
                    group.member_ids.retain(|id| id != &pane_id);
                    group.layout =
                        layout_without(&group.layout.clone(), &pane_id).unwrap_or(Value::Null);
                }
            }
            // A group that lost a member to a close can drop under two.
            dissolve_undersized_groups(entry);
            heal_visible(entry);
            Ok(())
        }
        "group.create" => {
            let dragged = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let axis = valid_axis(op.axis.as_deref())
                .ok_or((StatusCode::BAD_REQUEST, "axis must be row or column".into()))?;
            let dragged_at = panel_index(entry, &dragged)
                .ok_or((StatusCode::NOT_FOUND, "dragged panel not found".into()))?;
            if entry.panels[dragged_at].group_id.is_some() {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "dragged panel is already grouped".into(),
                ));
            }
            let neighbor = match op.neighbor_pane_id.as_deref() {
                Some(explicit) => explicit.to_string(),
                None => {
                    // Auto-join: the next ungrouped rail neighbor, else
                    // the previous one (right-preference, the client
                    // default).
                    let rail: Vec<String> = entry
                        .panels
                        .iter()
                        .filter(|p| p.group_id.is_none())
                        .map(|p| p.pane_id.clone())
                        .collect();
                    let at = rail.iter().position(|id| id == &dragged).ok_or((
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "no neighbor to join".into(),
                    ))?;
                    rail.get(at + 1)
                        .or_else(|| at.checked_sub(1).and_then(|prev| rail.get(prev)))
                        .cloned()
                        .ok_or((
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "no neighbor to join".into(),
                        ))?
                }
            };
            let neighbor_at = panel_index(entry, &neighbor)
                .ok_or((StatusCode::NOT_FOUND, "neighbor panel not found".into()))?;
            if entry.panels[neighbor_at].group_id.is_some() || neighbor == dragged {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "neighbor is grouped or is the dragged panel".into(),
                ));
            }
            let group_id = format!("g{}", entry.next_group_seq.max(1));
            entry.next_group_seq = entry.next_group_seq.max(1) + 1;
            let children: Vec<Value> = if op.dragged_first {
                vec![
                    Value::String(dragged.clone()),
                    Value::String(neighbor.clone()),
                ]
            } else {
                vec![
                    Value::String(neighbor.clone()),
                    Value::String(dragged.clone()),
                ]
            };
            let group = GroupRecord {
                group_id: group_id.clone(),
                name: None,
                member_ids: vec![dragged.clone(), neighbor.clone()],
                layout: serde_json::json!({
                    "kind": axis,
                    "sizes": [1, 1],
                    "children": children,
                }),
                focused_pane_id: Some(dragged.clone()),
            };
            entry.groups.push(group);
            for id in [&dragged, &neighbor] {
                if let Some(panel) = entry.panels.iter_mut().find(|p| id == &p.pane_id) {
                    panel.group_id = Some(group_id.clone());
                }
            }
            entry.visible = VisiblePointer {
                kind: "group".to_string(),
                id: group_id,
            };
            Ok(())
        }
        "group.grow" => {
            let dragged = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let group_id = op
                .group_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "group_id required".into()))?;
            let axis = valid_axis(op.axis.as_deref())
                .ok_or((StatusCode::BAD_REQUEST, "axis must be row or column".into()))?;
            let dragged_at = panel_index(entry, &dragged)
                .ok_or((StatusCode::NOT_FOUND, "dragged panel not found".into()))?;
            if entry.panels[dragged_at].group_id.is_some() {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "dragged panel is already grouped".into(),
                ));
            }
            let group_at = group_index(entry, &group_id)
                .ok_or((StatusCode::NOT_FOUND, "group not found".into()))?;
            // Ephemeral groups: only the visible split view can grow.
            if entry.visible.kind != "group" || entry.visible.id != group_id {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "group is not the visible subject".into(),
                ));
            }
            entry.panels[dragged_at].group_id = Some(group_id.clone());
            let layout = entry.groups[group_at].layout.clone();
            entry.groups[group_at].member_ids.push(dragged.clone());
            // The just-dropped panel opens focused in the split.
            entry.groups[group_at].focused_pane_id = Some(dragged.clone());
            entry.groups[group_at].layout = layout_with_panel_at(
                &layout,
                &dragged,
                axis,
                op.dragged_first,
                op.host_pane_id.as_deref(),
            );
            Ok(())
        }
        "group.move" => {
            let dragged = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let group_id = op
                .group_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "group_id required".into()))?;
            let host = op
                .host_pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "host_pane_id required".into()))?;
            let axis = valid_axis(op.axis.as_deref())
                .ok_or((StatusCode::BAD_REQUEST, "axis must be row or column".into()))?;
            let dragged_at = panel_index(entry, &dragged)
                .ok_or((StatusCode::NOT_FOUND, "dragged panel not found".into()))?;
            let actual_group = entry.panels[dragged_at]
                .group_id
                .clone()
                .ok_or((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "panel is not grouped".into(),
                ))?;
            if actual_group != group_id {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "panel is not a member of this group".into(),
                ));
            }
            let group_at = group_index(entry, &group_id)
                .ok_or((StatusCode::NOT_FOUND, "group not found".into()))?;
            // Ephemeral groups: only the visible split view re-positions.
            if entry.visible.kind != "group" || entry.visible.id != group_id {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "group is not the visible subject".into(),
                ));
            }
            if host == dragged {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "host must differ from the moved panel".into(),
                ));
            }
            // The host must be a live member: a drop outside the split
            // never reaches this op (the client gates it), but the server
            // re-checks so a stale client cannot strand the layout on a
            // dead id.
            let members = live_members(entry, &entry.groups[group_at]);
            if !members.iter().any(|id| id == &host) {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "host is not a member of this group".into(),
                ));
            }
            let layout = entry.groups[group_at].layout.clone();
            let removed = layout_without(&layout, &dragged)
                .unwrap_or_else(|| Value::String(dragged.clone()));
            entry.groups[group_at].layout =
                layout_with_panel_at(&removed, &dragged, axis, op.dragged_first, Some(&host));
            Ok(())
        }
        "group.ungroup" => {
            let pane_id = op
                .pane_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "pane_id required".into()))?;
            let at = panel_index(entry, &pane_id)
                .ok_or((StatusCode::NOT_FOUND, "panel not found".into()))?;
            let group_id = entry.panels[at].group_id.clone().ok_or((
                StatusCode::UNPROCESSABLE_ENTITY,
                "panel is not grouped".into(),
            ))?;
            let group_at = group_index(entry, &group_id)
                .ok_or((StatusCode::NOT_FOUND, "group not found".into()))?;
            entry.panels[at].group_id = None;
            entry.groups[group_at]
                .member_ids
                .retain(|id| id != &pane_id);
            entry.groups[group_at].layout =
                layout_without(&entry.groups[group_at].layout.clone(), &pane_id)
                    .unwrap_or(Value::Null);
            dissolve_undersized_groups(entry);
            heal_visible(entry);
            Ok(())
        }
        "group.rename" => {
            let group_id = op
                .group_id
                .clone()
                .ok_or((StatusCode::BAD_REQUEST, "group_id required".into()))?;
            let name = trim_name(op.name.as_deref())?;
            let Some(group) = entry.groups.iter_mut().find(|g| g.group_id == group_id) else {
                return Err((StatusCode::NOT_FOUND, "group not found".into()));
            };
            group.name = name;
            Ok(())
        }
        "subject.set" => {
            let kind = op
                .visible
                .as_ref()
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("panel");
            let id = op
                .visible
                .as_ref()
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .ok_or((StatusCode::BAD_REQUEST, "visible id required".into()))?;
            if kind != "panel" && kind != "group" {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "type must be panel or group".into(),
                ));
            }
            if kind == "panel" && panel_index(entry, id).is_none() {
                return Err((StatusCode::NOT_FOUND, "panel not found".into()));
            }
            if kind == "group" && group_index(entry, id).is_none() {
                return Err((StatusCode::NOT_FOUND, "group not found".into()));
            }
            entry.visible = VisiblePointer {
                kind: kind.to_string(),
                id: id.to_string(),
            };
            // Persistent groups: a panel subject shows that panel flat
            // but never dissolves a group record; hidden groups stay
            // parked as rail chips. The optional focus memory rides the
            // op so the record learns the member this client viewed
            // last (subject switch onto a member, split reopen).
            if let Some(group_id) = op.group_id.as_deref() {
                if let Some(focused) = op.focused_pane_id.as_deref() {
                    if let Some(group) = entry.groups.iter_mut().find(|g| g.group_id == group_id) {
                        if group.member_ids.iter().any(|id| id == focused) {
                            group.focused_pane_id = Some(focused.to_string());
                        }
                    }
                }
            }
            Ok(())
        }
        "focus.set" => {
            if let Some(active) = op.active_pane_id.as_deref() {
                if panel_index(entry, active).is_some() {
                    entry.active_pane_id = Some(active.to_string());
                }
            }
            Ok(())
        }
        other => Err((StatusCode::BAD_REQUEST, format!("unknown op: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panel(pane_id: &str) -> PanelRecord {
        PanelRecord {
            kind: "pane".to_string(),
            pane_id: pane_id.to_string(),
            tabs: vec![],
            active: None,
            ws_id: None,
            group_id: None,
            name: None,
        }
    }

    fn entry_with_panels(ids: &[&str]) -> PanesEntry {
        let mut entry = default_entry();
        entry.panels = ids.iter().map(|id| panel(id)).collect();
        entry.next_pane_seq = (ids.len() + 1) as u64;
        entry.visible = VisiblePointer {
            kind: "panel".to_string(),
            id: ids.first().unwrap_or(&"p1").to_string(),
        };
        entry
    }

    fn req(op: &str) -> PanesOpRequest {
        PanesOpRequest {
            op: op.to_string(),
            pane_id: None,
            group_id: None,
            name: None,
            ws_id: None,
            neighbor_pane_id: None,
            host_pane_id: None,
            axis: None,
            dragged_first: false,
            tabs: None,
            active: None,
            visible: None,
            active_pane_id: None,
            focused_pane_id: None,
        }
    }

    #[test]
    fn panel_create_mints_monotonic_ids() {
        let mut entry = entry_with_panels(&["p1", "p2"]);
        let op = PanesOpRequest {
            ws_id: Some("ws_1".into()),
            ..req("panel.create")
        };
        apply_op(&mut entry, &op).unwrap();
        assert_eq!(entry.panels.last().unwrap().pane_id, "p3");
        assert_eq!(entry.panels.last().unwrap().ws_id.as_deref(), Some("ws_1"));
        // Next mint continues the sequence.
        apply_op(&mut entry, &req("panel.create")).unwrap();
        assert_eq!(entry.panels.last().unwrap().pane_id, "p4");
    }

    #[test]
    fn panel_rename_sets_and_clears() {
        let mut entry = entry_with_panels(&["p1"]);
        let mut op = req("panel.rename");
        op.pane_id = Some("p1".into());
        op.name = Some("my panel".into());
        apply_op(&mut entry, &op).unwrap();
        assert_eq!(entry.panels[0].name.as_deref(), Some("my panel"));
        // Whitespace-only clears.
        op.name = Some("   ".into());
        apply_op(&mut entry, &op).unwrap();
        assert_eq!(entry.panels[0].name, None);
        // Unknown panel 404s.
        op.pane_id = Some("nope".into());
        assert!(apply_op(&mut entry, &op).is_err());
    }

    #[test]
    fn panel_close_refuses_last_panel() {
        let mut entry = entry_with_panels(&["p1"]);
        let mut op = req("panel.close");
        op.pane_id = Some("p1".into());
        assert!(apply_op(&mut entry, &op).is_err());
    }

    #[test]
    fn group_create_auto_joins_next_rail_neighbor() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut op = req("group.create");
        op.pane_id = Some("p2".into());
        op.axis = Some("row".into());
        op.dragged_first = true;
        apply_op(&mut entry, &op).unwrap();
        assert_eq!(entry.groups.len(), 1);
        let group = &entry.groups[0];
        assert_eq!(group.member_ids, vec!["p2", "p3"]);
        assert_eq!(group.layout["children"], serde_json::json!(["p2", "p3"]));
        assert_eq!(entry.panels[1].group_id.as_deref(), Some("g1"));
        assert_eq!(entry.panels[2].group_id.as_deref(), Some("g1"));
        assert_eq!(entry.visible.kind, "group");
        assert_eq!(entry.visible.id, "g1");
    }

    #[test]
    fn group_create_last_rail_panel_joins_left_neighbor() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut op = req("group.create");
        op.pane_id = Some("p3".into());
        op.axis = Some("column".into());
        apply_op(&mut entry, &op).unwrap();
        let group = &entry.groups[0];
        assert_eq!(group.member_ids, vec!["p3", "p2"]);
    }

    #[test]
    fn group_grow_nests_into_layout() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3", "p4"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        let mut grow = req("group.grow");
        grow.pane_id = Some("p4".into());
        grow.group_id = Some("g1".into());
        grow.axis = Some("column".into());
        grow.dragged_first = false;
        grow.host_pane_id = Some("p2".into());
        apply_op(&mut entry, &grow).unwrap();
        let group = &entry.groups[0];
        assert_eq!(group.member_ids, vec!["p1", "p2", "p4"]);
        // p4 nested under host p2 as a column child.
        let children = group.layout["children"].as_array().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0], serde_json::json!("p1"));
        let nested = &children[1];
        assert_eq!(nested["kind"], "column");
        assert_eq!(nested["children"], serde_json::json!(["p2", "p4"]));
    }

    #[test]
    fn group_ungroup_dissolves_under_two() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        // Auto-join picked p2 (dragged p1 + right neighbor p2).
        assert_eq!(entry.groups[0].member_ids, vec!["p1", "p2"]);
        assert_eq!(entry.groups[0].group_id, "g1");
        // Ungroup one member: two members minus one leaves one, the
        // group dissolves (the under-two rule) and the survivor clears.
        let mut ungroup = req("group.ungroup");
        ungroup.pane_id = Some("p1".into());
        apply_op(&mut entry, &ungroup).unwrap();
        assert!(entry.groups.is_empty());
        assert_eq!(entry.panels[0].group_id, None);
        assert_eq!(entry.panels[1].group_id, None);
        // A three-member group does survive a single ungroup.
        let mut second = req("group.create");
        second.pane_id = Some("p1".into());
        second.axis = Some("row".into());
        second.dragged_first = true;
        apply_op(&mut entry, &second).unwrap();
        let recreated_id = entry.groups[0].group_id.clone();
        let mut grow = req("group.grow");
        grow.pane_id = Some("p3".into());
        grow.group_id = Some(recreated_id.clone());
        grow.axis = Some("column".into());
        grow.dragged_first = false;
        grow.host_pane_id = Some("p2".into());
        apply_op(&mut entry, &grow).unwrap();
        assert_eq!(entry.groups[0].member_ids.len(), 3);
        let mut third = req("group.ungroup");
        third.pane_id = Some("p1".into());
        apply_op(&mut entry, &third).unwrap();
        assert_eq!(entry.groups.len(), 1);
        assert_eq!(entry.groups[0].member_ids, vec!["p2", "p3"]);
        assert_eq!(entry.groups[0].group_id, recreated_id);
    }

    #[test]
    fn panel_close_drops_doomed_tabs_with_the_panel() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        for (at, ws) in [(0, "ws_1"), (1, "ws_1"), (2, "ws_2")] {
            entry.panels[at].ws_id = Some(ws.into());
        }
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        assert_eq!(entry.groups[0].member_ids, vec!["p1", "p2"]);
        entry.visible = VisiblePointer {
            kind: "group".to_string(),
            id: "g1".to_string(),
        };
        entry.panels[0].tabs = vec!["t1".into(), "t2".into()];
        entry.panels[0].active = Some("t2".into());
        entry.panels[1].tabs = vec!["t2".into(), "t3".into()];
        entry.panels[1].active = Some("t3".into());
        let mut close = req("panel.close");
        close.pane_id = Some("p1".into());
        apply_op(&mut entry, &close).unwrap();
        // The client drains the doomed views through their own close
        // paths before panel.close; the splice drops the panel and
        // whatever it still held, the survivor keeps exactly its own.
        assert_eq!(entry.panels[0].pane_id, "p2");
        assert_eq!(entry.panels[0].tabs, vec!["t2", "t3"]);
        assert_eq!(entry.panels[0].active.as_deref(), Some("t3"));
        // Group dissolved under two, the survivor owns the subject.
        assert!(entry.groups.is_empty());
        assert_eq!(entry.panels[0].group_id, None);
        assert_eq!(entry.visible.kind, "panel");
        assert_eq!(entry.visible.id, "p2");
        // The other-workspace panel never received anything.
        assert!(entry.panels[1].tabs.is_empty());
    }

    #[test]
    fn panel_close_drops_tabs_even_across_workspaces() {
        let mut entry = entry_with_panels(&["p1", "p2"]);
        entry.panels[0].ws_id = Some("ws_a".into());
        entry.panels[1].ws_id = Some("ws_b".into());
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        entry.visible = VisiblePointer {
            kind: "group".to_string(),
            id: "g1".to_string(),
        };
        entry.panels[0].tabs = vec!["t1".into()];
        entry.panels[0].active = Some("t1".into());
        let mut close = req("panel.close");
        close.pane_id = Some("p1".into());
        apply_op(&mut entry, &close).unwrap();
        // No migration anywhere: tabs die with the doomed panel, the
        // dissolve still heals to the survivor.
        assert!(entry.panels[0].tabs.is_empty());
        assert_eq!(entry.panels[0].active, None);
        assert!(entry.groups.is_empty());
        assert_eq!(entry.visible.kind, "panel");
        assert_eq!(entry.visible.id, "p2");
    }

    #[test]
    fn panel_close_keeps_survivor_pointer_its_own() {
        let mut entry = entry_with_panels(&["p1", "p2"]);
        entry.panels[0].ws_id = Some("ws_1".into());
        entry.panels[1].ws_id = Some("ws_1".into());
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        entry.panels[0].tabs = vec!["t1".into()];
        entry.panels[0].active = Some("t1".into());
        // Stale survivor pointer: no migration heals it anymore; the
        // client's own heal (syncTerminalTabsIntoTree's stale-pointer
        // pass) owns dangling actives.
        entry.panels[1].tabs = vec!["t2".into()];
        entry.panels[1].active = Some("stale".into());
        let mut close = req("panel.close");
        close.pane_id = Some("p1".into());
        apply_op(&mut entry, &close).unwrap();
        assert_eq!(entry.panels[0].tabs, vec!["t2"]);
        assert_eq!(entry.panels[0].active.as_deref(), Some("stale"));
    }

    #[test]
    fn group_ungroup_heals_subject_to_surviving_member() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        let mut grow = req("group.grow");
        grow.pane_id = Some("p3".into());
        grow.group_id = Some("g1".into());
        grow.axis = Some("column".into());
        grow.host_pane_id = Some("p2".into());
        apply_op(&mut entry, &grow).unwrap();
        entry.visible = VisiblePointer {
            kind: "group".to_string(),
            id: "g1".to_string(),
        };
        // Three members: one ungroup keeps the group standing.
        let mut ungroup = req("group.ungroup");
        ungroup.pane_id = Some("p1".into());
        apply_op(&mut entry, &ungroup).unwrap();
        assert_eq!(entry.groups.len(), 1);
        assert_eq!(entry.visible.kind, "group");
        // The next ungroup dissolves and the survivor takes the subject.
        let mut second = req("group.ungroup");
        second.pane_id = Some("p3".into());
        apply_op(&mut entry, &second).unwrap();
        assert!(entry.groups.is_empty());
        assert_eq!(entry.visible.kind, "panel");
        assert_eq!(entry.visible.id, "p2");
    }

    #[test]
    fn group_move_repositions_member_beside_host() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3", "p4"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        let mut grow = req("group.grow");
        grow.pane_id = Some("p4".into());
        grow.group_id = Some("g1".into());
        grow.axis = Some("column".into());
        grow.dragged_first = false;
        grow.host_pane_id = Some("p2".into());
        apply_op(&mut entry, &grow).unwrap();
        // Layout: row [p1, column [p2, p4]]. Move p1 after p4's slot on
        // the row axis with p4 as host: p1 leaves the root, nests a row
        // inside the column after p4.
        let mut mv = req("group.move");
        mv.pane_id = Some("p1".into());
        mv.group_id = Some("g1".into());
        mv.host_pane_id = Some("p4".into());
        mv.axis = Some("row".into());
        mv.dragged_first = false;
        apply_op(&mut entry, &mv).unwrap();
        let group = &entry.groups[0];
        // Membership order is untouched (only the layout moves).
        assert_eq!(group.member_ids, vec!["p1", "p2", "p4"]);
        // The root row collapses when p1 leaves it (single-survivor
        // rule), so the column becomes the root: p2 on top, p1 nested
        // beside p4 on the row axis under it.
        assert_eq!(group.layout["kind"], "column");
        let children = group.layout["children"].as_array().unwrap();
        assert_eq!(children[0], serde_json::json!("p2"));
        let inner = &children[1];
        assert_eq!(inner["kind"], "row");
        assert_eq!(inner["children"], serde_json::json!(["p4", "p1"]));
    }

    #[test]
    fn group_move_flat_pair_swaps_order() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p2".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        assert_eq!(entry.groups[0].layout["children"], serde_json::json!(["p2", "p3"]));
        // Move p3 first beside host p2 (dragged first on the row axis).
        let mut mv = req("group.move");
        mv.pane_id = Some("p3".into());
        mv.group_id = Some("g1".into());
        mv.host_pane_id = Some("p2".into());
        mv.axis = Some("row".into());
        mv.dragged_first = true;
        apply_op(&mut entry, &mv).unwrap();
        assert_eq!(entry.groups[0].layout["children"], serde_json::json!(["p3", "p2"]));
    }

    #[test]
    fn group_move_refuses_foreign_panel_and_missing_fields() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3", "p4"]);
        let mut create = req("group.create");
        create.pane_id = Some("p2".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        // p4 is not a member: refused.
        let mut foreign = req("group.move");
        foreign.pane_id = Some("p4".into());
        foreign.group_id = Some("g1".into());
        foreign.host_pane_id = Some("p2".into());
        foreign.axis = Some("row".into());
        assert!(apply_op(&mut entry, &foreign).is_err());
        // Self-host: refused.
        let mut self_host = req("group.move");
        self_host.pane_id = Some("p2".into());
        self_host.group_id = Some("g1".into());
        self_host.host_pane_id = Some("p2".into());
        self_host.axis = Some("row".into());
        assert!(apply_op(&mut entry, &self_host).is_err());
        // Missing host: 400.
        let mut no_host = req("group.move");
        no_host.pane_id = Some("p2".into());
        no_host.group_id = Some("g1".into());
        no_host.axis = Some("row".into());
        assert!(apply_op(&mut entry, &no_host).is_err());
        // Non-visible group: switch the subject away, then the move 422s
        // (read-only contract: only the visible split re-positions).
        let mut subject = req("subject.set");
        subject.visible = Some(serde_json::json!({"type": "panel", "id": "p1"}));
        apply_op(&mut entry, &subject).unwrap();
        // Persistence kept the record through the switch; only the
        // visible guard should refuse the move.
        assert_eq!(entry.groups.len(), 1);
        let mut stale = req("group.move");
        stale.pane_id = Some("p2".into());
        stale.group_id = Some("g1".into());
        stale.host_pane_id = Some("p3".into());
        stale.axis = Some("row".into());
        assert!(apply_op(&mut entry, &stale).is_err());
    }

    #[test]
    fn group_rename_persists_on_record() {
        let mut entry = entry_with_panels(&["p1", "p2"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        let mut rename = req("group.rename");
        rename.group_id = Some("g1".into());
        rename.name = Some("demo".into());
        apply_op(&mut entry, &rename).unwrap();
        assert_eq!(entry.groups[0].name.as_deref(), Some("demo"));
    }

    #[test]
    fn normalize_drops_dead_members_and_stale_visible() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p2".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        // p3 dies (closed elsewhere): the group must dissolve.
        entry.panels.retain(|p| p.pane_id != "p3");
        normalize_entry(&mut entry);
        assert!(entry.groups.is_empty());
        // Visible healed off the dissolved group.
        assert_eq!(entry.visible.kind, "panel");
    }

    #[test]
    fn subject_set_to_panel_keeps_group_and_focus_memory() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        // Fresh splits open focused on the dragged panel.
        assert_eq!(entry.groups[0].focused_pane_id.as_deref(), Some("p1"));
        let mut set = req("subject.set");
        set.visible = Some(serde_json::json!({ "type": "panel", "id": "p3" }));
        apply_op(&mut entry, &set).unwrap();
        // Persistent groups: the switch shows p3 flat but the record and
        // its member links survive for the rail chip.
        assert_eq!(entry.groups.len(), 1);
        assert_eq!(entry.groups[0].group_id, "g1");
        assert!(entry.panels.iter().all(|p| {
            p.group_id.is_none() || p.group_id.as_deref() == Some("g1")
        }));
        assert_eq!(entry.visible.kind, "panel");
        assert_eq!(entry.visible.id, "p3");
        // Focus memory rides the switch when the client names the group
        // and a live member (member chip press stores the viewed member).
        let mut member = req("subject.set");
        member.visible = Some(serde_json::json!({ "type": "panel", "id": "p2" }));
        member.group_id = Some("g1".into());
        member.focused_pane_id = Some("p2".into());
        apply_op(&mut entry, &member).unwrap();
        assert_eq!(entry.groups[0].focused_pane_id.as_deref(), Some("p2"));
        // A dead member pointer never lands in the record.
        let mut stale = req("subject.set");
        stale.visible = Some(serde_json::json!({ "type": "panel", "id": "p3" }));
        stale.group_id = Some("g1".into());
        stale.focused_pane_id = Some("p404".into());
        apply_op(&mut entry, &stale).unwrap();
        assert_eq!(entry.groups[0].focused_pane_id.as_deref(), Some("p2"));
    }

    #[test]
    fn group_grow_rejects_non_visible_group() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3", "p4"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        // Point the visible pointer at a panel WITHOUT normalize, so the
        // group record still stands: the grow guard alone must refuse.
        entry.visible = VisiblePointer {
            kind: "panel".into(),
            id: "p4".into(),
        };
        let mut grow = req("group.grow");
        grow.pane_id = Some("p4".into());
        grow.group_id = Some("g1".into());
        grow.axis = Some("row".into());
        let err = apply_op(&mut entry, &grow).unwrap_err();
        assert_eq!(err.0, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn grow_on_degraded_layout_never_builds_one_child_split() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        // Two live members (p1, p2), layout degraded to Null: the grow
        // rebuilds flat from the surviving ids and must never emit a
        // one-child split node.
        entry.groups[0].layout = Value::Null;
        let mut grow = req("group.grow");
        grow.pane_id = Some("p3".into());
        grow.group_id = Some("g1".into());
        grow.axis = Some("column".into());
        apply_op(&mut entry, &grow).unwrap();
        let layout = &entry.groups[0].layout;
        let children = layout.get("children").and_then(Value::as_array);
        assert!(
            layout.is_string() || children.is_some_and(|c| c.len() >= 2),
            "one-child split leaked: {layout}"
        );
    }

    #[test]
    fn group_grow_same_axis_halves_host_share() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3"]);
        let mut create = req("group.create");
        create.pane_id = Some("p1".into());
        create.axis = Some("row".into());
        create.dragged_first = true;
        apply_op(&mut entry, &create).unwrap();
        let mut grow = req("group.grow");
        grow.pane_id = Some("p3".into());
        grow.group_id = Some("g1".into());
        grow.axis = Some("row".into());
        grow.host_pane_id = Some("p1".into());
        apply_op(&mut entry, &grow).unwrap();
        let group = &entry.groups[0];
        assert_eq!(
            group.layout["children"],
            serde_json::json!(["p1", "p3", "p2"])
        );
        // Client parity: the pair keeps the host's old total, each half.
        let sizes = group.layout["sizes"].as_array().unwrap();
        assert_eq!(sizes[0].as_f64(), Some(0.5));
        assert_eq!(sizes[1].as_f64(), Some(0.5));
        assert_eq!(sizes[2].as_f64(), Some(1.0));
    }

    #[test]
    fn normalize_keeps_hidden_groups_and_sweeps_orphans() {
        let mut entry = entry_with_panels(&["p1", "p2", "p3", "p4"]);
        entry.groups = vec![
            GroupRecord {
                group_id: "g1".into(),
                name: None,
                member_ids: vec!["p1".into(), "p2".into()],
                layout: serde_json::json!(["p1", "p2"]),
                focused_pane_id: None,
            },
            GroupRecord {
                group_id: "g2".into(),
                name: None,
                member_ids: vec!["p3".into(), "p4".into()],
                layout: serde_json::json!(["p3", "p4"]),
                focused_pane_id: Some("p3".into()),
            },
        ];
        entry.panels[0].group_id = Some("g1".into());
        entry.panels[1].group_id = Some("g1".into());
        entry.panels[2].group_id = Some("g2".into());
        entry.panels[3].group_id = Some("g2".into());
        entry.visible = VisiblePointer {
            kind: "group".into(),
            id: "g2".into(),
        };
        normalize_entry(&mut entry);
        // Persistence: BOTH groups survive while the subject names
        // only g2; hidden g1 stays parked with its member links.
        assert_eq!(entry.groups.len(), 2);
        assert_eq!(entry.groups[0].group_id, "g1");
        assert_eq!(entry.groups[1].group_id, "g2");
        assert_eq!(entry.groups[1].focused_pane_id.as_deref(), Some("p3"));
        assert_eq!(entry.panels[0].group_id.as_deref(), Some("g1"));
        assert_eq!(entry.panels[1].group_id.as_deref(), Some("g1"));
        assert_eq!(entry.panels[2].group_id.as_deref(), Some("g2"));
        assert_eq!(entry.panels[3].group_id.as_deref(), Some("g2"));
        // Orphan sweep: a groupId naming no kept record clears, and a
        // member listed by a kept record regains its link (blob-side
        // disagreement heals both directions).
        let mut stray = panel("p5");
        stray.group_id = Some("g404".into());
        entry.panels.push(stray);
        entry.panels[1].group_id = None;
        normalize_entry(&mut entry);
        assert_eq!(entry.panels[4].group_id, None);
        assert_eq!(entry.panels[1].group_id.as_deref(), Some("g1"));
        // Focus memory heals off a dead member: p3 closed elsewhere,
        // the pointer must clear so reopening falls back to first.
        entry.groups[1].focused_pane_id = Some("p9".into());
        normalize_entry(&mut entry);
        assert_eq!(entry.groups[1].focused_pane_id, None);
    }

    #[test]
    fn seed_detection_keeps_real_entries() {
        let seed = default_entry();
        assert!(entry_is_seed(&seed));
        let mut real = default_entry();
        real.panels[0].tabs = vec!["tab_1".into()];
        assert!(!entry_is_seed(&real));
    }

    #[test]
    fn layout_without_collapses_single_survivor() {
        let layout = serde_json::json!({
            "kind": "row",
            "sizes": [1, 1],
            "children": ["p1", "p2"]
        });
        let out = layout_without(&layout, "p1").unwrap();
        assert_eq!(out, serde_json::json!("p2"));
        let nested = serde_json::json!({
            "kind": "row",
            "sizes": [1, 2],
            "children": ["p1", { "kind": "column", "sizes": [1, 1], "children": ["p2", "p3"] }]
        });
        let out = layout_without(&nested, "p3").unwrap();
        assert_eq!(out["children"], serde_json::json!(["p1", "p2"]));
    }
}
