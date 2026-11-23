//! Core TuiApp methods: constructors, state accessors, overlays.

use super::*;

impl TuiApp {
    pub fn new(client: BackendClient, refresh_interval: Duration) -> Self {
        Self::new_with_theme(client, refresh_interval, TuiTheme::Dark)
    }

    pub fn new_with_theme(
        client: BackendClient,
        refresh_interval: Duration,
        theme: TuiTheme,
    ) -> Self {
        Self::new_with_options(
            client,
            refresh_interval,
            theme,
            WebApiClient::new("127.0.0.1", default_web_api_port()),
        )
    }

    pub fn new_with_options(
        client: BackendClient,
        refresh_interval: Duration,
        theme: TuiTheme,
        web_api: WebApiClient,
    ) -> Self {
        let cwd = "";
        // Read before the literal moves `client` into the struct.
        let current_session = client.session_name();
        Self {
            client,
            web_api,
            snapshot: TuiSnapshot::default(),
            selected_workspace: 0,
            selected_agent: 0,
            sidebar_focus: SidebarFocus::Workspaces,
            sidebar_collapsed: false,
            main_focused: true,
            mode: TuiMode::Navigate,
            screen: TuiScreen::Terminal,
            prefix: PrefixState::new(),
            terminal_prefix_passthrough: tui_terminal_prefix_passthrough(),
            file_explorer: FileExplorer::new(cwd),
            git_panel: GitPanel::new(cwd),
            commit_input: None,
            prompt_input: None,
            pane_tail: Vec::new(),
            pane_tail_styles: Vec::new(),
            pane_scroll: 0,
            pane_history: Vec::new(),
            pane_buffers_pane_id: None,
            pane_history_exhausted: false,
            split_tree: split::SplitNode::leaf(""),
            split_focus: None,
            split_zoomed: false,
            split_panes_of_workspaces: Vec::new(),
            split_mode: None,
            move_mode: None,
            resize_mode: None,
            last_resize_dir: None,
            just_closed_mode: false,
            tile_tails: std::collections::HashMap::new(),
            tile_tail_rx: None,
            tile_geometry: std::cell::RefCell::new(Vec::new()),
            terminal_raw_output: String::new(),
            terminal_raw_terminal_id: None,
            terminal_size: (0, 0),
            status: "connecting".to_string(),
            status_hold_until: None,
            error: None,
            refresh_inflight: None,
            stamp_inflight: Vec::new(),
            stamp_cache: std::collections::HashMap::new(),
            last_refresh: None,
            last_tail_refresh: None,
            refresh_interval,
            theme,
            palette: Palette::for_theme(theme),
            tick: 0,
            worktree_create_stage: None,
            workspace_create_stage: None,
            worktree_rows: Vec::new(),
            worktree_selected: 0,
            worktree_filter: String::new(),
            worktree_root: String::new(),
            worktree_folder_rows: Vec::new(),
            worktree_pick_workspace: false,
            branch_picker_rows: Vec::new(),
            branch_picker_selected: 0,
            branch_picker_filter: String::new(),
            branch_picker_root: String::new(),
            rebase_pending_upstream: None,
            help_scroll: 0,
            help_filter: String::new(),
            search_palette: search::SearchPalette::default(),
            lens: LensState::default(),
            session_rows: Vec::new(),
            session_selected: 0,
            session_load_error: None,
            current_session,
            current_backend: "builtin".to_string(),
            session_generation: 0,
            composer_drafts: std::collections::HashMap::new(),
            quit_prev_mode: TuiMode::Navigate,
            overlay_stack: Vec::new(),
            tour_index: 0,
            tour_finished: false,
            tour_demo_overlay: None,
            dirty: true,
        }
    }

    /// Record the full TUI screen size (the binary loop calls this at
    /// startup and on every Resize event). Everything that attaches a
    /// pty afterwards sizes it to the pane viewport, not this value.
    pub fn set_terminal_size(&mut self, cols: u16, rows: u16) {
        self.terminal_size = (cols, rows);
    }

    /// (cols, rows) every attach must use: the pane viewport the tail
    /// renders into when the screen size is known, else the legacy
    /// 120x32 fallback (no real screen: --once, embedders, tests).
    /// With a split on screen the focused tile's inner rect is the
    /// real viewport (design: "the pty resizes to the focused tile's
    /// viewport, not the window"); tile borders cost 2 cols/rows,
    /// the cwd/status/blank rows 3 more when the tail starts.
    pub fn attach_viewport(&self) -> (u16, u16) {
        if render::split_active(self) {
            if let Some(focus) = self.focused_pane_id() {
                let geometry = self.tile_geometry.borrow();
                if let Some(tile) = geometry.iter().find(|tile| tile.pane_id == focus) {
                    let cols = tile.width.saturating_sub(2).max(1);
                    let rows = tile.height.saturating_sub(5).max(1);
                    return (cols, rows);
                }
            }
        }
        let (width, height) = self.terminal_size;
        if width > 0 && height > 0 {
            render::pane_viewport_size(width, height, self.sidebar_collapsed)
        } else {
            (120, 32)
        }
    }

    /// Focused UI context for the statusbar hint (lazygit-style context
    /// resolution): resolves in the same priority order as `handle_key`,
    /// so the hint always describes the keys that actually do something
    /// right now.
    pub(crate) fn footer_context(&self) -> FooterContext {
        // Input-capture layers own the keyboard, in handle_key order:
        // commit input, then prompt input, then the panel-local bars.
        if self.commit_input.is_some() {
            return FooterContext::CommitInput;
        }
        if let Some(prompt) = self.prompt_input.as_ref() {
            return FooterContext::PromptInput(prompt.kind);
        }
        if self.git_panel.diff_search_active {
            return FooterContext::DiffSearch;
        }
        if self.file_explorer.editor_find.active {
            return FooterContext::EditorFind;
        }
        if self.file_explorer.edit_active {
            return FooterContext::FileEdit;
        }
        if self.file_explorer.filter_active {
            return FooterContext::FilterBar;
        }
        if self.file_explorer.search_mode
            && self.file_explorer.search_kind == SearchKind::Content
            && self.file_explorer.content_search.has_results()
        {
            return FooterContext::ContentSearch;
        }
        // Overlays.
        match self.mode {
            TuiMode::ConfirmQuit => return FooterContext::ConfirmQuit,
            TuiMode::Help => return FooterContext::HelpOverlay,
            TuiMode::Tour => return FooterContext::TourOverlay,
            TuiMode::Settings => return FooterContext::SettingsOverlay,
            TuiMode::WorktreeList => return FooterContext::WorktreeList,
            TuiMode::BranchPicker => return FooterContext::BranchPicker,
            TuiMode::SearchPalette => return FooterContext::SearchPalette,
            TuiMode::SessionManager => return FooterContext::SessionManager,
            _ => {}
        }
        // The lens overlays the terminal screen (both Navigate and
        // Attach); it owns the scrolling keys while open.
        if self.lens.active && self.screen == TuiScreen::Terminal {
            return FooterContext::Lens;
        }
        // Screens and sub-views.
        match self.screen {
            TuiScreen::Terminal => {
                // Focus-aware hint (ux fix): with the MAIN region focused
                // (the default), j/k are dead on the pane — the hint must
                // not advertise list keys. Only the sidebar regions get
                // the select/attach hint; attach mode owns the hint as
                // before (the focus walker does not apply there).
                if self.mode == TuiMode::Navigate && self.main_focused {
                    if crate::tui::render::split_active(self) {
                        FooterContext::TerminalMainSplit
                    } else {
                        FooterContext::TerminalMain
                    }
                } else {
                    FooterContext::Terminal(self.mode)
                }
            }
            TuiScreen::Files => FooterContext::Files(self.mode),
            TuiScreen::Git => FooterContext::Git(self.mode, self.git_panel.view),
        }
    }

    /// Workspace id out of an open-recent response: prefer the
    /// workspace object's id, fall back to the top-level field.
    pub(crate) fn recent_workspace_id(workspace: Option<&Value>, result: Option<&Value>) -> String {
        Self::recent_open_field(workspace, "workspace_id")
            .or_else(|| Self::recent_open_field(result, "workspace_id"))
            .unwrap_or_default()
            .to_string()
    }

    /// The cwd used for files/git panels: selected workspace cwd, falling back
    /// to the selected agent cwd.
    pub fn active_cwd(&self) -> Option<String> {
        let workspace_cwd = self
            .selected_workspace()
            .map(|workspace| workspace.cwd.clone())
            .filter(|cwd| !cwd.is_empty());
        workspace_cwd.or_else(|| {
            self.selected_agent()
                .map(|agent| agent.cwd.clone())
                .filter(|cwd| !cwd.is_empty())
        })
    }

    /// Set an action notice and arm the hold; public for the binary
    /// loop's feedback paths that live outside `handle_key`.
    pub fn set_status_notice(&mut self, message: String) {
        self.status = message;
        self.status_hold_until = Some(Instant::now() + STATUS_HOLD);
    }

    /// Report a live-terminal failure (server shutdown, broken pipe)
    /// and arm the hold so the next refresh cannot wipe the reason
    /// before the user reads it: `apply_refresh` clears `error` on
    /// every successful snapshot, and a drain-detach error is exactly
    /// the "action that just reported its outcome" the hold exists
    /// for. The footer already ranks `error` above `status`.
    pub fn report_terminal_error(&mut self, message: String) {
        self.error = Some(message);
        self.status_hold_until = Some(Instant::now() + STATUS_HOLD);
    }

    /// Arm the hold when a key path replaced the status line.
    pub(crate) fn hold_status_if_changed(&mut self, before: &str) {
        if self.status != before {
            self.status_hold_until = Some(Instant::now() + STATUS_HOLD);
        }
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn take_dirty(&mut self) -> bool {
        let dirty = self.dirty;
        self.dirty = false;
        dirty
    }

    pub fn selected_workspace(&self) -> Option<&TuiWorkspace> {
        self.snapshot.workspaces.get(self.selected_workspace)
    }

    pub fn selected_agent(&self) -> Option<&TuiAgent> {
        self.snapshot.agents.get(self.selected_agent)
    }

    /// Chat lens support for the selected pane (design section 6,
    /// webui parity): the pane needs an `agent_session` object with a
    /// supported provider kind. `resolvable: false` still counts as
    /// supported — the lens then shows the refusal instead of turns.
    /// Used by the pane-switch force-off path; the shortcut handler
    /// reads the session directly (it needs the reason too).
    pub(crate) fn lens_chat_supported(&self) -> LensGate {
        match self
            .view_pane()
            .and_then(|pane| pane.agent_session.as_ref())
        {
            Some(session) if session.chat_supported() => LensGate::Supported,
            Some(_) => LensGate::UnsupportedKind,
            None => LensGate::NoSession,
        }
    }

    pub fn selected_pane(&self) -> Option<&TuiPane> {
        // The agent cursor is authoritative when it points at a pane in
        // the selected workspace: the panel walk (Ctrl+B ] / [) and the
        // agent list both move `selected_agent`, and the viewed pane
        // must follow them even while the workspace list owns the
        // sidebar focus (otherwise the tab marker, pane header, tail,
        // and Enter-attach would all target the backend-active tab
        // instead of the panel the user walked to).
        if let Some(agent) = self.selected_agent() {
            if let Some(pane) = self
                .snapshot
                .panes
                .iter()
                .find(|pane| pane.id == agent.pane_id)
            {
                let workspace_id = self
                    .snapshot
                    .workspaces
                    .get(self.selected_workspace)
                    .map(|workspace| workspace.id.as_str());
                if workspace_id == Some(pane.workspace_id.as_str()) {
                    return Some(pane);
                }
            }
        }
        let workspace = self.selected_workspace()?;
        let workspace_id = workspace.id.as_str();
        let active_tab_id = workspace.active_tab_id.as_deref();
        self.snapshot
            .panes
            .iter()
            .find(|pane| {
                pane.workspace_id == *workspace_id
                    && active_tab_id
                        .map(|tab_id| tab_id == pane.tab_id)
                        .unwrap_or(true)
            })
            .or_else(|| {
                self.snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.workspace_id == *workspace_id)
            })
    }

    pub fn selected_terminal_id(&self) -> Option<&str> {
        self.selected_pane().map(|pane| pane.terminal_id.as_str())
    }

    /// The pane the main view acts on. With a split on screen the
    /// focused tile owns the tail, scroll, lens, composer, and
    /// Enter-attach (design: "Enter attaches the focused tile"),
    /// so the pipeline must follow `split_focus`, not the sidebar
    /// cursor; the sidebar keeps its own selection untouched.
    /// Without a split this is exactly `selected_pane()`.
    pub fn view_pane(&self) -> Option<&TuiPane> {
        if render::split_active(self) {
            if let Some(focus) = self.focused_pane_id() {
                // `focused_pane_id` only returns ids of panes present in
                // the snapshot (both its focus and leaf-fallback arms
                // filter on `panes`), so this lookup cannot miss; the
                // expect documents that invariant instead of a dead
                // miss-arm.
                let pane = self
                    .snapshot
                    .panes
                    .iter()
                    .find(|p| p.id == focus)
                    .expect("focused_pane_id only returns ids of live panes");
                return Some(pane);
            }
        }
        self.selected_pane()
    }

    pub fn view_pane_id(&self) -> Option<String> {
        self.view_pane().map(|pane| pane.id.clone())
    }

    /// Tab id of the panel in view (webui `state.tab` parity): the
    /// focused tile's tab on a split screen, otherwise the
    /// sidebar-selected pane's tab. The pane strip marks this tab
    /// active, so close and rename target it.
    pub fn view_tab_id(&self) -> Option<String> {
        self.view_pane().map(|pane| pane.tab_id.clone())
    }

    pub fn view_terminal_id(&self) -> Option<&str> {
        self.view_pane().map(|pane| pane.terminal_id.as_str())
    }

    pub fn should_quit(&self) -> bool {
        self.status == "quit"
    }
}
