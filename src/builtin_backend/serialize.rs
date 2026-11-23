//! JSON projection of the session state (workspaces/tabs/panes/agents).

use super::*;

pub(super) fn workspace_list_json(data: &BuiltinData) -> Vec<Value> {
    ordered_workspaces(data)
        .into_iter()
        .map(|workspace| workspace_json(workspace, data))
        .collect()
}

pub(super) fn tab_list_json(data: &BuiltinData, workspace_id: Option<&str>) -> Vec<Value> {
    ordered_tabs(data, workspace_id)
        .into_iter()
        .map(|tab| tab_json(tab, data))
        .collect()
}

pub(super) fn pane_list_json(data: &BuiltinData, workspace_id: Option<&str>) -> Vec<Value> {
    ordered_panes(data, workspace_id)
        .into_iter()
        .map(|pane| pane_json(pane, data))
        .collect()
}

pub(super) fn agent_list_json(data: &BuiltinData) -> Vec<Value> {
    ordered_panes(data, None)
        .into_iter()
        .filter(|pane| pane.label.is_some() || pane_agent_presentation(pane, data).agent.is_some())
        .map(|pane| agent_json(pane, data))
        .collect()
}

pub(super) fn layout_list_json(data: &BuiltinData) -> Vec<Value> {
    ordered_tabs(data, None)
        .into_iter()
        .map(|tab| layout_json(tab, data))
        .collect()
}

pub(super) fn ordered_workspaces(data: &BuiltinData) -> Vec<&WorkspaceRecord> {
    let mut workspaces = data.workspaces.values().collect::<Vec<_>>();
    workspaces.sort_by_key(|workspace| id_sort_key(&workspace.workspace_id));
    workspaces
}

pub(super) fn ordered_tabs<'a>(
    data: &'a BuiltinData,
    workspace_id: Option<&str>,
) -> Vec<&'a TabRecord> {
    let mut tabs = Vec::new();
    for workspace in ordered_workspaces(data) {
        if workspace_id.is_some_and(|workspace_id| workspace.workspace_id != workspace_id) {
            continue;
        }
        tabs.extend(
            workspace
                .tab_ids
                .iter()
                .filter_map(|tab_id| data.tabs.get(tab_id)),
        );
    }
    tabs
}

pub(super) fn ordered_panes<'a>(
    data: &'a BuiltinData,
    workspace_id: Option<&str>,
) -> Vec<&'a PaneRecord> {
    let mut panes = Vec::new();
    for tab in ordered_tabs(data, workspace_id) {
        panes.extend(
            tab.pane_ids
                .iter()
                .filter_map(|pane_id| data.panes.get(pane_id)),
        );
    }
    panes
}

pub(super) fn workspace_display_number(workspace: &WorkspaceRecord, data: &BuiltinData) -> usize {
    ordered_workspaces(data)
        .iter()
        .position(|candidate| candidate.workspace_id == workspace.workspace_id)
        .map(|index| index + 1)
        .unwrap_or(1)
}

pub(super) fn tab_display_number(tab: &TabRecord, data: &BuiltinData) -> usize {
    data.workspaces
        .get(&tab.workspace_id)
        .and_then(|workspace| {
            workspace
                .tab_ids
                .iter()
                .position(|tab_id| tab_id == &tab.tab_id)
        })
        .map(|index| index + 1)
        .unwrap_or(1)
}

pub(super) fn pane_display_number(pane: &PaneRecord, data: &BuiltinData) -> usize {
    data.tabs
        .get(&pane.tab_id)
        .and_then(|tab| {
            tab.pane_ids
                .iter()
                .position(|pane_id| pane_id == &pane.pane_id)
        })
        .map(|index| index + 1)
        .unwrap_or(1)
}

pub(super) fn workspace_json(workspace: &WorkspaceRecord, data: &BuiltinData) -> Value {
    let pane_count = workspace
        .tab_ids
        .iter()
        .filter_map(|tab_id| data.tabs.get(tab_id))
        .map(|tab| tab.pane_ids.len())
        .sum::<usize>();
    json!({
        "workspace_id": workspace.workspace_id,
        "number": workspace_display_number(workspace, data),
        "label": workspace.label,
        "focused": data.focused_workspace_id.as_deref() == Some(&workspace.workspace_id),
        "pane_count": pane_count,
        "tab_count": workspace.tab_ids.len(),
        "active_tab_id": workspace.tab_ids.first().cloned().unwrap_or_default(),
        "agent_status": aggregate_workspace_agent_status(workspace, data),
        "cwd": workspace.cwd.to_string_lossy(),
        "foreground_cwd": workspace.cwd.to_string_lossy(),
    })
}

pub(super) fn tab_json(tab: &TabRecord, data: &BuiltinData) -> Value {
    json!({
        "tab_id": tab.tab_id,
        "workspace_id": tab.workspace_id,
        "number": tab_display_number(tab, data),
        "label": tab.label,
        "focused": data.focused_tab_id.as_deref() == Some(&tab.tab_id),
        "pane_count": tab.pane_ids.len(),
        "agent_status": aggregate_tab_agent_status(tab, data),
    })
}

/// Stable form of a terminal title for headers: drops the mutating
/// status tokens agents append or prefix so the string stays identical
/// while a turn runs. jcode appends ` · work ~<dur>` /
/// ` · last ~<dur>` (`title_with_metrics`); claude/amp/qwen ride a
/// braille spinner prefix. Titles with no known token come back
/// trimmed only.
pub(super) fn strip_terminal_title_suffix(title: &str) -> String {
    let mut stripped = title.trim();
    for marker in [" · work ~", " · last ~", "· work ~", "· last ~"] {
        if let Some(index) = stripped.find(marker) {
            let head = &stripped[..index];
            stripped = head
                .trim_start()
                .strip_prefix('·')
                .unwrap_or(head)
                .trim_start();
            break;
        }
    }
    // Spinner prefixes (⠙ Working…) never belong in a header name;
    // a trailing separator from a stripped suffix must not linger.
    let stripped = stripped
        .trim_start_matches(|ch: char| is_braille(ch) || ch.is_whitespace())
        .trim();
    stripped.trim_end_matches('·').trim().to_string()
}

pub(super) fn pane_json(pane: &PaneRecord, data: &BuiltinData) -> Value {
    let presentation = pane_agent_presentation(pane, data);
    // OSC 0/2 title the pane's terminal last set. Served raw plus
    // stripped of the mutating status suffix (jcode's ` · work ~<dur>`
    // / ` · last ~<dur>`, braille spinner prefixes) so headers can show
    // a stable string; absent tracker or no title seen -> null.
    let terminal_title = data
        .terminals
        .get(&pane.terminal_id)
        .and_then(|terminal| {
            terminal
                .osc9_tracker
                .lock()
                .ok()
                .map(|tracker| tracker.latest_title().to_string())
        })
        .filter(|title| !title.is_empty())
        .map(|title| json!(title));
    let terminal_title_stripped = terminal_title
        .as_ref()
        .and_then(|value| value.as_str())
        .map(strip_terminal_title_suffix)
        .filter(|title| !title.is_empty())
        .map(|title| json!(title));
    json!({
        "pane_id": pane.pane_id,
        "terminal_id": pane.terminal_id,
        "workspace_id": pane.workspace_id,
        "tab_id": pane.tab_id,
        "number": pane_display_number(pane, data),
        "focused": data.focused_pane_id.as_deref() == Some(&pane.pane_id),
        "cwd": pane.cwd.to_string_lossy(),
        "foreground_cwd": pane.cwd.to_string_lossy(),
        "label": pane.label,
        "agent": presentation.agent,
        "title": pane.label,
        "display_agent": presentation.agent,
        "agent_status": presentation.status,
        "custom_status": null,
        "state_labels": {},
        "agent_session": pane_agent_session(pane, data, &presentation),
        "terminal_title": terminal_title,
        "terminal_title_stripped": terminal_title_stripped,
        "scroll": null,
        "revision": 0,
    })
}

pub(super) fn agent_json(pane: &PaneRecord, data: &BuiltinData) -> Value {
    let presentation = pane_agent_presentation(pane, data);
    json!({
        "terminal_id": pane.terminal_id,
        "name": pane.label,
        "agent": presentation.agent,
        "title": pane.label,
        "display_agent": presentation.agent,
        "agent_status": presentation.status,
        "screen_detection_skipped": false,
        "custom_status": null,
        "state_labels": {},
        "agent_session": pane_agent_session(pane, data, &presentation),
        "workspace_id": pane.workspace_id,
        "tab_id": pane.tab_id,
        "pane_id": pane.pane_id,
        "focused": data.focused_pane_id.as_deref() == Some(&pane.pane_id),
        "cwd": pane.cwd.to_string_lossy(),
        "foreground_cwd": pane.cwd.to_string_lossy(),
        "revision": 0,
    })
}

pub(super) fn layout_json(tab: &TabRecord, data: &BuiltinData) -> Value {
    let panes = tab
        .pane_ids
        .iter()
        .filter_map(|pane_id| data.panes.get(pane_id))
        .enumerate()
        .map(|(index, pane)| {
            json!({
                "pane_id": pane.pane_id,
                "focused": data.focused_pane_id.as_deref() == Some(&pane.pane_id),
                "rect": { "x": 0, "y": index as u16 * 10, "width": 100, "height": 30 },
            })
        })
        .collect::<Vec<_>>();
    json!({
        "workspace_id": tab.workspace_id,
        "tab_id": tab.tab_id,
        "zoomed": false,
        "area": { "x": 0, "y": 0, "width": 100, "height": 30 },
        "focused_pane_id": data.focused_pane_id,
        "panes": panes,
        "splits": [],
    })
}

#[derive(Clone, Copy)]
pub(super) struct PaneAgentPresentation {
    pub(super) agent: Option<&'static str>,
    pub(super) status: &'static str,
}

/// Resolves a pane's `agent_session` (design section 6) by delegating
/// to the chat module: `null` for unsupported agents (Chat lens
/// hidden); `{kind, resolvable, session_id}` for jcode panes when
/// resolution succeeds. The pane tail uses the same verbatim strip as
/// pane_context, so agent_session, conversation and tool output all
/// resolve to the SAME session (the VT-emulation tail let spinner
/// redraws flip twin panes ambiguous — found live).
pub(super) fn pane_agent_session(
    pane: &PaneRecord,
    data: &BuiltinData,
    presentation: &PaneAgentPresentation,
) -> Value {
    let Some(agent) = presentation.agent else {
        return Value::Null;
    };
    if !chat_lens::agent_supported(Some(agent)) {
        return Value::Null;
    }
    let live_cwd = data
        .terminals
        .get(&pane.terminal_id)
        .and_then(|terminal| live_process_cwd(terminal.child_pid()))
        .unwrap_or_else(|| pane.cwd.clone());
    let processes: Vec<chat_lens::ProcessRow> = process_table()
        .unwrap_or_default()
        .iter()
        .map(|p| chat_lens::ProcessRow::new(p.pid, p.ppid))
        .collect();
    let terminal_pid = data
        .terminals
        .get(&pane.terminal_id)
        .and_then(|terminal| terminal.child_pid());
    let pane_tail = data
        .terminals
        .get(&pane.terminal_id)
        .map(|terminal| {
            // Same strip mode as pane_context (verbatim prompt echo, no
            // VT emulation) and same RESOLVE_TAIL_BYTES bound: agent_json,
            // conversation and tool-output resolution must see the same
            // tail the PaneContext they came from had, or one path could
            // resolve while another refuses on the same pane.
            terminal_text::strip_ansi_lossy(
                &String::from_utf8_lossy(&terminal.history_tail_bytes(RESOLVE_TAIL_BYTES)),
                terminal_text::StripCarriageReturn::Drop,
            )
        })
        .unwrap_or_default();
    chat_lens::agent_session(
        agent,
        &chat_lens::PaneContext {
            live_cwd,
            terminal_pid,
            processes,
            pane_tail,
        },
    )
}

pub(super) fn pane_agent_presentation(
    pane: &PaneRecord,
    data: &BuiltinData,
) -> PaneAgentPresentation {
    // Cache design (the removed v0.2.84 cache, for contrast, snapshotted
    // pane_agent_presentation results with no invalidation hook and could
    // stick at a stale "no agent" forever): the output-driven detector
    // (detect_and_publish_agent_status, 500ms throttle + trailing-edge
    // sweeper) already recomputes the agent state on every append and stores
    // it in last_agent_state with seq-staleness protection. Serving THAT
    // value here is exactly as fresh as the throttled path guarantees, and
    // skips the 64KB tail copy, the screen scrape and the `ps` fork on every
    // poll. This is not a second cache: it reads the detector's own state,
    // which output invalidates by construction, so the old "stuck None"
    // failure mode cannot recur (any append re-runs the detector). The
    // fallback below runs only when the detector has never produced a
    // result (no output observed yet), and the exited path is excluded on
    // purpose: exit clears last_agent_state (notify_exited) but must still
    // report the agent label + "done" derived from argv and the final tail.
    // An active RecentAgentProcessExit record also bypasses the cache: the
    // record can flip while a stale cached agent is still committed (the
    // agent process disappeared, but the last detector pass saw it live),
    // and serving the cached label would resurrect exactly the ghost the
    // suppression exists to kill.
    let terminal = data.terminals.get(&pane.terminal_id);
    if let Some(terminal) = terminal {
        if !terminal.exited.load(Ordering::Acquire) && !terminal.recent_agent_exit_active() {
            if let Some((agent, status, _)) = terminal
                .last_agent_state
                .lock()
                .ok()
                .and_then(|state| state.clone())
            {
                return PaneAgentPresentation {
                    agent: agent.as_deref().and_then(agent_label_to_static),
                    status: agent_status_to_static(&status),
                };
            }
        }
    }
    // Mirror upstream herdr's RecentAgentProcessExit suppression: when the
    // pane's agent process exited (jcode quit inside the shell) the pane must
    // stop reporting that agent even if stale screen text or OSC payloads
    // still match, so `agent.list` drops the ghost row.
    let agent_exited_recently = terminal
        .map(|terminal| terminal.recent_agent_exit_active())
        .unwrap_or(false);
    // When the terminal has exited, report "done" instead of letting stale
    // screen text (e.g. a leftover spinner frame) keep the status stuck in
    // "working". The OSC 9 tracker was already reset on exit, but screen-scrape
    // patterns in the scrollback can still match, so this guard is needed.
    if let Some(terminal) = terminal {
        if terminal.exited.load(Ordering::Acquire) {
            let agent = if agent_exited_recently {
                None
            } else {
                detect_agent_label(&pane.argv)
                    .or_else(|| {
                        detect_agent_label_from_text(
                            &terminal.history_tail_text(DETECTION_TAIL_BYTES),
                        )
                    })
                    .or_else(|| {
                        terminal
                            .osc9_tracker
                            .lock()
                            .ok()
                            .and_then(|t| t.latest_agent_label())
                    })
            };
            let status = if agent.is_some() { "done" } else { "unknown" };
            return PaneAgentPresentation { agent, status };
        }
    }
    let tail = terminal
        .map(|terminal| terminal.history_tail_text(DETECTION_TAIL_BYTES))
        .unwrap_or_default();
    let process_agent = terminal
        .and_then(|terminal| terminal.probe_live_process_agent())
        .flatten();
    let agent = if agent_exited_recently {
        None
    } else {
        detect_agent_label(&pane.argv)
            .or(process_agent)
            .or_else(|| {
                // Fall back to the OSC 9 side-channel agent label when argv and
                // process-tree detection both miss (e.g. jcode launched through a
                // wrapper that hides the binary name). The OSC payload format is
                // `<agent>:<state>`, so `jcode:working` identifies the agent.
                terminal
                    .and_then(|t| t.osc9_tracker.lock().ok())
                    .and_then(|t| t.latest_agent_label())
            })
            .or_else(|| detect_agent_label_from_text(&tail))
    };
    let (osc_progress, osc_title) = terminal
        .and_then(|terminal| terminal.osc9_tracker.lock().ok())
        .map(|tracker| {
            (
                tracker.latest_progress().to_string(),
                tracker.latest_title().to_string(),
            )
        })
        .unwrap_or_default();
    let status = detect_agent_status_with_osc(
        agent,
        &tail,
        &osc_progress,
        &osc_title,
        terminal
            .map(|t| t.jcode_detection_variant)
            .unwrap_or(JcodeDetectionVariant::Vanilla),
    );
    PaneAgentPresentation { agent, status }
}

pub(super) fn aggregate_workspace_agent_status(
    workspace: &WorkspaceRecord,
    data: &BuiltinData,
) -> &'static str {
    let statuses = workspace
        .tab_ids
        .iter()
        .filter_map(|tab_id| data.tabs.get(tab_id))
        .flat_map(|tab| tab.pane_ids.iter())
        .filter_map(|pane_id| data.panes.get(pane_id))
        .map(|pane| pane_agent_presentation(pane, data).status);
    strongest_agent_status(statuses)
}

pub(super) fn aggregate_tab_agent_status(tab: &TabRecord, data: &BuiltinData) -> &'static str {
    strongest_agent_status(
        tab.pane_ids
            .iter()
            .filter_map(|pane_id| data.panes.get(pane_id))
            .map(|pane| pane_agent_presentation(pane, data).status),
    )
}

pub(super) fn strongest_agent_status(
    statuses: impl IntoIterator<Item = &'static str>,
) -> &'static str {
    let mut best = "unknown";
    for status in statuses {
        match status {
            "blocked" => return "blocked",
            "working" if best != "working" => best = "working",
            "done" if best == "unknown" || best == "idle" => best = "done",
            "idle" if best == "unknown" => best = "idle",
            _ => {}
        }
    }
    best
}

pub(super) fn agent_label_to_static(label: &str) -> Option<&'static str> {
    const LABELS: &[&str] = &[
        "pi",
        "jcode",
        "claude",
        "codex",
        "gemini",
        "cursor",
        "devin",
        "agy",
        "cline",
        "omp",
        "mastracode",
        "opencode",
        "copilot",
        "kimi",
        "kiro",
        "droid",
        "amp",
        "grok",
        "hermes",
        "kilo",
        "qodercli",
        "maki",
        "claurst",
        "qwen",
    ];
    LABELS.iter().copied().find(|candidate| *candidate == label)
}

pub(super) fn agent_status_to_static(status: &str) -> &'static str {
    match status {
        "working" => "working",
        "blocked" => "blocked",
        "done" => "done",
        "idle" => "idle",
        _ => "unknown",
    }
}
