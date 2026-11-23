//! Scrollback, history deepening, and pane tail helpers.

use super::*;

impl TuiApp {
    pub fn text_snapshot(&self) -> String {
        let mut out = Vec::new();
        out.push(format!("Herdr WebUI TUI · {}", self.status));
        if let Some(error) = &self.error {
            out.push(format!("error: {error}"));
        }
        out.push(format!(
            "workspaces={} tabs={} panes={} agents={} screen={}",
            self.snapshot.workspaces.len(),
            self.snapshot.tabs.len(),
            self.snapshot.panes.len(),
            self.snapshot.agents.len(),
            self.screen.title(),
        ));
        if let Some(cwd) = self.active_cwd() {
            out.push(format!("active cwd {cwd}"));
        }
        if let Some(workspace) = self.selected_workspace() {
            out.push(format!(
                "workspace {} · {} · {} · {} panes",
                workspace.id, workspace.label, workspace.agent_status, workspace.pane_count
            ));
        }
        if let Some(agent) = self.selected_agent() {
            let name = agent
                .display_agent
                .as_deref()
                .or(agent.agent.as_deref())
                .unwrap_or("agent");
            out.push(format!(
                "agent {name} · {} · pane {} · terminal {}",
                agent.status, agent.pane_id, agent.terminal_id
            ));
        }
        if let Some(pane) = self.view_pane() {
            out.push(format!(
                "pane {} · terminal {} · {}",
                pane.id, pane.terminal_id, pane.agent_status
            ));
        }
        if !self.pane_tail.is_empty() {
            out.push("--- pane output ---".to_string());
            out.extend(self.pane_tail.iter().cloned());
        }
        out.join("\n")
    }

    pub fn ingest_terminal_output(&mut self, output: &TerminalOutput) {
        let selected_terminal_id = self.view_terminal_id().map(str::to_string);
        if output.full || self.terminal_raw_terminal_id != selected_terminal_id {
            self.terminal_raw_output.clear();
            self.terminal_raw_terminal_id = selected_terminal_id;
        }
        self.terminal_raw_output
            .push_str(&String::from_utf8_lossy(&output.bytes));
        trim_terminal_raw_output(&mut self.terminal_raw_output);
        // Parse with the pty width the backend reports for this frame:
        // over-wide rows wrap onto continuation rows exactly where
        // the pty-side terminal wrapped them, keeping the styled tail
        // in sync with the pty screen (prompt row last). Width 0
        // (unknown/absent) keeps the unwrapped legacy behavior.
        let lines = terminal_output_styled_lines_for_width(
            &self.terminal_raw_output,
            output.width as usize,
        );
        self.set_pane_tail_from_styled_lines(lines);
        self.mark_dirty();
    }

    /// Tile focus walk with scroll fallback: when the split tree has
    /// neighbors in the (dx, dy) direction the focus moves there and
    /// the caller skips its fallback. Returns false when the walk
    /// found nothing (single tile or edge): the pre-split key behavior
    /// runs instead.
    pub(crate) fn split_walk_fallback(&mut self, dx: i32, dy: i32) -> bool {
        if self.split_tree.leaves().len() < 2 {
            return false;
        }
        let before = self.split_focus.clone();
        self.split_move_focus(dx, dy);
        self.split_focus != before
    }

    /// Up/Down in Navigate mode: walk the split first, scroll the
    /// focused pane when the walk has no neighbor to move to.
    pub(crate) fn nav_vertical_key(&mut self, dy: i32) {
        if !self.split_walk_fallback(0, dy) {
            if dy < 0 {
                self.scroll_pane_up(1);
            } else {
                self.scroll_pane_down(1);
            }
        }
    }

    pub fn load_selected_terminal_history(&mut self, cols: u16, rows: u16) {
        let Some(terminal_id) = self.view_terminal_id().map(str::to_string) else {
            return;
        };
        match self.client.attach_terminal(&terminal_id, cols, rows) {
            Ok(mut terminal) => {
                match terminal.read_output() {
                    Ok(output) => self.ingest_terminal_output(&output),
                    Err(err) => self.error = Some(err.to_string()),
                }
                if let Err(err) = terminal.detach() {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
        self.mark_dirty();
    }

    pub(crate) fn move_selection(&mut self, delta: isize) {
        // While a multi-leaf split exists the tile view owns focus:
        // sidebar moves still update the selection, but the tail
        // refresh (which loads the sidebar pane into the single-pane
        // pipeline) is skipped so the focused tile never chases the
        // sidebar cursor.
        match self.sidebar_focus {
            SidebarFocus::Workspaces => {
                self.selected_workspace = move_index(
                    self.selected_workspace,
                    self.snapshot.workspaces.len(),
                    delta,
                );
            }
            SidebarFocus::Agents => {
                self.selected_agent =
                    move_index(self.selected_agent, self.snapshot.agents.len(), delta);
            }
        }
        if self.split_tree.leaves().len() < 2 {
            self.refresh_tail();
        }
    }

    pub(crate) fn clamp_selection(&mut self) {
        self.selected_workspace = self
            .selected_workspace
            .min(self.snapshot.workspaces.len().saturating_sub(1));
        self.selected_agent = self
            .selected_agent
            .min(self.snapshot.agents.len().saturating_sub(1));
    }

    pub(crate) fn select_focused_items(&mut self) {
        if let Some(index) = self
            .snapshot
            .workspaces
            .iter()
            .position(|workspace| workspace.focused)
        {
            self.selected_workspace = index;
        }
        if let Some(index) = self.snapshot.agents.iter().position(|agent| agent.focused) {
            self.selected_agent = index;
        }
        if !self.snapshot.agents.is_empty() {
            self.sidebar_focus = SidebarFocus::Agents;
        }
    }

    /// Lines the pane view and the lens scroll over: the deep history
    /// followed by the tail, one contiguous scrollback.
    pub fn pane_scrollback_lines(&self) -> &[String] {
        if self.pane_history.is_empty() {
            &self.pane_tail
        } else {
            &self.pane_history
        }
    }

    /// Scroll the pane view up (away from the newest line) by `delta`
    /// lines, deep-fetching older scrollback whenever the offset
    /// reaches the top of the held buffer. The offset counts lines
    /// above the buffer end, so growth never moves the anchor.
    /// Returns how many older lines a deep fetch added (0 if none).
    pub fn scroll_pane_up(&mut self, delta: usize) -> usize {
        let mut loaded = 0;
        let mut remaining = delta;
        loop {
            let max = self.pane_scrollback_lines().len().saturating_sub(1);
            let target = self.pane_scroll.saturating_add(remaining);
            if target <= max {
                self.pane_scroll = target;
                return loaded;
            }
            let advance = max.saturating_sub(self.pane_scroll);
            self.pane_scroll = max;
            remaining = remaining.saturating_sub(advance);
            let grew = self.deepen_pane_history();
            loaded = loaded.saturating_add(grew);
            if grew == 0 {
                return loaded;
            }
        }
    }

    /// Scroll back toward the newest line; reaching the bottom re-arms
    /// following (the lens `follow` semantics on the pane view).
    pub fn scroll_pane_down(&mut self, delta: usize) {
        self.pane_scroll = self.pane_scroll.saturating_sub(delta);
    }

    /// Pull more scrollback through `pane.read` (the backend serves the
    /// whole scrollback; the TUI just retains a window of it). The
    /// retained window is suffix-anchored, so the already-held lines
    /// keep their offsets from the tail and the frozen view does not
    /// jump. Returns how many new lines the buffer grew by.
    pub(crate) fn deepen_pane_history(&mut self) -> usize {
        if self.pane_history_exhausted {
            return 0;
        }
        let Some(pane_id) = self.view_pane_id() else {
            return 0;
        };
        let want = if self.pane_history.is_empty() {
            PANE_HISTORY_START_LINES
        } else {
            self.pane_history
                .len()
                .saturating_mul(2)
                .min(PANE_HISTORY_MAX_LINES)
        };
        let lines = match self.client.read_pane(&pane_id) {
            Ok(value) => pane_read_text_lines(&value, want),
            Err(err) => {
                self.error = Some(err.to_string());
                return 0;
            }
        };
        if lines.len() < want || lines.len() >= PANE_HISTORY_MAX_LINES {
            self.pane_history_exhausted = true;
        }
        let before = self.pane_scrollback_lines().len();
        let grew = lines.len().saturating_sub(before);
        self.pane_history = lines;
        if grew > 0 {
            self.mark_dirty();
        }
        grew
    }

    pub(crate) fn set_pane_tail_from_text(&mut self, text: &str) {
        self.pane_tail = text
            .lines()
            .rev()
            .take(TAIL_LINES)
            .map(str::to_string)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        self.pane_tail_styles = vec![Vec::new(); self.pane_tail.len()];
        self.sync_history_suffix();
    }

    pub(crate) fn set_pane_tail_from_styled_lines(&mut self, lines: Vec<Vec<TuiTextSpan>>) {
        let start = lines.len().saturating_sub(TAIL_LINES);
        self.pane_tail_styles = lines[start..].to_vec();
        self.pane_tail = self
            .pane_tail_styles
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.as_str())
                    .collect::<String>()
            })
            .collect();
        self.sync_history_suffix();
    }

    /// The deep history and the live tail share one suffix: the tail is
    /// always the newest TAIL_LINES of the scrollback, so a refreshed
    /// tail overwrites the history's suffix instead of leaving two
    /// diverging copies of the newest output.
    pub(crate) fn sync_history_suffix(&mut self) {
        if self.pane_history.len() > self.pane_tail.len() {
            let keep = self.pane_history.len() - self.pane_tail.len();
            self.pane_history.truncate(keep);
            self.pane_history.extend(self.pane_tail.iter().cloned());
        }
        self.lens.observe_len(self.pane_scrollback_lines().len());
    }
}

pub fn build_client(options: &TuiOptions) -> BackendClient {
    match (&options.api_socket, &options.terminal_socket) {
        (Some(api), Some(terminal)) => BackendClient::new(api, terminal),
        _ => BackendClient::builtin_session(options.session.as_deref()),
    }
}

pub(crate) fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}

/// Pane tail lines out of a pane.read response: the nested
/// read.text shape wins, the flat top-level text is the legacy fallback,
/// and anything else yields no lines.
pub(crate) fn pane_read_text_lines(value: &Value, want: usize) -> Vec<String> {
    value
        .get("read")
        .and_then(|read| read.get("text"))
        .and_then(Value::as_str)
        .or_else(|| value.get("text").and_then(Value::as_str))
        .map(|text| {
            let clean = strip_ansi_lossy(text);
            let mut lines: Vec<String> = clean.lines().map(str::to_string).collect();
            if lines.len() > want {
                let start = lines.len() - want;
                lines.drain(..start);
            }
            lines
        })
        .unwrap_or_default()
}

pub(crate) fn strip_ansi_lossy(value: &str) -> String {
    terminal_text::strip_ansi_lossy(value, StripCarriageReturn::Drop)
}

pub(crate) fn trim_terminal_raw_output(value: &mut String) {
    let excess = value.len().saturating_sub(TERMINAL_RAW_BUFFER_BYTES);
    if excess == 0 {
        return;
    }
    let drain_to = value
        .char_indices()
        .find_map(|(index, _)| (index >= excess).then_some(index))
        .unwrap_or(value.len());
    value.drain(..drain_to);
}
