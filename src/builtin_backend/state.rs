//! BuiltinState: shared data records and request dispatch.

use super::*;

pub(super) struct BuiltinState {
    pub(super) data: Mutex<BuiltinData>,
    pub(super) default_shell: String,
    pub(super) events: BuiltinEventHub,
    pub(super) jcode_detection_variant: JcodeDetectionVariant,
    pub(super) journal_path: Option<PathBuf>,
    /// Set by structural events, persisted by handle_request after the
    /// response: publishers like close_pane fire under the data lock, so
    /// writing the journal from publish_event would self-deadlock.
    pub(super) journal_dirty: AtomicBool,
}

pub(super) struct BuiltinData {
    pub(super) next_id: u64,
    pub(super) workspaces: HashMap<String, WorkspaceRecord>,
    pub(super) tabs: HashMap<String, TabRecord>,
    pub(super) panes: HashMap<String, PaneRecord>,
    pub(super) terminals: HashMap<String, Arc<TerminalRuntime>>,
    pub(super) focused_workspace_id: Option<String>,
    pub(super) focused_tab_id: Option<String>,
    pub(super) focused_pane_id: Option<String>,
}

#[derive(Clone)]
pub(super) struct WorkspaceRecord {
    pub(super) workspace_id: String,
    pub(super) label: String,
    pub(super) cwd: PathBuf,
    pub(super) tab_ids: Vec<String>,
}

#[derive(Clone)]
pub(super) struct TabRecord {
    pub(super) tab_id: String,
    pub(super) workspace_id: String,
    pub(super) label: String,
    pub(super) pane_ids: Vec<String>,
}

#[derive(Clone)]
pub(super) struct PaneRecord {
    pub(super) pane_id: String,
    pub(super) terminal_id: String,
    pub(super) workspace_id: String,
    pub(super) tab_id: String,
    pub(super) cwd: PathBuf,
    pub(super) label: Option<String>,
    pub(super) argv: Vec<String>,
}

impl BuiltinState {
    /// Spawns a pane terminal; must be called outside the `data` lock
    /// because openpty and process spawn can stall on slow disks.
    pub(super) fn spawn_terminal(
        &self,
        terminal_id: &str,
        cwd: &Path,
        argv: Vec<String>,
        workspace_id: &str,
        tab_id: &str,
        pane_id: &str,
    ) -> Result<Arc<TerminalRuntime>, String> {
        TerminalRuntime::spawn(
            terminal_id.to_string(),
            cwd.to_path_buf(),
            argv,
            30,
            100,
            self.events.clone(),
            PaneEventContext {
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.to_string(),
                pane_id: pane_id.to_string(),
                terminal_id: terminal_id.to_string(),
            },
            self.jcode_detection_variant,
        )
        .map_err(|err| err.to_string())
    }

    pub(super) fn new(
        _cwd: PathBuf,
        shell: Option<String>,
        jcode_detection_variant: JcodeDetectionVariant,
    ) -> io::Result<Self> {
        let default_shell = shell.unwrap_or_else(default_shell);
        let state = Self {
            data: Mutex::new(BuiltinData {
                next_id: 1,
                workspaces: HashMap::new(),
                tabs: HashMap::new(),
                panes: HashMap::new(),
                terminals: HashMap::new(),
                focused_workspace_id: None,
                focused_tab_id: None,
                focused_pane_id: None,
            }),
            default_shell,
            events: BuiltinEventHub::new(),
            jcode_detection_variant,
            journal_path: None,
            journal_dirty: AtomicBool::new(false),
        };
        Ok(state)
    }

    pub(super) fn handle_request(&self, id: &str, method: &str, params: Value) -> Value {
        match self.handle_request_inner(method, params.clone()) {
            Ok(result) => {
                self.publish_success_event(method, &params, &result);
                // Structural mutations marked the journal dirty; persist now
                // that no data lock is held. Best effort: the request already
                // succeeded, so a failed disk write must not fail the answer.
                if self.journal_dirty.swap(false, Ordering::AcqRel) {
                    self.persist_session_journal();
                }
                success_response(id, result)
            }
            Err(err) => error_response(id, "builtin_error", err),
        }
    }

    pub(super) fn subscribe_events(&self) -> mpsc::Receiver<Value> {
        self.events.subscribe()
    }

    pub(super) fn publish_event(&self, event: &str, data: Value) {
        // The `.mutated` suffix is the single declaration of structural change
        // (stripped from the wire name): it marks the journal dirty, so a
        // future mutator publishing a structural event journals automatically
        // with no parallel whitelist to keep in sync.
        let (event_name, structural) = match event.strip_suffix(".mutated") {
            Some(base) => (base, true),
            None => (event, false),
        };
        if structural {
            self.journal_dirty.store(true, Ordering::Release);
        }
        self.events.publish(event_name, data);
    }

    pub(super) fn publish_success_event(&self, method: &str, params: &Value, result: &Value) {
        match method {
            "workspace.create" => self.publish_event("workspace.created.mutated", result.clone()),
            "workspace.rename" => self.publish_event("workspace.renamed.mutated", result.clone()),
            "workspace.close" => self.publish_event(
                "workspace.closed.mutated",
                json!({ "workspace_id": optional_string(params, "workspace_id") }),
            ),
            "tab.create" => self.publish_event("tab.created.mutated", result.clone()),
            "tab.rename" => self.publish_event("tab.renamed.mutated", result.clone()),
            "tab.close" => self.publish_event(
                "tab.closed.mutated",
                json!({ "tab_id": optional_string(params, "tab_id") }),
            ),
            // `tab.promote` returns the full result (workspace + tab + pane)
            // so clients can navigate from the HTTP response itself; the
            // events are for other connected browsers. workspace_created
            // marks whether a new workspace was created (refresh) or the tab
            // just moved into an existing one (cheaper tab.renamed refresh).
            "tab.promote" => {
                if result.get("workspace_created") == Some(&Value::Bool(true)) {
                    self.publish_event("workspace.created.mutated", result.clone())
                } else {
                    self.publish_event("tab.renamed.mutated", result.clone())
                }
            }
            "pane.close" => self.publish_event(
                "pane.closed.mutated",
                json!({ "pane_id": optional_string(params, "pane_id") }),
            ),
            "agent.start" => self.publish_event("workspace.created.mutated", result.clone()),
            "worktree.open" => self.publish_event("worktree.opened.mutated", result.clone()),
            "worktree.create" => self.publish_event("worktree.created.mutated", result.clone()),
            _ => {}
        }
    }

    pub(super) fn handle_request_inner(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method {
            "ping" => Ok(json!({
                "type": "pong",
                "version": BUILTIN_VERSION,
                "protocol": PROTOCOL_VERSION,
                "capabilities": {
                    "live_handoff": false,
                    "detached_server_daemon": false,
                    "builtin_backend": true,
                    "terminal_attach": true,
                    "terminal_server_scroll": false,
                    "jcode_detection": true
                }
            })),
            "server.stop" => Ok(json!({ "type": "ok" })),
            "session.snapshot" => {
                Ok(json!({ "type": "session_snapshot", "snapshot": self.snapshot()? }))
            }
            "workspace.list" => {
                Ok(json!({ "type": "workspace_list", "workspaces": self.workspace_list()? }))
            }
            "workspace.create" => {
                let cwd = optional_string(&params, "cwd").map(PathBuf::from);
                let label = optional_string(&params, "label");
                // Absent open_terminal keeps the legacy one-tab mint, so
                // non-web clients (Rust API client, TUI) see no change.
                let open_terminal = optional_bool(&params, "open_terminal").unwrap_or(true);
                let workspace = self.create_workspace(cwd, label, false, open_terminal)?;
                let tab = self
                    .tabs_for_workspace(workspace["workspace_id"].as_str().unwrap_or_default())?
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| json!({}));
                let pane = self
                    .panes_for_tab(tab["tab_id"].as_str().unwrap_or_default())?
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| json!({}));
                Ok(
                    json!({ "type": "workspace_created", "workspace": workspace, "tab": tab, "root_pane": pane }),
                )
            }
            "workspace.rename" => {
                let workspace_id = required_string(&params, "workspace_id")?;
                let label = required_string(&params, "label")?;
                let workspace = self.rename_workspace(&workspace_id, label)?;
                Ok(json!({ "type": "workspace_info", "workspace": workspace }))
            }
            "workspace.close" => {
                let workspace_id = required_string(&params, "workspace_id")?;
                self.close_workspace(&workspace_id)?;
                Ok(json!({ "type": "ok" }))
            }
            "tab.list" => Ok(
                json!({ "type": "tab_list", "tabs": self.tab_list(optional_string(&params, "workspace_id"))? }),
            ),
            "tab.create" => {
                let workspace_id = optional_string(&params, "workspace_id");
                let label = optional_string(&params, "label");
                let focus = optional_bool(&params, "focus").unwrap_or(true);
                let (tab, root_pane) = self.create_tab(workspace_id, label, focus)?;
                Ok(json!({ "type": "tab_created", "tab": tab, "root_pane": root_pane }))
            }
            "tab.rename" => {
                let tab_id = required_string(&params, "tab_id")?;
                let label = required_string(&params, "label")?;
                let tab = self.rename_tab(&tab_id, label)?;
                Ok(json!({ "type": "tab_info", "tab": tab }))
            }
            "tab.close" => {
                let tab_id = required_string(&params, "tab_id")?;
                self.close_tab(&tab_id)?;
                Ok(json!({ "type": "ok" }))
            }
            "tab.promote" => {
                let tab_id = required_string(&params, "tab_id")?;
                let result = self.promote_tab(&tab_id)?;
                Ok(result)
            }
            "pane.list" => Ok(
                json!({ "type": "pane_list", "panes": self.pane_list(optional_string(&params, "workspace_id"))? }),
            ),
            "pane.get" => {
                let pane_id = required_string(&params, "pane_id")?;
                Ok(json!({ "type": "pane_info", "pane": self.pane_info_by_id(&pane_id)? }))
            }
            "pane.layout" => Ok(
                json!({ "type": "pane_layout", "layout": self.layout(optional_string(&params, "pane_id"))? }),
            ),
            "pane.close" => {
                let pane_id = required_string(&params, "pane_id")?;
                self.close_pane(&pane_id)?;
                Ok(json!({ "type": "ok" }))
            }
            "agent.list" => Ok(json!({ "type": "agent_list", "agents": self.agent_list()? })),
            "pane.conversation" => {
                let pane_id = required_string(&params, "pane_id")?;
                // Page cursors (reference before/from parity): optional
                // strings; the chat lens passes them once it holds pages.
                let page = chat_lens::ConversationPage {
                    before: optional_string(&params, "before"),
                    from: optional_string(&params, "from"),
                };
                let result = self.pane_conversation(&pane_id, &page)?;
                Ok(json!({ "type": "pane_conversation", "conversation": result }))
            }
            "pane.conversation_image" => {
                // One image the conversation's image part named, by ref
                // (reference conversationImage parity): same resolution
                // pipeline as pane.conversation so the ref can only name
                // the session the page came from. {media_type, data} on
                // the wire, base64 as the reference carries it; null
                // output -> image_not_found at the route.
                let pane_id = required_string(&params, "pane_id")?;
                let reference = required_string(&params, "ref")?;
                let image = self.pane_conversation_image(&pane_id, &reference)?;
                Ok(json!({
                    "type": "pane_conversation_image",
                    "image": image.map(|(media_type, bytes)| json!({
                        "media_type": media_type,
                        "data": crate::jcode_transcript::base64_encode(&bytes),
                    })),
                }))
            }
            "pane.tool_output" => {
                // One whole tool output by call id (reference toolOutput
                // parity): the page carried a trimmed head + output_ref,
                // this returns the rest. Same resolution pipeline and
                // error codes as pane.conversation.
                let pane_id = required_string(&params, "pane_id")?;
                let reference = required_string(&params, "ref")?;
                let output = self.pane_tool_output(&pane_id, &reference)?;
                Ok(json!({ "type": "pane_tool_output", "output": output }))
            }
            "agent.start" => {
                let name = required_string(&params, "name")?;
                let argv = params
                    .get("argv")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let cwd = optional_string(&params, "cwd").map(PathBuf::from);
                let (agent, argv) = self.start_agent(name, argv, cwd)?;
                Ok(json!({ "type": "agent_started", "agent": agent, "argv": argv }))
            }
            "worktree.list" => self.worktree_list(optional_string(&params, "cwd")),
            "worktree.open" => self.worktree_open(params),
            "worktree.create" => self.worktree_create(params),
            "worktree.remove" => self.worktree_remove(params),
            // The TUI git/file panels run over the socket instead of the
            // HTTP API: the dispatch lives with the handlers themselves so
            // validation stays single-sourced between both transports.
            "git.status"
            | "git.diff"
            | "git.compare"
            | "git.branches"
            | "git.branch.delete"
            | "git.switch"
            | "git.log"
            | "git.path_info"
            | "git.permalink"
            | "git.blame"
            | "git.file"
            | "git.file_write"
            | "git.file_history"
            | "git.stashes"
            | "git.stash_show"
            | "git.conflicts"
            | "git.stage"
            | "git.unstage"
            | "git.discard"
            | "git.stash"
            | "git.stash_apply"
            | "git.stash_drop"
            | "git.reset"
            | "git.rebase"
            | "git.fetch"
            | "git.pull"
            | "git.push"
            | "git.commit"
            | "git.tag"
            | "git.apply_patch"
            | "git.conflict_resolve"
            | "git.conflict_action"
            | "git.cleanup_scan"
            | "git.worktree_remove"
            | "git.worktree_prune" => crate::git_ui::socket_dispatch(method, params),
            "file.tree"
            | "file.read"
            | "file.write"
            | "file.content_search"
            | "file.content_search_file"
            | "file.rename"
            | "file.delete" => crate::file_browser::socket_dispatch(method, params),
            "pane.read" => {
                let pane_id = required_string(&params, "pane_id")?;
                let format = optional_string(&params, "format");
                let screen = format.as_deref() == Some("screen");
                if !screen && format.is_some() {
                    return Err(format!("unknown pane.read format: {format:?}"));
                }
                let text = if screen {
                    self.read_pane_screen(&pane_id)?
                } else {
                    self.read_pane_recent(&pane_id)?
                };
                let format = if screen { "screen" } else { "text" };
                Ok(
                    json!({ "type": "pane_read", "read": { "pane_id": pane_id, "text": text, "format": format } }),
                )
            }
            "agent.prompt" => {
                // herdr's own agent.prompt takes `target` (agent name or
                // pane_id); our built-in accepts pane_id, with `target` as
                // the external-herdr-compatible alias so the same request
                // body works against both backends.
                let pane_id = params
                    .get("pane_id")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("target").and_then(Value::as_str))
                    .map(str::to_string)
                    .ok_or_else(|| "missing param pane_id".to_string())?;
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| "text is required".to_string())?;
                // herdr refuses an empty prompt with `empty_agent_prompt`;
                // trim check here because required_string-style filtering
                // would report a generic "required" instead.
                if text.trim().is_empty() {
                    return Err("empty_agent_prompt: agent prompt must not be empty".to_string());
                }
                let terminal = {
                    let data = self
                        .data
                        .lock()
                        .map_err(|_| "state unavailable".to_string())?;
                    let pane = data
                        .panes
                        .get(&pane_id)
                        .ok_or_else(|| format!("agent_not_found: pane {pane_id} not found"))?;
                    data.terminals.get(&pane.terminal_id).cloned()
                }
                .ok_or_else(|| "agent_not_found: terminal not found".to_string())?;
                if text.chars().count() > MAX_COMPOSER_CHARS {
                    return Err(
                        "message_too_long: composer message exceeds 20000 characters".to_string(),
                    );
                }
                // Long-press Send (enqueue): absent or false keeps the
                // legacy Enter submit, so older clients stay untouched.
                let enqueue = params
                    .get("enqueue")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if enqueue {
                    terminal.agent_prompt_enqueue(&text)?;
                } else {
                    terminal.agent_prompt(&text)?;
                }
                Ok(
                    json!({ "type": "agent_prompt", "pane_id": pane_id, "ok": true, "enqueue": enqueue }),
                )
            }
            other => Err(format!("built-in backend does not implement {other}")),
        }
    }

    pub(super) fn terminal(&self, terminal_id: &str) -> Option<Arc<TerminalRuntime>> {
        self.data
            .lock()
            .ok()
            .and_then(|data| data.terminals.get(terminal_id).cloned())
    }

    pub(super) fn create_workspace(
        &self,
        cwd: Option<PathBuf>,
        label: Option<String>,
        focus: bool,
        open_terminal: bool,
    ) -> Result<Value, String> {
        let cwd =
            cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let (workspace_id, tab_id, pane_id, terminal_id, has_focus_target) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let workspace_id = next_id(&mut data, "ws");
            let tab_id = next_id(&mut data, "tab");
            let pane_id = next_id(&mut data, "pane");
            let terminal_id = next_id(&mut data, "term");
            // Focus resolution reads the pre-spawn state; the insert pass
            // below applies the same rule against the same snapshot values.
            let has_focus_target = focus || data.focused_workspace_id.is_none();
            (workspace_id, tab_id, pane_id, terminal_id, has_focus_target)
        };
        let label = label.unwrap_or_else(|| workspace_label(&cwd));
        if open_terminal {
            let terminal = self.spawn_terminal(
                &terminal_id,
                &cwd,
                vec![self.default_shell.clone()],
                &workspace_id,
                &tab_id,
                &pane_id,
            )?;
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            data.workspaces.insert(
                workspace_id.clone(),
                WorkspaceRecord {
                    workspace_id: workspace_id.clone(),
                    label,
                    cwd: cwd.clone(),
                    tab_ids: vec![tab_id.clone()],
                },
            );
            data.tabs.insert(
                tab_id.clone(),
                TabRecord {
                    tab_id: tab_id.clone(),
                    workspace_id: workspace_id.clone(),
                    label: "Shell".to_string(),
                    pane_ids: vec![pane_id.clone()],
                },
            );
            data.panes.insert(
                pane_id.clone(),
                PaneRecord {
                    pane_id: pane_id.clone(),
                    terminal_id: terminal_id.clone(),
                    workspace_id: workspace_id.clone(),
                    tab_id: tab_id.clone(),
                    cwd,
                    label: None,
                    argv: vec![self.default_shell.clone()],
                },
            );
            data.terminals.insert(terminal_id, terminal);
            if has_focus_target {
                data.focused_workspace_id = Some(workspace_id.clone());
                data.focused_tab_id = Some(tab_id);
                data.focused_pane_id = Some(pane_id);
            }
        } else {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            // Zero-tab workspace: open_terminal=false skips the Shell tab
            // and root pane entirely. Focus lands on the workspace itself;
            // normalize_focus resolves tab/pane to None until a terminal is
            // spawned into it (POST /api/tabs reuses create_tab).
            data.workspaces.insert(
                workspace_id.clone(),
                WorkspaceRecord {
                    workspace_id: workspace_id.clone(),
                    label,
                    cwd,
                    tab_ids: Vec::new(),
                },
            );
            if focus || data.focused_workspace_id.is_none() {
                data.focused_workspace_id = Some(workspace_id.clone());
                data.focused_tab_id = None;
                data.focused_pane_id = None;
            }
        }
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let workspace = data
            .workspaces
            .get(&workspace_id)
            .map(|workspace| workspace_json(workspace, &data))
            .unwrap_or_else(|| json!({}));
        Ok(workspace)
    }

    pub(super) fn create_tab(
        &self,
        workspace_id: Option<String>,
        label: Option<String>,
        focus: bool,
    ) -> Result<(Value, Value), String> {
        let (workspace_id, cwd) = {
            let data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let workspace_id = workspace_id
                .or_else(|| data.focused_workspace_id.clone())
                .ok_or_else(|| "no workspace".to_string())?;
            let cwd = data
                .workspaces
                .get(&workspace_id)
                .map(|workspace| workspace.cwd.clone())
                .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
            (workspace_id, cwd)
        };
        let (tab_id, pane_id, terminal_id) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            (
                next_id(&mut data, "tab"),
                next_id(&mut data, "pane"),
                next_id(&mut data, "term"),
            )
        };
        let terminal = self.spawn_terminal(
            &terminal_id,
            &cwd,
            vec![self.default_shell.clone()],
            &workspace_id,
            &tab_id,
            &pane_id,
        )?;
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // The workspace can be closed while the spawn ran; fail instead of
        // resurrecting a workspace row the close already removed.
        if !data.workspaces.contains_key(&workspace_id) {
            return Err(format!("workspace {workspace_id} not found"));
        }
        data.tabs.insert(
            tab_id.clone(),
            TabRecord {
                tab_id: tab_id.clone(),
                workspace_id: workspace_id.clone(),
                label: label.unwrap_or_else(|| "Shell".to_string()),
                pane_ids: vec![pane_id.clone()],
            },
        );
        if let Some(workspace) = data.workspaces.get_mut(&workspace_id) {
            workspace.tab_ids.push(tab_id.clone());
        }
        data.panes.insert(
            pane_id.clone(),
            PaneRecord {
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                cwd,
                label: None,
                argv: vec![self.default_shell.clone()],
            },
        );
        data.terminals.insert(terminal_id, terminal);
        if focus
            || data.focused_workspace_id.is_none()
            || data.focused_tab_id.is_none()
            || data.focused_pane_id.is_none()
        {
            data.focused_workspace_id = Some(workspace_id);
            data.focused_tab_id = Some(tab_id.clone());
            data.focused_pane_id = Some(pane_id.clone());
        }
        let tab = tab_json(data.tabs.get(&tab_id).unwrap(), &data);
        let pane = pane_json(data.panes.get(&pane_id).unwrap(), &data);
        Ok((tab, pane))
    }

    pub(super) fn start_agent(
        &self,
        name: String,
        argv: Vec<String>,
        cwd: Option<PathBuf>,
    ) -> Result<(Value, Vec<String>), String> {
        let argv = if argv.is_empty() {
            vec![name.clone()]
        } else {
            argv
        };
        let cwd =
            cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let (workspace_id, tab_id, pane_id, terminal_id) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            (
                next_id(&mut data, "ws"),
                next_id(&mut data, "tab"),
                next_id(&mut data, "pane"),
                next_id(&mut data, "term"),
            )
        };
        let terminal = self.spawn_terminal(
            &terminal_id,
            &cwd,
            argv.clone(),
            &workspace_id,
            &tab_id,
            &pane_id,
        )?;
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        data.workspaces.insert(
            workspace_id.clone(),
            WorkspaceRecord {
                workspace_id: workspace_id.clone(),
                label: name.clone(),
                cwd: cwd.clone(),
                tab_ids: vec![tab_id.clone()],
            },
        );
        data.tabs.insert(
            tab_id.clone(),
            TabRecord {
                tab_id: tab_id.clone(),
                workspace_id: workspace_id.clone(),
                label: name.clone(),
                pane_ids: vec![pane_id.clone()],
            },
        );
        data.panes.insert(
            pane_id.clone(),
            PaneRecord {
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                cwd,
                label: Some(name),
                argv: argv.clone(),
            },
        );
        data.terminals.insert(terminal_id, terminal);
        data.focused_workspace_id = Some(workspace_id);
        data.focused_tab_id = Some(tab_id);
        data.focused_pane_id = Some(pane_id.clone());
        let pane = data.panes.get(&pane_id).unwrap();
        Ok((agent_json(pane, &data), argv))
    }

    pub(super) fn snapshot(&self) -> Result<Value, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(json!({
            "version": BUILTIN_VERSION,
            "protocol": PROTOCOL_VERSION,
            "focused_workspace_id": data.focused_workspace_id,
            "focused_tab_id": data.focused_tab_id,
            "focused_pane_id": data.focused_pane_id,
            "workspaces": workspace_list_json(&data),
            "tabs": tab_list_json(&data, None),
            "panes": pane_list_json(&data, None),
            "layouts": layout_list_json(&data),
            "agents": agent_list_json(&data),
        }))
    }

    pub(super) fn workspace_list(&self) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(workspace_list_json(&data))
    }

    pub(super) fn tab_list(&self, workspace_id: Option<String>) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(tab_list_json(&data, workspace_id.as_deref()))
    }

    pub(super) fn pane_list(&self, workspace_id: Option<String>) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(pane_list_json(&data, workspace_id.as_deref()))
    }

    pub(super) fn agent_list(&self) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(agent_list_json(&data))
    }

    /// Chat-lens transcript for one pane (design section 4). Thin: the
    /// wire carries turns, cursor, model, status, version. Errors use
    /// the route's design codes: `agent_not_found` (pane gone),
    /// `unsupported_agent` (no transcript support), `no_session_path` /
    /// `ambiguous` (resolution refused), `transcript_missing` (files
    /// unreadable or unparseable).
    pub(super) fn pane_conversation(
        &self,
        pane_id: &str,
        page: &chat_lens::ConversationPage,
    ) -> Result<Value, String> {
        let (pane, presentation) = self.pane_and_presentation(pane_id)?;
        let Some(agent) = presentation.agent else {
            return Err("unsupported_agent: no agent running in this pane".to_string());
        };
        if !chat_lens::agent_supported(Some(agent)) {
            return Err(format!(
                "unsupported_agent: {agent} has no transcript support"
            ));
        }
        chat_lens::conversation_payload_with(
            chat_lens::store_index(),
            &self.pane_context(&pane),
            page,
        )
    }

    /// One image by ref (reference conversationImage parity): same
    /// resolution pipeline and error codes as pane_conversation, so a
    /// ref can only name the session the page came from. Ok(None) ->
    /// image_not_found (rotated out, a ref that never existed).
    pub(super) fn pane_conversation_image(
        &self,
        pane_id: &str,
        reference: &str,
    ) -> Result<Option<(String, Vec<u8>)>, String> {
        if !crate::jcode_transcript::valid_tool_ref(reference) {
            return Ok(None);
        }
        let (pane, presentation) = self.pane_and_presentation(pane_id)?;
        let Some(agent) = presentation.agent else {
            return Err("unsupported_agent: no agent running in this pane".to_string());
        };
        if !chat_lens::agent_supported(Some(agent)) {
            return Err(format!(
                "unsupported_agent: {agent} has no transcript support"
            ));
        }
        chat_lens::conversation_image_with(
            chat_lens::store_index(),
            &self.pane_context(&pane),
            reference,
        )
    }

    /// One whole tool output by call id: reference toolOutput parity.
    /// Same resolution pipeline and error codes as pane_conversation,
    /// so a page that could show a trimmed head can always fetch the
    /// rest of THAT session's output. None -> tool_output_not_found
    /// (rotated out, cleared, or a ref that never existed).
    pub(super) fn pane_tool_output(
        &self,
        pane_id: &str,
        reference: &str,
    ) -> Result<Option<String>, String> {
        if !crate::jcode_transcript::valid_tool_ref(reference) {
            return Ok(None);
        }
        let (pane, presentation) = self.pane_and_presentation(pane_id)?;
        let Some(agent) = presentation.agent else {
            return Err("unsupported_agent: no agent running in this pane".to_string());
        };
        if !chat_lens::agent_supported(Some(agent)) {
            return Err(format!(
                "unsupported_agent: {agent} has no transcript support"
            ));
        }
        chat_lens::tool_output(&self.pane_context(&pane), reference)
    }

    /// Thin adapter: the pane and its agent presentation, behind the
    /// data lock. Shared head of pane_conversation and
    /// pane_tool_output (agent_not_found classification).
    pub(super) fn pane_and_presentation(
        &self,
        pane_id: &str,
    ) -> Result<(PaneRecord, PaneAgentPresentation), String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let pane = data
            .panes
            .get(pane_id)
            .ok_or_else(|| "agent_not_found: no such pane".to_string())?
            .clone();
        let presentation = pane_agent_presentation(&pane, &data);
        Ok((pane, presentation))
    }

    /// Thin adapter: gathers the plain-data context the chat module
    /// needs (live cwd, process map, pane tail) from terminal state.
    /// Chat logic never touches BuiltinState directly.
    pub(super) fn pane_context(&self, pane: &PaneRecord) -> chat_lens::PaneContext {
        let live_cwd = self
            .terminal(&pane.terminal_id)
            .and_then(|terminal| live_process_cwd(terminal.child_pid()))
            .unwrap_or_else(|| pane.cwd.clone());
        let processes: Vec<chat_lens::ProcessRow> = process_table()
            .unwrap_or_default()
            .iter()
            .map(|p| chat_lens::ProcessRow::new(p.pid, p.ppid))
            .collect();
        let terminal_pid = self
            .terminal(&pane.terminal_id)
            .and_then(|terminal| terminal.child_pid());
        let pane_tail = self
            .terminal(&pane.terminal_id)
            .map(|terminal| {
                // Simple ANSI strip, NOT the VT screen emulation of
                // history_tail_text: the tiebreak needs verbatim prompt
                // echo, and VT emulation lets spinner redraws/CR overwrite
                // it (found live: twin panes flipped ambiguous while a
                // tool ran). Same strip mode as pane.read on the wire.
                // Bounded tail (RESOLVE_TAIL_BYTES): the tiebreak matches
                // a <=400-char chunk of the candidate's last text
                // (jcode_transcript.rs last_substantial_text_chunk), so
                // the full 8MB strip was pure per-poll cost. The bound
                // only narrows the step-3 window: steps 1/1b/2 never
                // read pane_tail, and a candidate chunk older than 64KB
                // of scrollback only fails to match when the pane really
                // scrolled that far past it (the same candidate then
                // loses to ambiguity either way).
                terminal_text::strip_ansi_lossy(
                    &String::from_utf8_lossy(&terminal.history_tail_bytes(RESOLVE_TAIL_BYTES)),
                    terminal_text::StripCarriageReturn::Drop,
                )
            })
            .unwrap_or_default();
        chat_lens::PaneContext {
            live_cwd,
            terminal_pid,
            processes,
            pane_tail,
        }
    }

    pub(super) fn layout(&self, pane_id: Option<String>) -> Result<Value, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let tab_id = pane_id
            .as_deref()
            .and_then(|pane_id| data.panes.get(pane_id).map(|pane| pane.tab_id.clone()))
            .or_else(|| data.focused_tab_id.clone())
            .ok_or_else(|| "no focused tab".to_string())?;
        let tab = data
            .tabs
            .get(&tab_id)
            .ok_or_else(|| format!("tab {tab_id} not found"))?;
        Ok(layout_json(tab, &data))
    }

    pub(super) fn tabs_for_workspace(&self, workspace_id: &str) -> Result<Vec<Value>, String> {
        self.tab_list(Some(workspace_id.to_string()))
    }

    pub(super) fn panes_for_tab(&self, tab_id: &str) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(data
            .tabs
            .get(tab_id)
            .map(|tab| {
                tab.pane_ids
                    .iter()
                    .filter_map(|pane_id| data.panes.get(pane_id))
                    .map(|pane| pane_json(pane, &data))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub(super) fn pane_info_by_id(&self, pane_id: &str) -> Result<Value, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        data.panes
            .get(pane_id)
            .map(|pane| pane_json(pane, &data))
            .ok_or_else(|| format!("pane {pane_id} not found"))
    }

    pub(super) fn rename_workspace(
        &self,
        workspace_id: &str,
        label: String,
    ) -> Result<Value, String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        if let Some(workspace) = data.workspaces.get_mut(workspace_id) {
            workspace.label = label;
        } else {
            return Err(format!("workspace {workspace_id} not found"));
        }
        let workspace = data
            .workspaces
            .get(workspace_id)
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        Ok(workspace_json(workspace, &data))
    }

    pub(super) fn rename_tab(&self, tab_id: &str, label: String) -> Result<Value, String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        if let Some(tab) = data.tabs.get_mut(tab_id) {
            tab.label = label;
        } else {
            return Err(format!("tab {tab_id} not found"));
        }
        let tab = data
            .tabs
            .get(tab_id)
            .ok_or_else(|| format!("tab {tab_id} not found"))?;
        Ok(tab_json(tab, &data))
    }

    pub(super) fn close_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let workspace = data
            .workspaces
            .remove(workspace_id)
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        for tab_id in workspace.tab_ids {
            close_tab_locked(&mut data, &tab_id);
        }
        normalize_focus(&mut data);
        Ok(())
    }

    pub(super) fn close_tab(&self, tab_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // Explicit close on a missing tab is an error, not a silent no-op:
        // the old remove-and-ignore returned ok while the tab stayed gone
        // or was never there, which hid id-mismatch bugs (a scoped id the
        // server never knew) behind a 200. Teardown paths that may race a
        // close use close_tab_locked directly and stay best-effort.
        if !data.tabs.contains_key(tab_id) {
            return Err(format!("tab {tab_id} not found"));
        }
        close_tab_locked(&mut data, tab_id);
        // Closing the last tab keeps the workspace alive: terminals are
        // decoupled from workspace lifecycle, and a zero-tab workspace
        // stays open for file explorer, git, and agents until an explicit
        // workspace close removes it.
        normalize_focus(&mut data);
        Ok(())
    }

    /// Promotes a temporary terminal tab into a real workspace rooted at the
    /// terminal's CURRENT live path (the directory the shell `cd`-ed into),
    /// without stopping the process or closing the tab.
    ///
    /// Registry-only re-parent: the TabRecord/PaneRecord workspace_id fields
    /// are rewritten, the tab_id moves between the workspace tab_ids lists,
    /// and the emptied temporary workspace is dropped. `data.terminals` is
    /// never touched, so the PTY child keeps running and the attached
    /// browser keeps its live connection.
    pub(super) fn promote_tab(&self, tab_id: &str) -> Result<Value, String> {
        // Snapshot the tab/pane/terminal ids and the spawn cwd without
        // holding the lock during the filesystem probes.
        let (pane_id, terminal_id, pane_cwd) = {
            let data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let tab = data
                .tabs
                .get(tab_id)
                .ok_or_else(|| format!("tab {tab_id} not found"))?;
            let pane_id = tab
                .pane_ids
                .first()
                .cloned()
                .ok_or_else(|| format!("tab {tab_id} has no panes"))?;
            let pane = data
                .panes
                .get(&pane_id)
                .ok_or_else(|| format!("pane {pane_id} not found"))?;
            (pane_id, pane.terminal_id.clone(), pane.cwd.clone())
        };

        // Resolve the terminal's live cwd. A missing probe falls back to the
        // pane's registered cwd (same semantics as worktree_open's
        // canonicalize fallback).
        let live_cwd = self
            .terminal(&terminal_id)
            .and_then(|terminal| live_process_cwd(terminal.child_pid()))
            .unwrap_or(pane_cwd.clone());
        let canonical_live = std::fs::canonicalize(&live_cwd).unwrap_or(live_cwd.clone());

        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // Re-validate under the lock: the tab may have been closed while we
        // probed the filesystem.
        let tab = data
            .tabs
            .get_mut(tab_id)
            .ok_or_else(|| format!("tab {tab_id} not found"))?
            .clone();
        let old_workspace_id = tab.workspace_id.clone();

        // Guard: promoting into the workspace the tab already lives in is a
        // no-op error; the caller keeps the tab exactly as it was.
        let current_workspace_cwd = data
            .workspaces
            .get(&tab.workspace_id)
            .map(|workspace| {
                std::fs::canonicalize(&workspace.cwd).unwrap_or_else(|_| workspace.cwd.clone())
            })
            .unwrap_or_else(|| PathBuf::from(""));
        if current_workspace_cwd == canonical_live {
            return Err(format!(
                "tab {tab_id} already runs in workspace {} (cwd {})",
                tab.workspace_id,
                canonical_live.display()
            ));
        }

        // Find-or-create the workspace at the canonical live path, reusing
        // worktree_open semantics: canonicalize both sides so a temp cwd and
        // a user-typed path to the same folder meet.
        let existing_workspace_id = data
            .workspaces
            .values()
            .find(|workspace| {
                std::fs::canonicalize(&workspace.cwd).unwrap_or_else(|_| workspace.cwd.clone())
                    == canonical_live
            })
            .map(|workspace| workspace.workspace_id.clone());
        let (workspace_id, created_workspace) = match existing_workspace_id {
            Some(existing) => (existing, false),
            None => {
                let workspace_id = next_id(&mut data, "ws");
                data.workspaces.insert(
                    workspace_id.clone(),
                    WorkspaceRecord {
                        workspace_id: workspace_id.clone(),
                        label: workspace_label(&canonical_live),
                        cwd: canonical_live.clone(),
                        tab_ids: Vec::new(),
                    },
                );
                (workspace_id, true)
            }
        };

        // Registry-only re-parent. The order matters for the guard above:
        // rewrite the records before moving the tab_id so a panic mid-way can
        // never leave the tab in both lists (the ids stay unique because
        // every edit is under the same lock).
        {
            let tab_record = data
                .tabs
                .get_mut(tab_id)
                .expect("tab re-validated above under the same lock");
            tab_record.workspace_id = workspace_id.clone();
            if tab_record.label == "temp" {
                tab_record.label = "Shell".to_string();
            }
        }
        for pane_id in &tab.pane_ids {
            if let Some(pane) = data.panes.get_mut(pane_id) {
                pane.workspace_id = workspace_id.clone();
                pane.cwd = canonical_live.clone();
            }
        }
        if let Some(old_workspace) = data.workspaces.get_mut(&old_workspace_id) {
            old_workspace.tab_ids.retain(|id| id != tab_id);
        }
        if let Some(workspace) = data.workspaces.get_mut(&workspace_id) {
            workspace.tab_ids.push(tab_id.to_string());
        }

        // Drop the emptied temporary workspace. No terminals are left behind
        // (the promoted tab took the only panes with it), so this is purely
        // a registry removal; close_workspace's kill loop must NOT run.
        let mut dropped_temp_workspace = None;
        if let Some(old_workspace) = data.workspaces.get(&old_workspace_id) {
            if old_workspace.tab_ids.is_empty() {
                data.workspaces.remove(&old_workspace_id);
                dropped_temp_workspace = Some(old_workspace_id.clone());
            }
        }

        // Focus the promoted surface.
        data.focused_workspace_id = Some(workspace_id.clone());
        data.focused_tab_id = Some(tab_id.to_string());
        data.focused_pane_id = tab.pane_ids.first().cloned();

        normalize_focus(&mut data);

        let workspace = data
            .workspaces
            .get(&workspace_id)
            .map(|workspace| workspace_json(workspace, &data))
            .unwrap_or_else(|| json!({}));
        let tab_json_value = data
            .tabs
            .get(tab_id)
            .map(|tab| tab_json(tab, &data))
            .unwrap_or_else(|| json!({}));
        let pane_json_value = data
            .panes
            .get(&pane_id)
            .map(|pane| pane_json(pane, &data))
            .unwrap_or_else(|| json!({}));
        drop(data);

        // Events for OTHER connected browsers. The promoting client navigates
        // from the HTTP response (publish_success_event relays the full
        // result as workspace.created when a new workspace was made, or as
        // tab.renamed when the tab only moved into an existing one).
        if let Some(dropped) = dropped_temp_workspace {
            self.publish_event(
                "workspace.closed.mutated",
                json!({ "workspace_id": dropped }),
            );
        }

        Ok(json!({
            "type": "tab_promoted",
            "workspace_created": created_workspace,
            "workspace": workspace,
            "tab": tab_json_value,
            "root_pane": pane_json_value,
        }))
    }

    pub(super) fn close_pane(&self, pane_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // Same contract as close_tab: closing an unknown pane is an error,
        // not a silent no-op. The pane→tab cascade below runs only after
        // the pane is known to exist.
        if !data.panes.contains_key(pane_id) {
            return Err(format!("pane {pane_id} not found"));
        }
        // Get the tab_id before closing the pane
        let tab_id = data.panes.get(pane_id).map(|p| p.tab_id.clone());

        close_pane_locked(&mut data, pane_id);

        // Closing the last pane of a tab closes the tab (pane→tab cascade
        // keeps pane sets coherent), but the workspace stays alive: zero-tab
        // workspaces persist until an explicit workspace close.
        if let Some(tid) = tab_id {
            let should_close_tab = data
                .tabs
                .get(&tid)
                .map(|tab| tab.pane_ids.is_empty())
                .unwrap_or(true);
            if should_close_tab {
                close_tab_locked(&mut data, &tid);
                normalize_focus(&mut data);
                // Emit tab.closed event for the auto-closed tab
                self.publish_event("tab.closed.mutated", json!({ "tab_id": tid }));
            }
        }

        normalize_focus(&mut data);
        Ok(())
    }

    pub(super) fn read_pane_recent(&self, pane_id: &str) -> Result<String, String> {
        let terminal = self.terminal_for_read(pane_id)?;
        // Match external herdr's pane.read default (strip_ansi: true) so
        // inline-image payloads (Kitty APC, Sixel DCS, iTerm2 OSC 1337)
        // never leak as base64 garbage into API consumers. Drop mode keeps
        // CRLF line ends single, like herdr's grid-row join.
        Ok(terminal_text::strip_ansi_lossy(
            &String::from_utf8_lossy(&terminal.history_bytes()),
            terminal_text::StripCarriageReturn::Drop,
        ))
    }

    /// Screen-shaped pane.read (`format=screen`): VT-emulates a bounded
    /// scrollback tail instead of ANSI-stripping the full history. Fullscreen
    /// TUIs (jcode, claude) address the cursor and erase rows instead of
    /// printing lines; a plain strip leaves every draw fragment in the text,
    /// so the TUI tile/tail previews render glued garbage rows. Emulation
    /// applies erase/move/CR, recovering the composed screen. Bounded tail:
    /// a full-scrollback emulation on every 200ms tail poll would cost more
    /// than the strip it replaces (VT core is linear in input either way,
    /// but the strip walks the whole 8MB cap while this window stays 256KB).
    pub(super) fn read_pane_screen(&self, pane_id: &str) -> Result<String, String> {
        let terminal = self.terminal_for_read(pane_id)?;
        Ok(terminal.history_tail_text(PANE_READ_SCREEN_TAIL_BYTES))
    }

    /// Resolve a pane to its terminal for the pane.read family. Shared by
    /// both formats so the error shape stays identical.
    pub(super) fn terminal_for_read(&self, pane_id: &str) -> Result<Arc<TerminalRuntime>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let pane = data
            .panes
            .get(pane_id)
            .ok_or_else(|| format!("pane {pane_id} not found"))?;
        data.terminals
            .get(&pane.terminal_id)
            .cloned()
            .ok_or_else(|| "terminal not found".to_string())
    }

    pub(super) fn worktree_list(&self, cwd: Option<String>) -> Result<Value, String> {
        let cwd = cwd
            .map(PathBuf::from)
            .or_else(|| {
                self.data.lock().ok().and_then(|data| {
                    data.focused_workspace_id
                        .as_ref()
                        .and_then(|id| data.workspaces.get(id))
                        .map(|ws| ws.cwd.clone())
                })
            })
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let repo_root = git_output(&cwd, &["rev-parse", "--show-toplevel"])
            .unwrap_or_else(|_| cwd.to_string_lossy().to_string());
        let list = git_output(Path::new(&repo_root), &["worktree", "list", "--porcelain"]);
        // A plain folder is not a git failure: `worktree list --porcelain`
        // errors there too, but the folder is exactly what the caller
        // asked to browse, so empty rows keep the cwd identity and no error
        // rides the envelope. A git failure inside a repo checkout (broken
        // git binary, damaged worktree admin) must not masquerade as an
        // empty list: it is reported so clients can distinguish "no
        // worktrees" from "discovery failed".
        let (list, git_error) = match list {
            Ok(list) => (list, None),
            Err(err) => {
                let inside_repo = Path::new(&repo_root).join(".git").exists();
                if inside_repo {
                    (String::new(), Some(err))
                } else {
                    (String::new(), None)
                }
            }
        };
        let mut worktrees = parse_git_worktrees(&list);
        // `rev-parse --show-toplevel` reports the queried checkout's own
        // toplevel, so inside a linked worktree it names the lane, not the
        // repository. `worktree list --porcelain` always leads with the
        // main checkout, so the first row is the true repository root and
        // name; callers derive main-vs-linked from it (the row flag is
        // unreliable: the parser marks every row linked). An empty list
        // (plain folder, broken git) keeps the toplevel/cwd identity.
        let repo_root = worktrees
            .first()
            .and_then(|row| row.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(repo_root);
        let repo_name = Path::new(&repo_root)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("repo")
            .to_string();
        enrich_worktree_commit_dates(&mut worktrees);
        worktrees.sort_by_key(|row| std::cmp::Reverse(worktree_activity_key(row)));
        Ok(json!({
            "type": "worktree_list",
            "source": {
                "repo_key": repo_root,
                "repo_name": repo_name,
                "repo_root": repo_root,
                "source_checkout_path": cwd.to_string_lossy(),
                "source_workspace_id": null,
            },
            "worktrees": worktrees,
            "git_error": git_error,
        }))
    }

    pub(super) fn worktree_open(&self, params: Value) -> Result<Value, String> {
        let path = optional_string(&params, "path")
            .or_else(|| optional_string(&params, "cwd"))
            .ok_or_else(|| "path or cwd is required".to_string())?;
        let label = optional_string(&params, "label");
        let canonical_path =
            std::fs::canonicalize(Path::new(&path)).unwrap_or_else(|_| PathBuf::from(&path));
        // Herdr parity: opening a checkout that is already open as a
        // workspace focuses that workspace instead of creating a duplicate.
        let existing_workspace = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let existing = data
                .workspaces
                .values()
                .find(|workspace| {
                    std::fs::canonicalize(&workspace.cwd).unwrap_or_else(|_| workspace.cwd.clone())
                        == canonical_path
                })
                .map(|workspace| workspace.workspace_id.clone());
            match existing {
                Some(workspace_id) => {
                    // Herdr parity: a supplied label renames the existing
                    // workspace even when it is already open.
                    if let Some(label) = &label {
                        if let Some(workspace) = data.workspaces.get_mut(&workspace_id) {
                            workspace.label = label.clone();
                        }
                    }
                    let workspace = data
                        .workspaces
                        .get(&workspace_id)
                        .map(|workspace| workspace_json(workspace, &data))
                        .unwrap_or_else(|| json!({}));
                    data.focused_workspace_id = Some(workspace_id.clone());
                    data.focused_tab_id = data
                        .workspaces
                        .get(&workspace_id)
                        .and_then(|workspace| workspace.tab_ids.first().cloned());
                    data.focused_pane_id = data
                        .focused_tab_id
                        .as_ref()
                        .and_then(|tab_id| data.tabs.get(tab_id))
                        .and_then(|tab| tab.pane_ids.first().cloned());
                    Some(workspace)
                }
                None => None,
            }
        };
        let (workspace, already_open) = match existing_workspace {
            Some(workspace) => (workspace, true),
            None => (
                self.create_workspace(
                    Some(PathBuf::from(&path)),
                    label,
                    true,
                    optional_bool(&params, "open_terminal").unwrap_or(true),
                )?,
                false,
            ),
        };
        let workspace_id = workspace["workspace_id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let tab = self
            .tabs_for_workspace(&workspace_id)?
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({}));
        let pane = self
            .panes_for_tab(tab["tab_id"].as_str().unwrap_or_default())?
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({}));
        Ok(json!({
            "type": "worktree_opened",
            "workspace": workspace,
            "tab": tab,
            "root_pane": pane,
            "worktree": { "path": path, "branch": optional_string(&params, "branch"), "is_bare": false, "is_detached": false, "is_prunable": false, "is_linked_worktree": true, "open_workspace_id": workspace_id, "label": workspace_id },
            "already_open": already_open,
        }))
    }

    /// Remove a git worktree from its repo. Mirrors the WebUI
    /// /api/worktrees/remove-path semantics: `repo_root` scopes the git
    /// invocation, `path` is the worktree directory to remove, `force`
    /// maps to `git worktree remove --force`. Emits `worktree.removed`.
    /// A `workspace_id` in params resolves the path from the open
    /// workspace's cwd and scopes the git invocation to that cwd (git
    /// resolves the main repo from any checkout, including the worktree
    /// itself), which is what the workspace-scoped WebUI route sends.
    pub(super) fn worktree_remove(&self, params: Value) -> Result<Value, String> {
        let workspace_id = optional_string(&params, "workspace_id");
        let mut params = params;
        if optional_string(&params, "path").is_none() {
            if let Some(workspace_id) = workspace_id.as_deref() {
                let data = self
                    .data
                    .lock()
                    .map_err(|_| "state unavailable".to_string())?;
                let workspace = data
                    .workspaces
                    .get(workspace_id)
                    .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
                let cwd = workspace.cwd.to_string_lossy().to_string();
                if let Some(object) = params.as_object_mut() {
                    object.insert("path".to_string(), json!(cwd));
                    object.insert("repo_root".to_string(), json!(cwd));
                }
            }
        }
        let repo_root = optional_string(&params, "repo_root")
            .or_else(|| optional_string(&params, "cwd"))
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "repo_root is required".to_string())?;
        let path = required_string(&params, "path")?;
        let force = optional_bool(&params, "force").unwrap_or(false);
        let repo = Path::new(&repo_root);
        if !repo.is_dir() {
            return Err(format!("repo_root is not a directory: {}", repo.display()));
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path);
        // Canonicalize while the directory still exists: after run_git
        // removes it, canonicalize fails on both sides and each falls
        // back to its raw spelling, so a workspace opened through a
        // symlinked prefix (/tmp vs /private/tmp on macOS) removed via
        // the other spelling would linger with a dead cwd. A relative
        // `path` resolves against repo_root (same base git uses), not
        // the server process cwd. Snapshot the match set now, tear
        // down after git succeeds.
        let mut removed_path = PathBuf::from(&path);
        if removed_path.is_relative() {
            removed_path = repo.join(&removed_path);
        }
        let canonical_removed = removed_path
            .canonicalize()
            .unwrap_or_else(|_| removed_path.clone());
        let matching_workspaces: Vec<String> = {
            let data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            data.workspaces
                .iter()
                .filter(|(_, workspace)| {
                    workspace
                        .cwd
                        .canonicalize()
                        .unwrap_or_else(|_| workspace.cwd.clone())
                        == canonical_removed
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        run_git(repo, &args)?;
        // The webui's worktree.list cache may hold pre-remove rows for the
        // repo root and the removed checkout; the removed event refreshes
        // clients, but a cached answer would still serve the old rows.
        crate::worktree_cache_invalidated(&repo.to_string_lossy());
        crate::worktree_cache_invalidated(&path);

        // The worktree directory is gone: every open workspace rooted
        // there would keep a dead cwd, dead PTYs, and a snapshot entry no
        // filesystem backs. Close those workspaces with the same teardown
        // as workspace.close (tabs, panes, PTYs) so polls and snapshots
        // stop listing the removed worktree.
        let dropped_workspaces: Vec<String> = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let dropped = matching_workspaces
                .into_iter()
                .filter_map(|ws_id| {
                    let workspace = data.workspaces.remove(&ws_id)?;
                    for tab_id in workspace.tab_ids {
                        close_tab_locked(&mut data, &tab_id);
                    }
                    Some(ws_id)
                })
                .collect();
            normalize_focus(&mut data);
            dropped
        };
        for ws_id in &dropped_workspaces {
            self.publish_event("workspace.closed.mutated", json!({ "workspace_id": ws_id }));
        }
        let result = json!({
            "type": "worktree_removed",
            "path": path,
            "repo_root": repo.to_string_lossy(),
            // The id disambiguates the payload when two open workspaces
            // share one folder path (path-only matching would drop both
            // client-side or the wrong one).
            "workspace_ids": dropped_workspaces,
        });
        self.publish_event("worktree.removed.mutated", result.clone());
        Ok(result)
    }

    pub(super) fn worktree_create(&self, params: Value) -> Result<Value, String> {
        let cwd = optional_string(&params, "cwd")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "cwd is required".to_string())?;
        let branch =
            optional_string(&params, "branch").unwrap_or_else(|| format!("webui-{}", now_ms()));
        let base = optional_string(&params, "base").unwrap_or_else(|| "HEAD".to_string());
        // Webui inline-form parity: pull the base ref (fast-forward
        // only) before creating, so the new worktree starts from the
        // remote tip. Diverged bases surface the git error verbatim
        // for the client's continue-without-pull path.
        if optional_bool(&params, "pull_base").unwrap_or(false) {
            self.pull_base_branch(&cwd, &base)?;
        }
        let path = optional_string(&params, "path")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.parent().unwrap_or_else(|| Path::new(".")).join(&branch));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        run_git(
            &cwd,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &path.to_string_lossy(),
                &base,
            ],
        )?;
        // Same rule as remove: a new row exists that a cached
        // worktree.list answer predates.
        crate::worktree_cache_invalidated(&cwd.to_string_lossy());
        crate::worktree_cache_invalidated(&path.to_string_lossy());
        self.worktree_open(json!({ "path": path.to_string_lossy(), "branch": branch, "label": optional_string(&params, "label") }))
            .map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert("type".to_string(), json!("worktree_created"));
                }
                value
            })
    }

    pub(super) fn pull_base_branch(&self, cwd: &Path, base: &str) -> Result<(), String> {
        // --no-rebase keeps the fast-forward promise even when the user has
        // pull.rebase configured globally; a rebase on a dirty tree would fail
        // where a fast-forward would succeed.
        let args: Vec<&str> = if base == "HEAD" {
            vec!["pull", "--ff-only", "--no-rebase"]
        } else {
            vec!["pull", "--ff-only", "--no-rebase", "origin", base]
        };
        run_git(cwd, &args).map_err(|err| format!("git pull: {err}"))
    }
}

pub(super) fn close_tab_locked(data: &mut BuiltinData, tab_id: &str) {
    if let Some(tab) = data.tabs.remove(tab_id) {
        for pane_id in tab.pane_ids {
            close_pane_locked(data, &pane_id);
        }
        if let Some(workspace) = data.workspaces.get_mut(&tab.workspace_id) {
            workspace.tab_ids.retain(|id| id != tab_id);
        }
    }
}

pub(super) fn close_pane_locked(data: &mut BuiltinData, pane_id: &str) {
    if let Some(pane) = data.panes.remove(pane_id) {
        data.terminals.remove(&pane.terminal_id);
        if let Some(tab) = data.tabs.get_mut(&pane.tab_id) {
            tab.pane_ids.retain(|id| id != pane_id);
        }
    }
}

impl BuiltinState {
    /// Write the journal atomically. Best effort by contract: callers
    /// treat a failed write as non-fatal because the in-memory session
    /// keeps working either way.
    pub(super) fn persist_session_journal(&self) {
        let Some(path) = self.journal_path.clone() else {
            return;
        };
        let journal = match self.data.lock() {
            Ok(data) => journal_from_data(&data, &self.default_shell),
            Err(_) => return,
        };
        // Chain shape (same trick as atomic_write's dir sync): the Err
        // branch lives inside std's Result::and_then, instrumented code
        // only ever sees the Ok path.
        let _ = serde_json::to_vec_pretty(&journal)
            .map_err(std::io::Error::from)
            .and_then(|payload| {
                if let Some(dir) = path.parent() {
                    let _ = fs::create_dir_all(dir);
                }
                crate::server_settings::atomic_write(&path, &payload)
            });
    }
}

pub(super) fn normalize_focus(data: &mut BuiltinData) {
    // Keep the focused workspace whenever it still exists: zero-tab
    // workspaces are valid surfaces now, so a missing tab/pane must not
    // yank focus to an arbitrary other workspace.
    let workspace = data
        .focused_workspace_id
        .as_ref()
        .and_then(|id| data.workspaces.get(id).map(|ws| ws.workspace_id.clone()))
        .or_else(|| {
            data.workspaces
                .values()
                .next()
                .map(|ws| ws.workspace_id.clone())
        });
    let Some(workspace) = workspace else {
        data.focused_workspace_id = None;
        data.focused_tab_id = None;
        data.focused_pane_id = None;
        return;
    };
    data.focused_workspace_id = Some(workspace.clone());
    // A focused tab that no longer exists (or a workspace with zero
    // tabs) resolves to no tab; the pane follows the resolved tab.
    data.focused_tab_id = data
        .focused_tab_id
        .as_ref()
        .filter(|tab_id| {
            data.tabs
                .get(*tab_id)
                .is_some_and(|tab| tab.workspace_id == workspace)
        })
        .cloned()
        .or_else(|| {
            data.workspaces
                .get(&workspace)
                .and_then(|ws| ws.tab_ids.first().cloned())
        });
    data.focused_pane_id = data
        .focused_pane_id
        .as_ref()
        .filter(|pane_id| {
            data.panes
                .get(*pane_id)
                .is_some_and(|pane| pane.tab_id == data.focused_tab_id.clone().unwrap_or_default())
        })
        .cloned()
        .or_else(|| {
            data.focused_tab_id
                .as_ref()
                .and_then(|tab_id| data.tabs.get(tab_id))
                .and_then(|tab| tab.pane_ids.first().cloned())
        });
}

pub(super) fn next_id(data: &mut BuiltinData, prefix: &str) -> String {
    let id = data.next_id;
    data.next_id += 1;
    format!("{prefix}_{id}")
}
