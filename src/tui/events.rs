//! Key handling and interaction handlers for TuiApp.

use super::*;

impl TuiApp {
    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        // A new keypress ends any hold: its own synchronous refresh()
        // must stay free to rewrite the line (create/close tab prove it).
        self.status_hold_until = None;
        let before = self.status.clone();
        // The tour owns every key, including the prefix (webui tour.js
        // captures before handleGlobalShortcut): no Ctrl+B, no lens, no
        // leak into the app underneath.
        if self.mode == TuiMode::Tour {
            self.handle_tour_key(key);
            self.hold_status_if_changed(&before);
            self.mark_dirty();
            return false;
        }
        // The Ctrl+B prefix wins everywhere else, including attach mode,
        // exactly like the WebUI shortcut overlay wins over terminal input.
        // Attach passthrough (webui `terminalPrefixPassthrough` option):
        // while attached with the flag on, Ctrl+B belongs to the shell
        // (readline backward-char, tmux prefix) and reaches the PTY like
        // any other typed key; every other screen and mode still arms the
        // prefix.
        let passthrough_prefix = self.mode == TuiMode::Attach
            && self.screen == TuiScreen::Terminal
            && self.terminal_prefix_passthrough
            && is_prefix_key(key);
        if !passthrough_prefix {
            if let Some(shortcut) = self.prefix.feed(key) {
                // Chord echo (desktop showShortcutHintToast parity): a fired
                // prefix chord writes `<chord> -> <label>` into the status
                // slot BEFORE dispatch, so any outcome the handler reports
                // (refresh summaries, workspace_status, prompt titles, the
                // quit confirm) replaces the echo and owns the line; the
                // echo only survives when the action itself says nothing.
                self.status = format!(
                    "{} -> {}",
                    crate::tui::keys::chord_label(shortcut),
                    shortcut.label()
                );
                // On Terminal/Navigate the s/m/z chords open the split
                // modes instead of their git meanings, so the echo
                // must match what actually fired or the status line
                // teaches the wrong verb.
                if self.screen == TuiScreen::Terminal && self.mode == TuiMode::Navigate {
                    match shortcut {
                        Shortcut::Settings => self.status = "Ctrl+B s -> split mode".to_string(),
                        Shortcut::GitBlame => {
                            self.status = "Ctrl+B m -> move tile mode".to_string()
                        }
                        Shortcut::GitStashFile => self.status = "Ctrl+B z -> zoom tile".to_string(),
                        _ => {}
                    }
                }
                self.run_shortcut(shortcut);
                self.hold_status_if_changed(&before);
                self.mark_dirty();
                return false;
            }
        }
        if self.prefix.is_armed() {
            self.mark_dirty();
            return false;
        }
        if self.commit_input.is_some() {
            self.handle_commit_key(key);
            self.hold_status_if_changed(&before);
            self.mark_dirty();
            return false;
        }
        if self.prompt_input.is_some() {
            self.handle_prompt_key(key);
            self.hold_status_if_changed(&before);
            self.mark_dirty();
            return false;
        }
        // The lens overlays the terminal screen (Navigate or Attach):
        // while open it owns the scrolling keys like the webui scroller
        // owns focus. The Ctrl+B prefix already fired above, so help and
        // every other shortcut stay reachable.
        if self.lens.active && self.screen == TuiScreen::Terminal {
            self.handle_lens_key(key);
            self.hold_status_if_changed(&before);
            self.mark_dirty();
            return false;
        }
        self.dispatch_mode_key(key);
        self.hold_status_if_changed(&before);
        self.mark_dirty();
        false
    }

    /// Coverage is off because the Tour early guard at the top of
    /// handle_key always returns before the mode match runs, so the
    /// Tour arm inside is unreachable by design; every other arm is
    /// exercised through handle_key, and extracting the dispatch
    /// changes no key routing.
    #[cfg_attr(coverage, coverage(off))]
    pub(crate) fn dispatch_mode_key(&mut self, key: KeyEvent) {
        match self.mode {
            // Tour never reaches here: the early guard in handle_key
            // owns its keys, so the arm only exists for match
            // exhaustiveness.
            TuiMode::Tour => {}
            TuiMode::Help => match key.code {
                // Esc clears the filter first, then closes (webui settings
                // search clears its box before dismissing the modal).
                KeyCode::Esc => {
                    if !self.help_filter.is_empty() {
                        self.help_filter.clear();
                        self.help_scroll = 0;
                    } else {
                        self.close_help_overlay();
                    }
                }
                // Tour replay (webui Help modal's Replay button): the
                // overlay stack keeps Help below, so closing the tour
                // returns to this help overlay.
                KeyCode::Char('T') => {
                    self.open_tour();
                }
                // Toggle close: ? always closes the overlay (it never
                // appears in shortcut names or descriptions, so unlike q it
                // cannot start a query). Esc is the other closer; q types
                // into the filter like the webui search box, so queries
                // like "quit" and "quick" are typeable.
                KeyCode::Char('?') => {
                    self.close_help_overlay();
                }
                // While a filter is active every printable key (except the
                // ? toggle and Esc closer above) edits the query, so words
                // like "worktree" and "quit" type through their j/k/q
                // letters. Scrolling then lives on the arrow/Page keys only.
                KeyCode::Down | KeyCode::PageDown => {
                    let max = help_max_scroll().min(
                        crate::tui::keys::filtered_help_rows(&self.help_filter)
                            .len()
                            .saturating_sub(1),
                    );
                    self.help_scroll = self.help_scroll.saturating_add(1).min(max);
                }
                KeyCode::Up | KeyCode::PageUp => {
                    self.help_scroll = self.help_scroll.saturating_sub(1);
                }
                KeyCode::Backspace => {
                    self.help_filter.pop();
                    self.help_scroll = 0;
                }
                // Ctrl+U clears the filter like the prompt inputs do.
                KeyCode::Char(ch)
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && ch.eq_ignore_ascii_case(&'u') =>
                {
                    self.help_filter.clear();
                    self.help_scroll = 0;
                }
                // j/k scroll only while no filter is active (vim reflex at
                // the top of the overlay); with a filter they become query
                // letters through the catch-all below.
                KeyCode::Char('j') if self.help_filter.is_empty() => {
                    self.help_scroll = self.help_scroll.saturating_add(1).min(help_max_scroll());
                }
                KeyCode::Char('k') if self.help_filter.is_empty() => {
                    self.help_scroll = self.help_scroll.saturating_sub(1);
                }
                KeyCode::Char(ch) if !ch.is_control() => {
                    self.help_filter.push(ch);
                    self.help_scroll = 0;
                }
                _ => {}
            },
            TuiMode::ConfirmQuit => match key.code {
                // y/Enter confirm the quit; n/Esc/q cancel back to the
                // previous mode. Ctrl+C also confirms (the classic "I
                // really want out" reflex key).
                KeyCode::Char('y') | KeyCode::Enter => self.status = "quit".to_string(),
                KeyCode::Char('n') | KeyCode::Esc | KeyCode::Char('q') => self.cancel_quit(),
                _ if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('c') =>
                {
                    self.status = "quit".to_string();
                }
                _ => {}
            },
            TuiMode::Settings => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('s') => {
                    self.close_overlay();
                }
                // Tour replay from the settings overlay (same entry as
                // Help's T key): the overlay stack keeps Settings below,
                // so closing the tour lands back here. The trigger is
                // how a user who already ran the onboarding finds it
                // again, with the run state visible one row above.
                KeyCode::Char('T') => {
                    self.open_tour();
                }
                // Theme cycle (webui settings theme select).
                KeyCode::Char('t') | KeyCode::Tab => {
                    self.theme = self.theme.next();
                    // The palette is precomputed at startup; recompute it or
                    // the cycle has no visible effect (webui applies the
                    // theme immediately on selection).
                    self.palette = Palette::for_theme(self.theme);
                    self.status = format!("theme: {}", self.theme.label());
                }
                // Ctrl+B passthrough toggle (webui Settings checkbox):
                // flips the flag and persists it to the shared settings
                // file so the choice survives restarts.
                KeyCode::Char('p') => {
                    self.terminal_prefix_passthrough = !self.terminal_prefix_passthrough;
                    match tui_set_terminal_prefix_passthrough(self.terminal_prefix_passthrough) {
                        Ok(()) => {
                            self.status = if self.terminal_prefix_passthrough {
                                "ctrl+b passthrough: on"
                            } else {
                                "ctrl+b passthrough: off"
                            }
                            .to_string();
                        }
                        Err(err) => {
                            self.error = Some(format!("settings file: {err}"));
                            // Keep the in-memory flip: the session behaves
                            // as chosen even if persistence failed.
                        }
                    }
                }
                _ => {}
            },
            TuiMode::WorktreeList => self.handle_worktree_list_key(key),
            TuiMode::BranchPicker => self.handle_branch_picker_key(key),
            TuiMode::SearchPalette => self.handle_search_palette_key(key),
            TuiMode::SessionManager => self.handle_session_manager_key(key),
            TuiMode::Navigate => self.handle_navigation_key(key),
            TuiMode::Attach => {
                if self.screen == TuiScreen::Terminal {
                    self.handle_attach_key(key);
                } else {
                    self.handle_panel_key(key);
                }
            }
        }
    }

    pub(crate) fn handle_prompt_key(&mut self, key: KeyEvent) {
        // No prompt open: nothing to edit or submit. Kept as a hard guard
        // (not an expect) because handle_prompt_key is directly callable
        // and the no-prompt arm is part of its contract.
        if self.prompt_input.is_none() {
            return;
        }
        // Mutate the prompt text first, then sync the composer draft from
        // the stored prompt (a helper taking &mut self would collide with
        // the prompt borrow; the inline write is the same one-liner).
        match key.code {
            KeyCode::Esc => self.prompt_input = None,
            KeyCode::Enter => {
                let kind = self
                    .prompt_input
                    .as_ref()
                    .map(|prompt| prompt.kind)
                    .expect("handle_prompt_key requires an active prompt");
                let text = self
                    .prompt_input
                    .as_ref()
                    .map(|prompt| prompt.text.trim().to_string())
                    .unwrap_or_default();
                self.prompt_input = None;
                // The cleanup confirm accepts `y` (delete selected) and
                // `yb` (delete selected plus their branches, webui
                // branch-too checkbox); every other destructive prompt
                // takes a plain `y`.
                let confirmed = if kind == PromptKind::ConfirmCleanupDelete {
                    text == "y" || text == "yb"
                } else {
                    text == "y"
                };
                if kind.needs_confirm() && !confirmed {
                    self.status = "cancelled".to_string();
                    return;
                }
                self.run_prompt_action(kind, &text);
            }
            KeyCode::Backspace => {
                // The is_none guard above owns the empty case, so the
                // binding can expect like the Enter arm below it.
                self.prompt_input
                    .as_mut()
                    .expect("handle_prompt_key requires an active prompt")
                    .text
                    .pop();
                self.sync_composer_draft();
            }
            KeyCode::Char(ch) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && ch.eq_ignore_ascii_case(&'u') {
                    self.prompt_input
                        .as_mut()
                        .expect("handle_prompt_key requires an active prompt")
                        .text
                        .clear();
                } else {
                    self.prompt_input
                        .as_mut()
                        .expect("handle_prompt_key requires an active prompt")
                        .text
                        .push(ch);
                }
                self.sync_composer_draft();
            }
            _ => {}
        }
    }

    /// Keep the per-pane composer draft in sync while the composer
    /// prompt is open (webui composer: every input event writes the
    /// box content into the pane's draft slot). Other prompt kinds are
    /// unaffected.
    pub(crate) fn sync_composer_draft(&mut self) {
        let Some(prompt) = self.prompt_input.as_ref() else {
            return;
        };
        if prompt.kind != PromptKind::ComposerMessage {
            return;
        }
        let text = prompt.text.clone();
        if let Some(pane) = self.view_pane() {
            let pane_id = pane.id.clone();
            self.composer_drafts.insert(pane_id, text);
        }
    }

    pub(crate) fn run_prompt_action(&mut self, kind: PromptKind, text: &str) {
        match kind {
            PromptKind::RenameFile => {
                let Some(entry) = self.file_explorer.selected_entry() else {
                    self.error = Some("no file selected".to_string());
                    return;
                };
                let path = entry.path.clone();
                match self
                    .web_api
                    .file_rename(&self.file_explorer.cwd, &path, text)
                {
                    Ok(_) => {
                        self.status = format!("renamed to {text}");
                        if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                            self.error = Some(err.to_string());
                        }
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ConfirmDeleteFile => {
                let Some(entry) = self.file_explorer.selected_entry() else {
                    self.error = Some("no file selected".to_string());
                    return;
                };
                let path = entry.path.clone();
                match self.web_api.file_delete(&self.file_explorer.cwd, &path) {
                    Ok(_) => {
                        self.status = format!("deleted {path}");
                        if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                            self.error = Some(err.to_string());
                        }
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ConfirmDeleteBranch => {
                let Some(branch) = self
                    .git_panel
                    .branches
                    .get(self.git_panel.branch_selected)
                    .filter(|entry| !entry.current)
                    .map(|entry| entry.name.clone())
                else {
                    self.error = Some("no branch selected".to_string());
                    return;
                };
                match self.git_panel.delete_branch(&self.web_api, &branch, false) {
                    Ok(_) => self.status = format!("deleted branch {branch}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ConfirmDropStash => match self.git_panel.stash_drop(&self.web_api) {
                Ok(_) => self.status = "stash dropped".to_string(),
                Err(err) => self.error = Some(err.to_string()),
            },
            PromptKind::NewWorkspace
            | PromptKind::NewWorkspaceName
            | PromptKind::RenameWorkspace
            | PromptKind::RenamePanel
            | PromptKind::CreateWorktreeBranch
            | PromptKind::CreateWorktreePath
            | PromptKind::CreateWorktreeBase
            | PromptKind::ConfirmWorktreePullBase
            | PromptKind::ConfirmCloseWorkspace => {
                let kind = kind.into_workspace_prompt();
                workspace::run_prompt(self, &kind, text);
            }
            PromptKind::ConfirmCleanupDelete => {
                // Webui confirm modal: `y` deletes the pending items; `yb`
                // also deletes each worktree's branch when that option is
                // offered (a marked worktree carries a branch). The
                // webui checkbox starts unchecked, so plain `y` is the
                // safe default.
                let branch_too =
                    text.trim() == "yb" && self.git_panel.cleanup_branch_option_available();
                let touched_repos: Vec<String> = self
                    .git_panel
                    .cleanup_pending_items()
                    .into_iter()
                    .map(|item| item.repo)
                    .collect();
                match self
                    .git_panel
                    .cleanup_delete_selected(&self.web_api, branch_too)
                {
                    Ok(deleted) => {
                        // A removed worktree drops rows from the cached
                        // worktree.list replies; a deleted current branch
                        // auto-switches on the server. Both change what the
                        // stamp cache would serve for the touched repo, so
                        // drop those entries like a switch does.
                        for repo in &touched_repos {
                            self.invalidate_stamp(repo);
                        }
                        self.status = format!("deleted {deleted} cleanup item(s)");
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
                if !self.git_panel.cleanup_failures().is_empty() {
                    self.error = Some(self.git_panel.cleanup_failures().join("\n"));
                }
            }
            PromptKind::CreateTag => {
                let tag = text.trim();
                if tag.is_empty() {
                    self.error = Some("type a tag name".to_string());
                } else {
                    match self.git_panel.log_tag(&self.web_api, tag) {
                        Ok(()) => self.status = format!("tagged {tag}"),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::ResetMode => {
                let mode = text.trim();
                match mode {
                    "soft" | "mixed" => match self.git_panel.log_reset(&self.web_api, mode) {
                        Ok(()) => self.status = format!("reset {mode}"),
                        Err(err) => self.error = Some(err.to_string()),
                    },
                    // Hard reset chains into the typed-y confirm; the
                    // server independently requires "reset hard".
                    "hard" => {
                        self.prompt_input = Some(PromptInput::new(PromptKind::ConfirmResetHard));
                        self.status = PromptKind::ConfirmResetHard.title().to_string();
                    }
                    _ => self.error = Some("type soft, mixed or hard".to_string()),
                }
            }
            PromptKind::ConfirmResetHard => match self.git_panel.log_reset(&self.web_api, "hard") {
                Ok(()) => self.status = "reset hard".to_string(),
                Err(err) => self.error = Some(err.to_string()),
            },
            PromptKind::RebaseUpstream => {
                let upstream = text.trim();
                if upstream.is_empty() {
                    self.error = Some("type the upstream ref".to_string());
                } else {
                    self.rebase_pending_upstream = Some(upstream.to_string());
                    self.prompt_input = Some(PromptInput::new(PromptKind::ConfirmRebase));
                    self.status = PromptKind::ConfirmRebase.title().to_string();
                }
            }
            PromptKind::ConfirmRebase => {
                let Some(upstream) = self.rebase_pending_upstream.take() else {
                    self.error = Some("no rebase pending".to_string());
                    return;
                };
                match self.git_panel.log_rebase(&self.web_api, &upstream) {
                    Ok(()) => self.status = format!("rebase onto {upstream}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::GitCwd => {
                let path = text.trim();
                if path.is_empty() {
                    self.error = Some("type a directory path".to_string());
                } else {
                    self.git_panel.set_cwd(path);
                    if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = format!("git cwd: {path}");
                    }
                }
            }
            PromptKind::CreateBranch => {
                let branch = text.trim();
                if branch.is_empty() {
                    self.error = Some("type a branch name".to_string());
                } else {
                    let cwd = self.git_panel.cwd.clone();
                    match self.web_api.git_switch(&cwd, branch, true) {
                        Ok(_) => {
                            self.status = format!("switched to {branch}");
                            if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                                self.error = Some(err.to_string());
                            }
                        }
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::CreateFile => {
                if text.trim().is_empty() {
                    self.error = Some("type a file name".to_string());
                } else {
                    match self.file_explorer.create_file(&self.web_api, text.trim()) {
                        Ok(()) => {
                            self.status = format!("created {}", text.trim());
                            // Webui opens the new file right away.
                            if let Err(err) = self.file_explorer.open_preview(&self.web_api) {
                                self.error = Some(err.to_string());
                            }
                        }
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::CreateDirectory => {
                if text.trim().is_empty() {
                    self.error = Some("type a directory name".to_string());
                } else {
                    match self
                        .file_explorer
                        .create_directory(&self.web_api, text.trim())
                    {
                        Ok(()) => self.status = format!("created {}", text.trim()),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::ReplaceInFile => {
                // `!` suffix = replace all (documented deviation).
                let (replacement, all) = match text.strip_suffix('!') {
                    Some(head) => (head.to_string(), true),
                    None => (text.to_string(), false),
                };
                match self.file_explorer.editor_replace(&replacement, all) {
                    Ok((replaced, total)) => {
                        self.status = if all {
                            format!("replaced {replaced} matches")
                        } else {
                            format!("replaced 1 of {total} matches")
                        };
                        // Reopen the find bar so the replace→cycle loop
                        // the webui has actually exists: Enter cycles the
                        // remaining matches, Esc returns to plain editing.
                        // Without this the bar stays closed and Enter hit
                        // edit_key, inserting a stray newline instead.
                        self.file_explorer.editor_find_open();
                        self.file_explorer.edit_active = true;
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ComposerMessage => {
                self.submit_composer_message(text);
            }
            PromptKind::CreateSession => {
                // Session manager `n` (webui "New built-in" input):
                // the server launches the typed name, then the app
                // retargets to it. Names reuse the socket component
                // sanitizer server-side, so no extra validation here.
                let name = text.trim();
                if name.is_empty() {
                    self.error = Some("type a session name".to_string());
                } else {
                    let result = self.session_launch_and_target(name, "builtin");
                    self.workspace_status(result);
                }
            }
        }
    }

    /// Submit one composer message for the selected pane through the
    /// server's pane submit route (webui composer parity). The message
    /// is shaped exactly like the browser composer does before the
    /// POST: trailing newlines are the composer's own Enter, CRLF reads
    /// as one newline, and the length gets an early out at the server's
    /// MAX_COMPOSER_CHARS (the server re-checks; this only avoids a
    /// fat request). On success the per-pane draft clears; on refusal
    /// the server's note lands in the status line and the draft stays.
    pub(crate) fn submit_composer_message(&mut self, text: &str) {
        const MAX_COMPOSER_CHARS: usize = 20_000;
        let Some(pane_id) = self.view_pane_id() else {
            self.error = Some("no pane selected".to_string());
            return;
        };
        // Shape: strip trailing newlines (the composer's Enter), then
        // CRLF -> LF (browser composer's own pre-send shaping).
        let message = text
            .trim_end_matches(['\r', '\n'])
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        if message.trim().is_empty() {
            // Nothing to send; keep the prompt closed without an error
            // (the webui composer just keeps the text).
            self.status = "message empty, nothing sent".to_string();
            return;
        }
        if message.chars().count() > MAX_COMPOSER_CHARS {
            self.status = "Not sent: message is too long (20000 characters max).".to_string();
            return;
        }
        match self.web_api.submit_pane(&pane_id, &message) {
            Ok(_) => {
                self.composer_drafts.remove(&pane_id);
                self.status = "message sent".to_string();
                self.refresh_tail();
            }
            Err(err) => {
                // Server-owned refusal copy (`{error, code, note}`), shown
                // verbatim like the browser composer shows `details.note`
                // (the note already reads "Not sent: ..."; unknown
                // refusals fall back to the error string).
                self.status = err.note();
            }
        }
    }

    /// Keys while the search palette overlay is open (webui search
    /// palette): printable keys append to the query and live-filter
    /// the local candidates (workspaces/panels/agents), Enter commits
    /// the query (fetching file and content hits over the web API)
    /// and a second Enter navigates the selected row, Esc closes.
    pub(crate) fn handle_search_palette_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.close_search_palette();
            }
            // Ctrl+U clears the query like the prompt inputs.
            KeyCode::Char(ch)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && ch.eq_ignore_ascii_case(&'u') =>
            {
                self.search_palette.clear_query(&self.snapshot);
            }
            // Ctrl+X removes the selected recent-workspace entry from
            // the server list (desktop per-row trash button; printable
            // `x` must keep typing into the query).
            KeyCode::Char(ch)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::SHIFT)
                    && ch.eq_ignore_ascii_case(&'x') =>
            {
                self.remove_selected_recent();
            }
            // Ctrl+Shift+X clears every recent-workspace entry (desktop
            // section Clear button).
            KeyCode::Char(ch)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.modifiers.contains(KeyModifiers::SHIFT)
                    && ch.eq_ignore_ascii_case(&'x') =>
            {
                self.clear_recent_workspaces();
            }
            KeyCode::Backspace => {
                self.search_palette.pop_char(&self.snapshot);
            }
            // Arrows always move (webui modal parity): they are not
            // query letters, so an active query must not swallow them.
            KeyCode::Down => self.search_palette.move_selection(1),
            KeyCode::Up => self.search_palette.move_selection(-1),
            // j/k move the cursor only while the query is empty (the
            // help/worktree overlay convention); with a query typed
            // they are letters.
            KeyCode::Char('j') if self.search_palette.query.is_empty() => {
                self.search_palette.move_selection(1);
            }
            KeyCode::Char('k') if self.search_palette.query.is_empty() => {
                self.search_palette.move_selection(-1);
            }
            KeyCode::Enter => {
                // First Enter on a fresh palette commits the query (file
                // and content fetches); a palette with rows navigates.
                if !self.search_palette.committed {
                    let result = self.commit_search_query();
                    match result {
                        Ok(()) => {
                            // Only a successful commit counts: a failed
                            // one stays uncommitted so the next Enter
                            // retries the fetch instead of navigating
                            // stale local-only rows.
                            self.search_palette.committed = true;
                            self.status =
                                format!("search: {} results", self.search_palette.results.len());
                        }
                        Err(err) => self.error = Some(err),
                    }
                    return;
                }
                let candidate = self.search_palette.selected_candidate().cloned();
                match candidate {
                    Some(candidate) => {
                        // Desktop disabled rows refuse navigation with a
                        // visible hint; the TUI keeps the palette open
                        // and explains in the status line.
                        if let search::SearchCandidate::Recent { is_open: true, .. } = &candidate {
                            self.status = "recent workspace already open".to_string();
                            return;
                        }
                        self.close_search_palette();
                        if let Err(err) = self.run_search_candidate(&candidate) {
                            self.error = Some(err);
                        }
                    }
                    // Desktop `chooseSearchResult` returns early when
                    // no row sits under the cursor: an empty result
                    // list keeps the palette open instead of closing.
                    None => {
                        self.status = "search: no matching rows".to_string();
                    }
                }
            }
            KeyCode::Char(ch) if !ch.is_control() => {
                self.search_palette.push_char(ch, &self.snapshot);
                self.status = format!("search: {}", self.search_palette.query);
            }
            _ => {}
        }
    }

    /// Commit the palette query: run the file search and the content
    /// search over the active cwd, appending hits below the local
    /// candidates. Retries are idempotent: every commit rebuilds the
    /// rows from the local candidates before fetching, so a partial
    /// failure (files fetched, content failed) followed by a retry
    /// never appends duplicate rows.
    pub(crate) fn commit_search_query(&mut self) -> Result<(), String> {
        let query = self.search_palette.query.trim().to_string();
        if query.is_empty() {
            return Ok(());
        }
        let Some(cwd) = self.active_cwd() else {
            return Err("no workspace selected".to_string());
        };
        let root = self.file_explorer.root_path.clone();
        self.search_palette.refresh_local(&self.snapshot);
        let file_result = self
            .search_palette
            .commit_file_search(&self.web_api, &cwd, &root)
            .map(|_| ())
            .map_err(err_text);
        let content_result = self
            .search_palette
            .commit_content_search(&self.web_api, &cwd, &root)
            .map(|_| ())
            .map_err(err_text);
        file_result?;
        content_result?;
        Ok(())
    }

    /// Navigate the selected palette row (desktop `chooseSearchResult`):
    /// workspaces/panels/agents select their workspace and pane so the
    /// next Enter attaches; files reveal in the Files tree; content
    /// opens the preview at the match line.
    pub(crate) fn run_search_candidate(
        &mut self,
        candidate: &search::SearchCandidate,
    ) -> Result<(), String> {
        match candidate {
            search::SearchCandidate::Workspace { id, .. } => {
                self.select_search_target(Some(id), None, None);
                Ok(())
            }
            search::SearchCandidate::Panel {
                id, workspace_id, ..
            } => {
                self.select_search_target(Some(workspace_id), Some(id), None);
                Ok(())
            }
            search::SearchCandidate::Agent { pane_id, .. } => {
                self.select_search_target(None, None, Some(pane_id));
                Ok(())
            }
            search::SearchCandidate::File { path, is_dir, .. } => {
                self.open_files_screen();
                if *is_dir {
                    self.file_explorer.select_path(path);
                } else {
                    self.file_explorer
                        .reveal_path(&self.web_api, path)
                        .map_err(err_text)?;
                }
                Ok(())
            }
            search::SearchCandidate::Content { file, line, .. } => {
                self.open_files_screen();
                self.file_explorer
                    .open_preview_at_line(&self.web_api, file, *line)
                    .map_err(err_text)?;
                Ok(())
            }
            search::SearchCandidate::Recent {
                path,
                label,
                is_open,
                ..
            } => {
                if *is_open {
                    return Err("recent workspace already open".to_string());
                }
                // Desktop `openRecentWorkspace`: POST /api/recent-workspaces
                // proxies worktree.open (focuses an already-open workspace
                // instead of duplicating it) and re-records the entry. Only
                // the recorded custom label travels; None keeps the
                // backend's own naming for the reopened workspace.
                let result = self
                    .web_api
                    .open_recent_workspace(path, label.as_deref())
                    .map_err(err_text)?;
                // Desktop invalidates the recents cache after an open
                // (`invalidateRecent`), so the next palette open refetches
                // instead of serving the stale order.
                self.search_palette.invalidate_recents();
                // Auto-split neighbor: captured before the open moves the
                // selection to the reopened workspace.
                let auto_split_neighbor = self.view_pane_id();
                self.refresh().map_err(err_text)?;
                // Land on the reopened workspace like the desktop go()
                // navigation: the response carries the workspace plus its
                // focused tab and root pane (desktop `openRecentWorkspace`
                // passes all three; the tab/pane ids resolve the concrete
                // terminal, the workspace id alone falls back to the
                // active tab's first pane).
                let result = result.get("result");
                let workspace = result.and_then(|result| result.get("workspace"));
                let workspace_id = Self::recent_workspace_id(workspace, result);
                let tab_id =
                    Self::recent_open_field(result.and_then(|result| result.get("tab")), "tab_id");
                let pane_id = Self::recent_open_field(
                    result.and_then(|result| result.get("root_pane")),
                    "pane_id",
                );
                self.select_search_target(Some(workspace_id.as_str()), tab_id, pane_id);
                // Auto-split on open (search palette recent): the
                // reopened workspace appears as its own tile.
                if !workspace_id.is_empty() {
                    self.split_panes_of_workspaces
                        .push((workspace_id.clone(), auto_split_neighbor));
                }
                self.status = format!("opened {path}");
                Ok(())
            }
        }
    }

    /// Read a non-empty string field from a `worktree.open`-shaped
    /// result object (the recent-open response nests workspace, tab,
    /// and root_pane objects; missing or empty fields stay None).
    pub(crate) fn recent_open_field<'a>(parent: Option<&'a Value>, key: &str) -> Option<&'a str> {
        let value = parent?.get(key)?;
        match value.as_str() {
            Some(text) if !text.is_empty() => Some(text),
            _ => None,
        }
    }

    /// Desktop `isDefaultPanelTitle`: empty, shell, terminal, or
    /// "tab N" labels are generated defaults, not user renames.
    pub(crate) fn is_default_panel_title(label: &str) -> bool {
        let value = label.trim().to_lowercase();
        if value.is_empty() || value == "shell" || value == "terminal" {
            return true;
        }
        let Some(rest) = value.strip_prefix("tab ") else {
            return false;
        };
        !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit())
    }

    /// Focus the concrete navigation target (desktop rule): a pane
    /// resolves to its agent list entry, a tab to its first pane, a
    /// workspace to its active tab's first pane. The sidebar selection
    /// updates so the terminal screen attaches to the right terminal.
    pub(crate) fn select_search_target(
        &mut self,
        workspace_id: Option<&str>,
        tab_id: Option<&str>,
        pane_id: Option<&str>,
    ) {
        // Pane id wins when present (agent rows).
        if let Some(pane_id) = pane_id {
            if let Some(index) = self
                .snapshot
                .agents
                .iter()
                .position(|agent| agent.pane_id == pane_id)
            {
                self.sidebar_focus = SidebarFocus::Agents;
                self.selected_agent = index;
                if let Some(workspace_index) = self
                    .snapshot
                    .workspaces
                    .iter()
                    .position(|ws| ws.id == self.snapshot.agents[index].workspace_id)
                {
                    self.selected_workspace = workspace_index;
                }
                self.refresh_tail();
                return;
            }
        }
        if let Some(tab_id) = tab_id {
            if let Some(pane) = self
                .snapshot
                .panes
                .iter()
                .find(|pane| pane.tab_id == tab_id)
            {
                self.select_search_target(None, None, Some(&pane.id.clone()));
                return;
            }
        }
        if let Some(workspace_id) = workspace_id {
            if let Some(index) = self
                .snapshot
                .workspaces
                .iter()
                .position(|ws| ws.id == workspace_id)
            {
                self.selected_workspace = index;
                self.sidebar_focus = SidebarFocus::Workspaces;
                // Also land on the workspace's active tab pane so the
                // selection is concrete (desktop `targetForWorkspace`).
                let active_tab_id = self.snapshot.workspaces[index].active_tab_id.clone();
                if let Some(tab_id) = active_tab_id {
                    if let Some(pane) = self
                        .snapshot
                        .panes
                        .iter()
                        .find(|pane| pane.workspace_id == workspace_id && pane.tab_id == tab_id)
                    {
                        self.select_search_target(None, None, Some(&pane.id.clone()));
                        return;
                    }
                }
                self.refresh_tail();
            }
        }
    }

    /// Keys while content-search results are visible (webui results
    /// view): j/k walk the flat rows, Enter opens the match (or toggles
    /// a file group), `+` appends the next page, `A`/`X` flip the
    /// match-case/regex toggles and re-run, Esc clears the results.
    pub(crate) fn handle_content_search_key(&mut self, key: KeyEvent) {
        let rows = content_rows(&self.file_explorer.content_search);
        let len = rows.len();
        let state = &mut self.file_explorer.content_search;
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                state.selected = move_index(state.selected, len, 1);
            }
            KeyCode::Char('k') | KeyCode::Up => {
                state.selected = move_index(state.selected, len, -1);
            }
            KeyCode::Enter => {
                let selected = state.selected;
                match rows.get(selected) {
                    Some(ContentRow::File(index)) => {
                        let index = *index;
                        content_search::toggle_content_file(state, index);
                    }
                    Some(ContentRow::Line { file, line, .. }) => {
                        let path = state.files[*file].path.clone();
                        let line = *line;
                        if let Err(err) =
                            self.file_explorer
                                .open_preview_at_line(&self.web_api, &path, line)
                        {
                            self.error = Some(err.to_string());
                        } else {
                            self.status = format!("{path}:{line}");
                        }
                    }
                    None => {}
                }
            }
            // Load more files (webui `loadMore`, appending at the offset).
            KeyCode::Char('+') => {
                let done = state.done;
                if !done {
                    if let Err(err) =
                        run_content_search(&mut self.file_explorer, &self.web_api, true)
                    {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "loaded more results".to_string();
                    }
                } else {
                    self.status = "no more results".to_string();
                }
            }
            // Match-case toggle (webui setting `fileContentSearchMatchCase`);
            // no default webui key: A/X are the TUI bindings, documented.
            KeyCode::Char('A') => {
                state.match_case = !state.match_case;
                self.rerun_content_search();
            }
            // Regex toggle (webui setting `fileContentSearchRegex`).
            KeyCode::Char('X') => {
                state.regex = !state.regex;
                self.rerun_content_search();
            }
            // Clear the results and go back to the tree.
            KeyCode::Esc => {
                state.clear_results();
                self.file_explorer.search_mode = false;
                self.file_explorer.filter.clear();
                self.status = "content search closed".to_string();
                if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            _ => {}
        }
    }

    /// Re-run the content search after a toggle flip (fresh, offset 0).
    pub(crate) fn rerun_content_search(&mut self) {
        match run_content_search(&mut self.file_explorer, &self.web_api, false) {
            Ok(()) => {
                self.status = format!(
                    "search re-run: match-case {}, regex {}",
                    self.file_explorer.content_search.match_case,
                    self.file_explorer.content_search.regex
                )
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    /// Keys while the editor find bar is active (webui find toolbar).
    pub(crate) fn handle_editor_find_key(&mut self, key: KeyEvent) {
        let shift = key
            .modifiers
            .contains(crossterm::event::KeyModifiers::SHIFT);
        let ctrl = key
            .modifiers
            .contains(crossterm::event::KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => {
                self.file_explorer.editor_find_close();
                self.status = "find closed".to_string();
            }
            KeyCode::Enter => {
                self.file_explorer.editor_find_next(!shift);
                let count = self.file_explorer.editor_find.ranges.len();
                self.status = if count == 0 {
                    "no matches".to_string()
                } else {
                    format!(
                        "match {}/{}",
                        self.file_explorer.editor_find.selected + 1,
                        count
                    )
                };
            }
            KeyCode::Backspace => self.file_explorer.pop_find_char(),
            // Replace stays reachable while the find bar is open (the
            // webui find bar carries the replace input inline), so the
            // replace→cycle loop never dead-ends with the bar closed.
            KeyCode::Char('h') if ctrl => {
                self.prompt_input = Some(PromptInput {
                    kind: PromptKind::ReplaceInFile,
                    text: String::new(),
                });
            }
            // Match-case / regex toggles (webui toolbar checkboxes).
            KeyCode::Char('A') => {
                self.file_explorer.editor_find.match_case =
                    !self.file_explorer.editor_find.match_case;
                self.file_explorer.refresh_find();
            }
            KeyCode::Char('X') => {
                self.file_explorer.editor_find.regex = !self.file_explorer.editor_find.regex;
                self.file_explorer.refresh_find();
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.file_explorer.push_find_char(ch);
            }
            _ => {}
        }
    }

    pub(crate) fn handle_commit_key(&mut self, key: KeyEvent) {
        let Some(commit) = self.commit_input.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Enter => {
                let text = commit.text.trim().to_string();
                let amend = commit.amend;
                self.commit_input = None;
                if text.is_empty() {
                    self.error = Some("commit message is empty".to_string());
                    return;
                }
                match self.git_panel.commit(&self.web_api, &text, amend) {
                    Ok(()) => self.status = format!("committed: {text}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Esc => self.commit_input = None,
            KeyCode::Backspace => {
                commit.text.pop();
            }
            KeyCode::Char(ch) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && ch.eq_ignore_ascii_case(&'u') {
                    commit.text.clear();
                } else {
                    commit.text.push(ch);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn run_shortcut(&mut self, shortcut: Shortcut) {
        match shortcut {
            Shortcut::Help => self.open_help_overlay(),
            Shortcut::Files => self.open_files_screen(),
            Shortcut::Git => self.open_git_screen(),
            Shortcut::Terminal => self.screen = TuiScreen::Terminal,
            Shortcut::Search => self.open_search_palette(),
            Shortcut::Refresh => self.refresh_active_screen(),
            Shortcut::NextWorkspace => self.move_selection(1),
            Shortcut::PrevWorkspace => self.move_selection(-1),
            Shortcut::NextAgent => {
                self.sidebar_focus = SidebarFocus::Agents;
                self.move_selection(1);
            }
            Shortcut::PrevAgent => {
                self.sidebar_focus = SidebarFocus::Agents;
                self.move_selection(-1);
            }
            Shortcut::NewTab => self.create_tab(),
            Shortcut::CloseTab => self.close_selected_tab(),
            Shortcut::NextPanel => {
                let result = self.move_panel(1);
                self.workspace_status(result);
            }
            Shortcut::PrevPanel => {
                let result = self.move_panel(-1);
                self.workspace_status(result);
            }
            Shortcut::NewWorkspace => {
                // Webui new-workspace modal: browse for the folder first
                // (prefix `N` reuses the browser rows as the picker),
                // then chain to the name prompt. Esc cancels back here.
                let result = self.workspace_pick_folder();
                self.workspace_status(result);
            }
            Shortcut::OpenWorktrees => {
                self.worktree_pick_workspace = false;
                let result = self.worktree_list();
                self.workspace_status(result);
            }
            Shortcut::CreateWorktree => {
                self.worktree_create_stage = None;
                // Base-first chain: mirror of the in-view c handler, so
                // every worktree entry opens on the same step.
                self.prompt_input = self
                    .worktree_default_base()
                    .map(|base| PromptInput::with_text(PromptKind::CreateWorktreeBase, base))
                    .or_else(|| Some(PromptInput::new(PromptKind::CreateWorktreeBase)));
                self.status = PromptKind::CreateWorktreeBase.title().to_string();
            }
            Shortcut::CloseWorkspace => {
                self.prompt_input = Some(PromptInput::new(PromptKind::ConfirmCloseWorkspace));
                self.status = PromptKind::ConfirmCloseWorkspace.title().to_string();
            }
            Shortcut::RemoveWorktree => {
                let result = self.remove_worktree();
                self.workspace_status(result);
            }
            Shortcut::RenamePanel => {
                // Desktop prefills the rename input with the current
                // label unless it is a default title (shell/terminal/
                // "tab N" stay empty, `panelRenameInitialLabel`). The
                // panel in view owns the rename: its label prefills and
                // its tab receives the submit.
                let label = self
                    .view_pane()
                    .and_then(|pane| {
                        self.snapshot
                            .tabs
                            .iter()
                            .find(|tab| tab.id == pane.tab_id)
                            .map(|tab| tab.label.clone())
                    })
                    .filter(|label| !Self::is_default_panel_title(label));
                let mut input = PromptInput::new(PromptKind::RenamePanel);
                input.text = label.unwrap_or_default();
                self.prompt_input = Some(input);
                self.status = PromptKind::RenamePanel.title().to_string();
            }
            Shortcut::RenameWorkspace => {
                self.prompt_input = Some(PromptInput::new(PromptKind::RenameWorkspace));
                self.status = PromptKind::RenameWorkspace.title().to_string();
            }
            Shortcut::GitCwdPicker => {
                // Prefix I: switch the git panel to a typed repo path
                // (webui location bar; no webui default binding).
                self.open_git_screen();
                self.prompt_input = Some(PromptInput::new(PromptKind::GitCwd));
                self.status = PromptKind::GitCwd.title().to_string();
            }
            Shortcut::SettingsOverlay => {
                // Dedicated settings chord (review F4): `Ctrl+B Shift+E`
                // opens the settings overlay from every screen, including
                // the Terminal screen where prefix `s` is split mode.
                self.open_overlay(TuiMode::Settings);
            }
            Shortcut::Settings => {
                // Prefix s: on the git screens this stays the settings
                // overlay (webui KeyS muscle memory). On the Terminal
                // screen in Navigate mode the split-panel design takes
                // the key (Ctrl+B s opens split mode); Shift+E
                // (Ctrl+B Shift+E, review F4) is the dedicated settings
                // chord that works from every screen, so the overlay is
                // no longer mouse-only from Terminal.
                if self.screen == TuiScreen::Terminal && self.mode == TuiMode::Navigate {
                    self.open_split_mode();
                } else {
                    self.open_overlay(TuiMode::Settings);
                }
            }
            Shortcut::Sidebar => {
                // Prefix Shift+B: collapse/expand the sidebar column
                // (webui sidebar: KeyB).
                self.sidebar_collapsed = !self.sidebar_collapsed;
                self.status = if self.sidebar_collapsed {
                    "sidebar hidden".to_string()
                } else {
                    "sidebar shown".to_string()
                };
            }
            Shortcut::FocusNext => self.walk_focus(1),
            Shortcut::FocusPrev => self.walk_focus(-1),
            Shortcut::Lens => self.toggle_lens_from_footer(),
            Shortcut::Composer => self.open_composer_from_footer(),
            Shortcut::Quit => self.request_quit(),
            Shortcut::GitChanges => {
                self.open_git_screen();
                self.git_panel.view = GitView::Changes;
                self.refresh_active_screen();
            }
            Shortcut::GitCommit => {
                self.open_git_screen();
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: false,
                });
                self.status = "commit: type message, Enter commits".to_string();
            }
            Shortcut::EditFile => {
                // Webui parity: prefix then e edits the current file. On the
                // Files screen that is the open preview; on Git it is the
                // file selected in the Changes list.
                if self.screen == TuiScreen::Files {
                    match self.file_explorer.start_edit() {
                        Ok(()) => self.status = "editing: Ctrl-S saves, Esc stops".to_string(),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                } else {
                    self.open_git_screen();
                    self.git_panel.view = GitView::Changes;
                    let file = self
                        .git_panel
                        .selected_file()
                        .map(|entry| entry.path.clone());
                    let Some(file) = file else {
                        self.error = Some("no file selected in git changes".to_string());
                        return;
                    };
                    // A dirty buffer is not silently replaced: the webui
                    // keeps dirty editor tabs, so ask the user to save or
                    // reload first.
                    if self.file_explorer.preview.dirty
                        && self.file_explorer.preview.path.as_deref() != Some(file.as_str())
                    {
                        self.status =
                            "unsaved edits: save or reload before editing another file".to_string();
                        return;
                    }
                    match self.web_api.file_read(&self.git_panel.cwd, &file) {
                        Ok(data) => {
                            let content = data.get("content").and_then(Value::as_str).unwrap_or("");
                            let binary =
                                data.get("binary").and_then(Value::as_bool).unwrap_or(false);
                            let truncated = data
                                .get("truncated")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            // Rebuild the explorer for the git cwd so the
                            // tree, cwd, and preview all describe the same
                            // directory; reusing the old explorer would
                            // leave stale entries resolved against the new
                            // cwd.
                            let mut explorer =
                                crate::tui::panels::FileExplorer::new(&self.git_panel.cwd);
                            // Best effort: a failed tree refresh leaves an
                            // empty tree but keeps cwd and preview aligned.
                            if let Err(err) = explorer.refresh(&self.web_api) {
                                self.error = Some(err.to_string());
                            }
                            explorer.preview = crate::tui::panels::FilePreview {
                                path: Some(file),
                                content: content.to_string(),
                                truncated,
                                binary,
                                hash: data
                                    .get("hash")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                dirty: false,
                            };
                            // start_edit re-checks binary/truncated and
                            // reports "binary file cannot be edited" /
                            // "truncated file cannot be edited safely".
                            match explorer.start_edit() {
                                Ok(()) => {
                                    self.status = "editing: Ctrl-S saves, Esc stops".to_string()
                                }
                                Err(err) => self.error = Some(err.to_string()),
                            }
                            self.screen = TuiScreen::Files;
                            self.file_explorer = explorer;
                        }
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            Shortcut::GitLog => {
                self.open_git_screen();
                self.git_panel.view = GitView::Log;
                // Keep an existing file scope (webui `logFilePath`) when
                // re-opening the Log view.
                self.refresh_active_screen();
            }
            Shortcut::GitStash => {
                self.open_git_screen();
                self.git_panel.view = GitView::Stash;
                self.refresh_active_screen();
            }
            Shortcut::GitFileHistory => {
                // Webui `history: KeyH`: list commits touching the file
                // selected in Changes.
                self.open_git_screen();
                if self.git_panel.view != GitView::Changes {
                    self.git_panel.view = GitView::Changes;
                    self.refresh_active_screen();
                }
                if self.git_panel.selected_file().is_none() {
                    self.error = Some("no file selected in git changes".to_string());
                    return;
                }
                self.git_panel.view = GitView::History;
                self.refresh_active_screen();
                let file = self.git_panel.history_file.clone().unwrap_or_default();
                self.status = format!("history: {file}");
            }
            Shortcut::GitChangesBack => {
                // Webui `compare: KeyO`: return to the current changes view.
                self.open_git_screen();
                self.git_panel.view = GitView::Changes;
                self.refresh_active_screen();
            }
            Shortcut::GitBlame => {
                // Webui `blame: KeyM`: toggle author annotations on the
                // diff lines of the selected file. Terminal screen in
                // Navigate mode keeps the key for move mode (split
                // design); the git screen keeps blame.
                if self.screen == TuiScreen::Terminal && self.mode == TuiMode::Navigate {
                    self.open_move_mode();
                    return;
                }
                self.open_git_screen();
                if self.git_panel.view != GitView::Changes {
                    self.git_panel.view = GitView::Changes;
                    self.refresh_active_screen();
                }
                match self.git_panel.toggle_blame(&self.web_api) {
                    Ok(()) => {
                        self.status = if self.git_panel.show_blame {
                            // Review F3: `Ctrl+B m` is move-tile on the
                            // Terminal screen, so the git meaning firing
                            // names the context to break the surprise.
                            "blame on (Ctrl+B m moves tiles on terminal)".to_string()
                        } else {
                            "blame off".to_string()
                        };
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            Shortcut::GitBranch => {
                self.open_git_screen();
                self.git_panel.view = GitView::Branches;
                self.refresh_active_screen();
            }
            Shortcut::GitSwitchBranch => {
                // Repointed to the workspace-scoped branch picker
                // (desktop location-bar branch popover): the old
                // git-screen Branches view stays reachable through
                // prefix `b`, and plain `v` now answers "which branch
                // is this workspace on" for the selected workspace
                // instead of the git panel cwd.
                let result = self.branch_picker_open();
                self.workspace_status(result);
            }
            Shortcut::GitStageFile => self.run_git_action(|panel, api| panel.stage_selected(api)),
            Shortcut::GitUnstageFile => {
                self.run_git_action(|panel, api| panel.unstage_selected(api))
            }
            Shortcut::GitDiscardFile => {
                // Discarding the file under edit while its buffer is
                // dirty would silently fork it from disk.
                let selected_path = self
                    .git_panel
                    .selected_file()
                    .map(|entry| entry.path.clone());
                if self.file_explorer.preview.dirty
                    && selected_path.is_some_and(|path| {
                        self.file_explorer.preview.path.as_deref() == Some(path.as_str())
                    })
                {
                    self.error = Some(
                        "unsaved edits: save or reload before discarding this file".to_string(),
                    );
                } else {
                    self.run_git_action(|panel, api| panel.discard_selected(api));
                }
            }
            Shortcut::GitStashFile => {
                // Webui `stash: Digit4` is the stash verb; prefix z maps
                // to per-file stash. Terminal screen in Navigate mode
                // keeps z for tile zoom (split design).
                if self.screen == TuiScreen::Terminal && self.mode == TuiMode::Navigate {
                    self.split_toggle_zoom();
                    return;
                }
                self.run_git_action(|panel, api| panel.stash_changes(api));
                // Review F3: `Ctrl+B z` is tile zoom on the Terminal
                // screen; the git meaning firing names the context.
                if self.error.is_none() {
                    self.status = "stashed (Ctrl+B z zooms tiles on terminal)".to_string();
                }
            }
            Shortcut::GitPush => self.run_git_action(|panel, api| panel.push(api)),
            Shortcut::GitStageAll => {
                // Webui `stageAll: KeyG` behind the prefix (audit fix):
                // toggle stage-all from the Changes view. run_git_action
                // switches to Changes first so plain `G` on other views
                // still lands in the right list.
                if self.git_panel.cwd.is_empty() {
                    self.error = Some("git: no repository selected".to_string());
                } else {
                    self.open_git_screen();
                    self.git_panel.view = GitView::Changes;
                    match self.git_panel.toggle_stage_all(&self.web_api) {
                        Ok(()) => self.status = "staged state toggled".to_string(),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            Shortcut::GitFocusFile => {
                // Desktop `focusFile: KeyI` behind the prefix (audit fix:
                // plain `i` was shadowed by the Shift+I cwd picker and
                // now resolves to this like the desktop binding).
                self.open_git_screen();
                if self.git_panel.view != GitView::Changes {
                    self.git_panel.view = GitView::Changes;
                    self.refresh_active_screen();
                }
                // Focus model is a flag, not a region variant (walk_focus):
                // the file list lives in the main region.
                self.main_focused = true;
                self.status = if self.git_panel.selected_file().is_some() {
                    "git: file list focused".to_string()
                } else {
                    "git: no files in the list".to_string()
                };
            }
            Shortcut::SessionManager => {
                // Webui session manager surface (footer button there,
                // free chord here): list sessions, switch, launch,
                // close, cleanup, create.
                self.open_session_manager();
            }
            // The s/m/z prefix arms dispatch through the git/settings
            // arms above (Terminal-screen scoped there); these variants
            // exist for exhaustive matches and any future direct
            // binding. Keep the behavior identical to the scoped arms.
            Shortcut::SplitPane => {
                if self.screen == TuiScreen::Terminal {
                    self.open_split_mode();
                }
            }
            Shortcut::MovePane => {
                if self.screen == TuiScreen::Terminal {
                    self.open_move_mode();
                }
            }
            Shortcut::ZoomPane => {
                if self.screen == TuiScreen::Terminal {
                    self.split_toggle_zoom();
                }
            }
            Shortcut::ResizePane => {
                if self.screen == TuiScreen::Terminal {
                    self.open_resize_mode();
                }
            }
        }
    }

    /// Chat lens toggle shared by the footer's plain `Shift+L` and the
    /// `Ctrl+B Shift+L` chord (review F1: the footer advertised the
    /// key but only the prefix binding fired). Only meaningful over
    /// the terminal screen, and only for panes with a transcript
    /// provider (design section 6). Unsupported panes show positive
    /// evidence instead of silently ignoring the key.
    pub(crate) fn toggle_lens_from_footer(&mut self) {
        if self.screen == TuiScreen::Terminal {
            // Read the session snapshot up front: the borrow ends
            // before the mutable lens toggle.
            let session = self
                .view_pane()
                .and_then(|pane| pane.agent_session.as_ref());
            match session.map(|s| s.chat_supported()) {
                Some(true) => {
                    // Refusal shape (resolvable: false): the lens opens
                    // but the hint carries the refusal reason (design
                    // section 6: "reason drives the lens hint text").
                    // Only the open shows the copy; closing says
                    // "lens closed".
                    let refusal = session
                        .filter(|s| !s.resolvable)
                        .and_then(|s| s.reason.as_deref())
                        .map(refusal_reason_copy);
                    self.lens.toggle();
                    self.status = match (&refusal, self.lens.active) {
                        (Some(copy), true) => format!("lens: {copy}"),
                        (Some(_), false) => "lens closed".to_string(),
                        (None, true) => "lens: j/k scroll · G tail · Esc close".to_string(),
                        (None, false) => "lens closed".to_string(),
                    };
                }
                Some(false) => {
                    self.status = "lens: unsupported agent".to_string();
                }
                None => {
                    self.status = "lens: no agent session on this pane".to_string();
                }
            }
        }
    }

    /// Composer prompt shared by the plain `Shift+C` footer key and the
    /// `Ctrl+B Shift+C` chord: message prompt for the focused pane,
    /// prefilled with the pane's draft.
    pub(crate) fn open_composer_from_footer(&mut self) {
        if self.screen == TuiScreen::Terminal {
            let mut input = PromptInput::new(PromptKind::ComposerMessage);
            if let Some(pane) = self.view_pane() {
                if let Some(draft) = self.composer_drafts.get(&pane.id) {
                    input.text = draft.clone();
                }
            }
            self.prompt_input = Some(input);
            self.status = "composer: type the message, Enter sends".to_string();
        }
    }

    /// Open the quit confirmation overlay. Remembers the mode to restore
    /// when the user cancels.
    pub(crate) fn request_quit(&mut self) {
        self.quit_prev_mode = self.mode;
        self.mode = TuiMode::ConfirmQuit;
        self.status = "quit? y confirms · Esc cancels".to_string();
    }

    /// Open a modal overlay (help/settings/worktree), remembering the
    /// mode it was opened from so closing returns there. Without this,
    /// overlays opened while attached drop back to Navigate and lose
    /// the attach context; the WebUI modals always return to whatever
    /// the user was doing underneath.
    pub(crate) fn open_overlay(&mut self, overlay: TuiMode) {
        // The stack remembers every opener, so nested overlays unwind
        // one level per close: help opened from inside the worktree
        // overlay closes back into it, and closing that overlay returns
        // to the original mode (e.g. Attach).
        self.overlay_stack.push(self.mode);
        self.mode = overlay;
    }

    /// Close the current overlay, restoring the context it was opened
    /// from (falls back to Navigate when the stack is somehow empty).
    pub(crate) fn close_overlay(&mut self) {
        self.mode = self.overlay_stack.pop().unwrap_or(TuiMode::Navigate);
    }

    /// Open the search palette (prefix `/`): reset the query and
    /// results, then enter the overlay on top of the current mode.
    /// Opening it while already open resets in place (desktop re-open
    /// refocuses the input) instead of nesting the palette over itself.
    pub(crate) fn open_search_palette(&mut self) {
        self.search_palette.open();
        // Desktop loads the recent-workspaces section when the palette
        // opens (`loadRecentWorkspaces`). Best effort: without the WebUI
        // server the palette stays open and usable for local navigation,
        // matching how the desktop tolerates a failed recents load.
        let mut recents_error = None;
        match self.search_palette.load_recents(&self.web_api) {
            Ok(()) => {}
            Err(err) => {
                self.search_palette.recents.clear();
                recents_error = Some(format!("recents unavailable: {err}"));
            }
        }
        // Show the recents immediately (empty query lists the recent
        // section, the desktop counterpart of opening the palette).
        self.search_palette.refresh_local(&self.snapshot);
        if self.mode != TuiMode::SearchPalette {
            self.open_overlay(TuiMode::SearchPalette);
        }
        // The failure note survives: it is the one signal the user
        // gets that the recents section is empty because the load
        // failed, not because there are no recents.
        self.status = match recents_error {
            Some(note) => note,
            None => "search: type query".to_string(),
        };
    }

    /// Close the search palette and restore the previous mode.
    pub(crate) fn close_search_palette(&mut self) {
        self.close_overlay();
    }

    /// Remove the selected recent-workspace entry from the server list
    /// (desktop per-row trash button). Keeps the palette open and the
    /// cursor valid, mirroring the desktop staying in the palette after
    /// a remove.
    pub(crate) fn remove_selected_recent(&mut self) {
        let Some(search::SearchCandidate::Recent { path, .. }) =
            self.search_palette.selected_candidate()
        else {
            self.status = "no recent workspace selected".to_string();
            return;
        };
        let path = path.clone();
        match self.web_api.remove_recent_workspace(&path) {
            Ok(_) => {
                self.search_palette
                    .recents
                    .retain(|recent| recent.path != path);
                // Desktop invalidates the cache after a remove so the
                // next open refetches the pruned list.
                self.search_palette.invalidate_recents();
                self.search_palette.refresh_local(&self.snapshot);
                self.status = format!("removed recent: {path}");
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    /// Clear every recent-workspace entry on the server (desktop section
    /// Clear button). Keeps the palette open with the emptied section.
    pub(crate) fn clear_recent_workspaces(&mut self) {
        match self.web_api.clear_recent_workspaces() {
            Ok(_) => {
                self.search_palette.recents.clear();
                // Desktop invalidates the cache after a clear.
                self.search_palette.invalidate_recents();
                self.search_palette.refresh_local(&self.snapshot);
                self.status = "recent workspaces cleared".to_string();
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    /// Open the help overlay with a clean filter and scroll. Every
    /// entry point (prefix `?`, bare `?` on Files/Git/Terminal) funnels
    /// through here so the reset behavior cannot drift between sites.
    pub(crate) fn open_help_overlay(&mut self) {
        self.open_overlay(TuiMode::Help);
        self.reset_help_state();
    }

    /// Close the help overlay and reset its filter/scroll for the next
    /// open (both the `?` toggle and the Esc closer go through here).
    pub(crate) fn close_help_overlay(&mut self) {
        self.close_overlay();
        self.reset_help_state();
    }

    /// Clear the help filter and scroll so the overlay always opens or
    /// closes from a clean state.
    pub(crate) fn reset_help_state(&mut self) {
        self.help_scroll = 0;
        self.help_filter.clear();
    }

    /// Cancel the quit overlay and return to the mode the user was in.
    pub(crate) fn cancel_quit(&mut self) {
        self.mode = self.quit_prev_mode;
        self.status = "quit cancelled".to_string();
    }

    pub(crate) fn run_git_action(
        &mut self,
        action: impl FnOnce(
            &mut GitPanel,
            &WebApiClient,
        ) -> Result<(), crate::tui::web_api::WebApiError>,
    ) {
        self.open_git_screen();
        self.git_panel.view = GitView::Changes;
        if let Err(err) = action(&mut self.git_panel, &self.web_api) {
            self.error = Some(err.to_string());
        }
    }

    pub(crate) fn create_tab(&mut self) {
        // Mixed-workspace splits: the strip shows the sidebar-selected
        // workspace's tabs, so creating there while the user looks at
        // another workspace's tile would surprise. Move the sidebar
        // cursor to the focused tile's workspace first (webui state.ws
        // parity: the workspace in view owns newTab), so the strip,
        // the ▸ marker, and the creation target agree. No split: the
        // view pane sits in the selected workspace already, so the
        // cursor move is a no-op and behavior is unchanged.
        if let Some((workspace_id, pane_id)) = self
            .view_pane()
            .map(|pane| (pane.workspace_id.clone(), pane.id.clone()))
        {
            if let Some(workspace_index) = self
                .snapshot
                .workspaces
                .iter()
                .position(|ws| ws.id == workspace_id)
            {
                self.selected_workspace = workspace_index;
            }
            if let Some(agent_index) = self
                .snapshot
                .agents
                .iter()
                .position(|agent| agent.pane_id == pane_id)
            {
                self.selected_agent = agent_index;
            } else {
                // Shell panes have no agent row: park the agent cursor
                // on the target workspace's first agent (or 0) so
                // selected_pane's workspace guard cannot strand it on
                // the old workspace's rows.
                self.selected_agent = self
                    .snapshot
                    .agents
                    .iter()
                    .position(|agent| agent.workspace_id == workspace_id)
                    .unwrap_or(0);
            }
        }
        let Some(workspace) = self
            .selected_workspace()
            .map(|workspace| workspace.id.clone())
        else {
            self.error = Some("no workspace selected".to_string());
            return;
        };
        let workspace_label = self
            .selected_workspace()
            .map(|ws| ws.label.clone())
            .unwrap_or_default();
        match self.client.create_tab(Some(&workspace), None) {
            Ok(_) => {
                // Name the workspace: on a mixed split the chord also
                // moves the sidebar cursor, and a bare "tab created"
                // left that switch silent (ux review finding). The
                // notice (not a bare status write) survives the
                // refresh below: apply_refresh overwrites unheld text.
                self.set_status_notice(format!("tab created in {workspace_label}"));
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    pub(crate) fn close_selected_tab(&mut self) {
        // Webui closePanel parity: `state.tab` (the routed panel) closes,
        // so the workspace the chord reads must be the view pane's own,
        // not the sidebar cursor's. On a mixed-workspace split the two
        // differ; anchoring on the sidebar made the view-pane filter
        // reject and the chain fall through to the sidebar workspace's
        // active/first tab, closing a panel the user was not looking
        // at. The view pane's tab must also still sit in its own
        // workspace's tab list, else it is stale snapshot data and
        // the active/first-tab chain of that same workspace takes over.
        let close_target = (|| {
            let Some(pane) = self.view_pane() else {
                return self
                    .selected_workspace()
                    .map(|workspace| (workspace.id.clone(), workspace));
            };
            let workspace = self
                .snapshot
                .workspaces
                .iter()
                .find(|ws| ws.id == pane.workspace_id);
            match workspace {
                Some(ws) => Some((ws.id.clone(), ws)),
                // Pane whose workspace left the snapshot: stale data,
                // fall back to the selected workspace's chain.
                None => self
                    .selected_workspace()
                    .map(|workspace| (workspace.id.clone(), workspace)),
            }
        })();
        let Some((workspace_id, workspace)) = close_target else {
            self.error = Some("no workspace selected".to_string());
            return;
        };
        let active_tab_id = workspace.active_tab_id.clone();
        let fallback_tabs = self.snapshot.workspace_tabs(&workspace_id);
        // Stale-pane guard: the view pane's tab must still be listed;
        // otherwise active/first of the same workspace.
        let tab_id = self
            .view_pane()
            .filter(|pane| {
                pane.workspace_id == workspace_id
                    && fallback_tabs.iter().any(|tab| tab.id == pane.tab_id)
            })
            .map(|pane| pane.tab_id.clone())
            .or_else(|| active_tab_id.clone())
            .or_else(|| fallback_tabs.first().map(|tab| tab.id.clone()));
        let Some(tab_id) = tab_id else {
            self.error = Some("no tab to close".to_string());
            return;
        };
        // Webui closeTab guard (gap 7): closing the last tab in a
        // workspace also closes the workspace. The built-in backend
        // auto-closes emptied workspaces, but external backends may
        // keep them, so the TUI mirrors the webui and closes it
        // explicitly after the tab is gone.
        let was_last_tab = fallback_tabs.len().max(1) == 1;
        let closed_tab_label = fallback_tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.label.clone());
        match self
            .client
            .request("tab.close", serde_json::json!({ "tab_id": tab_id }))
        {
            Ok(_) => {
                // Name what closed: the fallback chain can act on the
                // active/first tab, and the footer must distinguish
                // that from closing the panel the user was viewing.
                // The notice arms the hold so the refresh below cannot
                // swap it for the idle backend line before a render.
                let closed_status = match closed_tab_label {
                    Some(label) => format!("tab {label} closed"),
                    None => "tab closed".to_string(),
                };
                self.set_status_notice(closed_status);
                if was_last_tab {
                    if let Err(err) = self.client.request(
                        "workspace.close",
                        serde_json::json!({ "workspace_id": workspace_id }),
                    ) {
                        // The built-in backend may have already dropped
                        // the emptied workspace; only surface real
                        // failures.
                        if !err.to_string().contains("not found") {
                            self.error = Some(err.to_string());
                        }
                    }
                }
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
                self.clamp_selection();
            }
            Err(err) => {
                // The tab may already be gone server-side (pane.exited
                // raced this close, or the workspace died in between):
                // not-found means the outcome we wanted, so run the same
                // post-close flow instead of surfacing an error.
                if !err.to_string().contains("not found") {
                    self.error = Some(err.to_string());
                    return;
                }
                let closed_status = match &closed_tab_label {
                    Some(label) => format!("tab {label} closed"),
                    None => "tab closed".to_string(),
                };
                self.set_status_notice(closed_status);
                if was_last_tab {
                    if let Err(ws_err) = self.client.request(
                        "workspace.close",
                        serde_json::json!({ "workspace_id": workspace_id }),
                    ) {
                        // The built-in backend may have already dropped
                        // the emptied workspace; only surface real
                        // failures.
                        if !ws_err.to_string().contains("not found") {
                            self.error = Some(ws_err.to_string());
                        }
                    }
                }
                if let Err(refresh_err) = self.refresh() {
                    self.error = Some(refresh_err.to_string());
                }
                self.clamp_selection();
            }
        }
    }

    pub(crate) fn open_files_screen(&mut self) {
        if self.screen == TuiScreen::Files {
            return;
        }
        self.screen = TuiScreen::Files;
        // A dirty preview survives the screen switch like a webui
        // dirty editor tab: skip the rebuild so the buffer and its
        // explorer stay together until saved or reloaded.
        if self.file_explorer.preview.dirty && self.file_explorer.preview.path.is_some() {
            return;
        }
        let Some(cwd) = self.active_cwd() else {
            return;
        };
        self.file_explorer = FileExplorer::new(&cwd);
        if let Err(err) = self.file_explorer.refresh(&self.web_api) {
            self.error = Some(err.to_string());
        }
    }

    pub(crate) fn open_git_screen(&mut self) {
        if self.screen == TuiScreen::Git {
            return;
        }
        self.screen = TuiScreen::Git;
        let Some(cwd) = self.active_cwd() else {
            return;
        };
        self.git_panel.set_cwd(&cwd);
        if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
            self.error = Some(err.to_string());
        }
    }

    pub(crate) fn refresh_active_screen(&mut self) {
        match self.screen {
            TuiScreen::Terminal => {
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                    return;
                }
                // refresh() rewrites an unheld status to the idle
                // backend summary, so the refresh chord with no other
                // outcome would leave the line byte-identical and look
                // like a dead key. Report through the hold convention
                // (webui diff view spins its refresh button).
                self.set_status_notice("refreshed".to_string());
            }
            TuiScreen::Files => {
                if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            TuiScreen::Git => {
                if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
        }
    }

    /// Handle in-panel keys (files/git screens) while in attach mode.
    pub(crate) fn handle_panel_key(&mut self, key: KeyEvent) {
        match self.screen {
            TuiScreen::Files => self.handle_files_key(key),
            TuiScreen::Git => self.handle_git_key(key),
            TuiScreen::Terminal => {}
        }
    }

    pub(crate) fn handle_files_key(&mut self, key: KeyEvent) {
        // While editing, all keys type into the buffer; Esc exits edit mode.
        if self.file_explorer.edit_active {
            // Find bar owns the keyboard while active (webui Ctrl+F bar):
            // typing re-runs incrementally, Enter/Shift+Enter cycle, A/X
            // flip toggles, Esc closes keeping the query.
            if self.file_explorer.editor_find.active {
                self.handle_editor_find_key(key);
                return;
            }
            match self.file_explorer.edit_key(key, &self.web_api) {
                Ok(()) => {
                    if !self.file_explorer.edit_active {
                        self.status = if self.file_explorer.preview.dirty {
                            "edit mode left with unsaved changes".to_string()
                        } else {
                            "edit mode closed".to_string()
                        };
                    } else if key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('f')
                    {
                        self.file_explorer.editor_find_open();
                        self.status = "find: Enter next, Shift+Enter prev, Esc closes".to_string();
                    } else if key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('h')
                    {
                        // Replace flows through the shared prompt: type
                        // the replacement, Enter replaces the current
                        // match, `!` replaces all (documented deviation
                        // from the webui's dedicated replace bar).
                        self.prompt_input = Some(PromptInput {
                            kind: PromptKind::ReplaceInFile,
                            text: String::new(),
                        });
                    } else if key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('s')
                    {
                        self.status = "saved".to_string();
                    }
                }
                Err(err) => self.error = Some(err.to_string()),
            }
            return;
        }
        if self.file_explorer.filter_active {
            match key.code {
                KeyCode::Enter => self.file_explorer.commit_filter(),
                KeyCode::Esc => {
                    self.file_explorer.filter_active = false;
                    self.file_explorer.filter.clear();
                }
                KeyCode::Backspace => self.file_explorer.pop_filter_char(),
                KeyCode::Char(ch) => self.file_explorer.push_filter_char(ch),
                _ => {}
            }
            if self.file_explorer.filter_active {
                return;
            }
            // Committing the filter runs the search for the active
            // kind: tree search refreshes entries, content search fills
            // the grouped results (webui `runContentSearch`).
            let result = if self.file_explorer.search_mode
                && self.file_explorer.search_kind == SearchKind::Content
            {
                run_content_search(&mut self.file_explorer, &self.web_api, false)
                    .map(|_| self.status = "content search done".to_string())
            } else {
                self.file_explorer
                    .refresh(&self.web_api)
                    .map(|_| self.status = String::new())
            };
            if let Err(err) = result {
                self.error = Some(err.to_string());
            }
            return;
        }
        // Content-search results own the keyboard while visible
        // (webui results view): j/k move over the flat rows, Enter
        // jumps/toggles, +/- page, A/X flip match-case/regex.
        if self.file_explorer.search_mode
            && self.file_explorer.search_kind == SearchKind::Content
            && self.file_explorer.content_search.has_results()
        {
            self.handle_content_search_key(key);
            return;
        }
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => self.file_explorer.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.file_explorer.move_selection(-1),
            KeyCode::Enter => {
                // Webui click parity: Enter toggles inline expansion for
                // directories and opens the preview for files. Entering a
                // directory as the new root stays on `l` (double-click).
                match self.file_explorer.toggle_expand(&self.web_api) {
                    Err(err) => self.error = Some(err.to_string()),
                    // Not a directory: open the preview; failures surface.
                    Ok(false) => {
                        if let Err(err) = self.file_explorer.open_preview(&self.web_api) {
                            self.error = Some(err.to_string());
                        }
                    }
                    Ok(true) => {}
                }
            }
            KeyCode::Char('l') | KeyCode::Right => {
                if self.file_explorer.enter_directory()
                    || self
                        .file_explorer
                        .toggle_expand(&self.web_api)
                        .unwrap_or(false)
                {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
            }
            // `h`/Left and `u` both go up one directory and refresh;
            // failures surface in the status bar like every panel error.
            KeyCode::Char('h') | KeyCode::Left | KeyCode::Char('u') => {
                if self.file_explorer.go_up() {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            // Webui file-browser "show history": open the git Log view
            // scoped to the selected file (`logFilePath`). Plain `h` is
            // go-up here, so the log entry is `L` (Log).
            KeyCode::Char('L') => {
                let file = self
                    .file_explorer
                    .selected_entry()
                    .filter(|entry| !entry.is_dir)
                    .map(|entry| entry.path.clone());
                match file {
                    Some(file) => {
                        self.open_git_screen();
                        self.git_panel.view = GitView::Log;
                        self.git_panel.log_file = Some(file.clone());
                        self.git_panel.log_limit = crate::tui::panels::git::LOG_PAGE_SIZE;
                        self.refresh_active_screen();
                        self.status = format!("log: {file}");
                    }
                    None => self.error = Some("select a file first".to_string()),
                }
            }
            // Tab cycles recently opened previews (webui open-file
            // tabs approximation). Blocked on a dirty buffer like the
            // webui blocks tab switches with unsaved editors.
            KeyCode::Tab => match self.file_explorer.cycle_recent_preview(&self.web_api) {
                Ok(true) => self.status = "switched preview".to_string(),
                Ok(false) => {
                    self.status = if self.file_explorer.preview.dirty {
                        "save or discard before switching".to_string()
                    } else {
                        "no recent previews".to_string()
                    }
                }
                Err(err) => self.error = Some(err.to_string()),
            },
            // Reveal the git-panel selected file in the tree
            // (neovim reveal-current-file; plan reserves prefix F, so
            // plain `w` carries it here like `w` in the git log view
            // reuses the worktree prompt).
            KeyCode::Char('w') => {
                let file = self
                    .git_panel
                    .selected_file()
                    .map(|entry| entry.path.clone());
                match file {
                    Some(file) => match self.file_explorer.reveal_path(&self.web_api, &file) {
                        Ok(()) => self.status = format!("revealed {file}"),
                        Err(err) => self.error = Some(err.to_string()),
                    },
                    None => self.error = Some("no file selected in the git panel".to_string()),
                }
            }
            KeyCode::Char('/') => self.file_explorer.start_filter(),
            // Cycle the filter scope (webui filter-kind toggle button):
            // Files → Folders → Content.
            KeyCode::Char('t') => {
                self.file_explorer.cycle_search_kind();
                self.status = format!("search: {}", self.file_explorer.search_kind.label());
            }
            // New file (webui mobile new-file flow): empty file created
            // via `file_write` under the current root, then previewed.
            KeyCode::Char('a') => {
                self.prompt_input = Some(PromptInput {
                    kind: PromptKind::CreateFile,
                    text: String::new(),
                });
            }
            // New directory: `.gitkeep` marker via `file_write` (the
            // API has no mkdir endpoint; documented deviation).
            KeyCode::Char('A') => {
                self.prompt_input = Some(PromptInput {
                    kind: PromptKind::CreateDirectory,
                    text: String::new(),
                });
            }
            // Markdown outline flip (gap 22): webui eye toggle. M shows
            // the header outline of the open markdown preview (or the
            // source again); a non-markdown preview explains itself.
            KeyCode::Char('M') => match self.file_explorer.toggle_markdown_outline() {
                Some(true) => self.status = "outline view (M shows source)".to_string(),
                Some(false) => self.status = "source view".to_string(),
                None => {
                    self.error = Some("open a markdown file first".to_string());
                }
            },
            KeyCode::Char('e') => match self.file_explorer.start_edit() {
                Ok(()) => self.status = "editing: Ctrl-S saves, Esc stops".to_string(),
                Err(err) => self.error = Some(err.to_string()),
            },
            KeyCode::Char('R') => {
                // Rename the selected file: prefill the prompt with the
                // current name so editing is incremental.
                let name = self
                    .file_explorer
                    .selected_entry()
                    .map(|entry| entry.name.clone())
                    .unwrap_or_default();
                if name.is_empty() {
                    self.error = Some("no file selected".to_string());
                } else if self.file_explorer.preview.dirty
                    && self.file_explorer.preview.path.is_some()
                {
                    // Renaming would desync the dirty buffer's path from
                    // the file on disk; require a save or reload first.
                    self.error =
                        Some("unsaved edits: save or reload before renaming files".to_string());
                } else {
                    self.prompt_input = Some(PromptInput {
                        kind: PromptKind::RenameFile,
                        text: name,
                    });
                }
            }
            KeyCode::Char('x') => {
                let name = self
                    .file_explorer
                    .selected_entry()
                    .map(|entry| entry.name.clone())
                    .unwrap_or_default();
                if name.is_empty() {
                    self.error = Some("no file selected".to_string());
                } else if self.file_explorer.preview.dirty
                    && self.file_explorer.preview.path.is_some()
                {
                    // Deleting would orphan the dirty buffer (a later save
                    // would recreate the file); the webui also refuses
                    // editing deleted files.
                    self.error =
                        Some("unsaved edits: save or reload before deleting files".to_string());
                } else {
                    self.prompt_input = Some(PromptInput {
                        kind: PromptKind::ConfirmDeleteFile,
                        text: String::new(),
                    });
                }
            }
            KeyCode::Char('?') => {
                self.open_help_overlay();
            }
            KeyCode::Esc | KeyCode::Char('q') => self.screen = TuiScreen::Terminal,
            _ => {}
        }
    }

    pub(crate) fn handle_git_key(&mut self, key: KeyEvent) {
        // Diff search (webui Ctrl+F): while active it owns the keyboard;
        // Enter commits the query, Esc closes, typing searches
        // incrementally, n/N still work from the committed state.
        if self.git_panel.diff_search_active {
            match key.code {
                // Enter commits the query but keeps the matches so n/N
                // keep cycling; Esc forgets the search entirely.
                KeyCode::Enter => self.git_panel.end_diff_search(),
                KeyCode::Esc => self.git_panel.cancel_diff_search(),
                KeyCode::Backspace => self.git_panel.pop_diff_search_char(),
                KeyCode::Char('n') => {
                    self.git_panel.diff_search_next();
                }
                KeyCode::Char('N') => {
                    self.git_panel.diff_search_prev();
                }
                KeyCode::Char(ch) => {
                    self.git_panel.push_diff_search_char(ch);
                }
                _ => {}
            }
            self.status = format!(
                "diff search: {} ({} matches)",
                self.git_panel.diff_search_query,
                self.git_panel.diff_search_matches.len()
            );
            return;
        }
        match key.code {
            // Esc also clears a committed search (bar closed by Enter but
            // matches kept): the webui Esc dismisses the highlight too.
            KeyCode::Esc
                if self.git_panel.view == GitView::Changes
                    && !self.git_panel.diff_search_matches.is_empty() =>
            {
                self.git_panel.cancel_diff_search();
            }
            // Webui Ctrl+F in the diff: open the incremental search
            // while the Changes diff pane is the target.
            KeyCode::Char('/') if self.git_panel.view == GitView::Changes => {
                self.git_panel.start_diff_search();
                self.status = "diff search: type to match, n/N cycle, Esc closes".to_string();
            }
            KeyCode::Char('n') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.diff_search_next() {
                    self.status = "no diff search matches".to_string();
                }
            }
            KeyCode::Char('N') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.diff_search_prev() {
                    self.status = "no diff search matches".to_string();
                }
            }
            KeyCode::Char('j') | KeyCode::Down => self.git_panel.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.git_panel.move_selection(-1),
            // Hunk actions (gap 14, webui per-hunk stage/unstage
            // buttons): J/K walk the `@@` headers of the loaded Changes
            // diff (wrapping), H applies the hunk action — stage when
            // the diff is working-tree scope, unstage when staged.
            KeyCode::Char('J') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.move_hunk_selection(1) {
                    self.status = "no hunks in the loaded diff".to_string();
                } else {
                    self.status = format!("hunk {}", self.git_panel.diff_hunk_selected + 1);
                }
            }
            KeyCode::Char('K') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.move_hunk_selection(-1) {
                    self.status = "no hunks in the loaded diff".to_string();
                } else {
                    self.status = format!("hunk {}", self.git_panel.diff_hunk_selected + 1);
                }
            }
            KeyCode::Char('H') if self.git_panel.view == GitView::Changes => {
                match self.git_panel.apply_hunk_action(&self.web_api) {
                    Ok(()) => self.status = "hunk applied".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Tab => {
                self.git_panel.view = match self.git_panel.view {
                    GitView::Changes => GitView::Log,
                    GitView::Log => GitView::Branches,
                    GitView::Branches => GitView::Stash,
                    GitView::Stash => GitView::History,
                    GitView::History => GitView::Conflicts,
                    GitView::Conflicts => GitView::Cleanup,
                    GitView::Cleanup => GitView::Changes,
                };
                self.refresh_active_screen();
            }
            // Webui `selectLogCommit` shift-click arm (gap 11 two-commit
            // compare): Space marks up to two commits, `c` compares the
            // pair ordered by log position (newest = target).
            KeyCode::Char(' ') if self.git_panel.view == GitView::Log => {
                if let Some(hash) = self.git_panel.selected_commit_hash().map(str::to_string) {
                    self.git_panel.log_toggle_selection(&hash);
                    self.status = format!("selected: {:?}", self.git_panel.log_selected);
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            // Log view compare: with two commits marked (Space) Enter
            // compares the pair (newest = target); otherwise Enter falls
            // through to the generic Enter arm below and compares the
            // selection with its parent. `c` stays the commit modal in
            // every git view.
            KeyCode::Enter
                if self.git_panel.view == GitView::Log
                    && self.git_panel.log_selected.len() == 2 =>
            {
                match self.git_panel.log_compare_selection(&self.web_api) {
                    Ok(()) => self.status = "compare loaded".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            // Log view actions (webui log toolbar). All guarded to Log so
            // the shared git keys keep their meaning elsewhere. `s` (stage)
            // has no use in Log, so it cycles the log scope here.
            KeyCode::Char('s') if self.git_panel.view == GitView::Log => {
                self.git_panel.cycle_log_scope();
                if let Err(err) = self.git_panel.refresh_log(&self.web_api) {
                    self.error = Some(err.to_string());
                } else {
                    self.status = format!("log scope: {}", self.git_panel.log_scope.label());
                }
            }
            KeyCode::Char('+') if self.git_panel.view == GitView::Log => {
                if self.git_panel.log_load_more() {
                    if let Err(err) = self.git_panel.refresh_log(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = format!("log limit: {}", self.git_panel.log_limit);
                    }
                } else {
                    self.status = "no more commits".to_string();
                }
            }
            KeyCode::Char('t') if self.git_panel.view == GitView::Log => {
                if self.git_panel.selected_commit_hash().is_some() {
                    self.prompt_input = Some(PromptInput::new(PromptKind::CreateTag));
                    self.status = PromptKind::CreateTag.title().to_string();
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            KeyCode::Char('R') if self.git_panel.view == GitView::Log => {
                if self.git_panel.selected_commit_hash().is_some() {
                    self.prompt_input = Some(PromptInput::new(PromptKind::ResetMode));
                    self.status = PromptKind::ResetMode.title().to_string();
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            KeyCode::Char('b') if self.git_panel.view == GitView::Log => {
                if self.git_panel.selected_commit_hash().is_some() {
                    self.prompt_input = Some(PromptInput::new(PromptKind::RebaseUpstream));
                    self.status = PromptKind::RebaseUpstream.title().to_string();
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            // Webui "worktree from branch": reuse the worktree creation
            // prompt chain, starting on the base ref (Enter keeps the
            // default, matching the webui flow).
            KeyCode::Char('w') if self.git_panel.view == GitView::Log => {
                self.worktree_create_stage = None;
                self.prompt_input = self
                    .worktree_default_base()
                    .map(|base| PromptInput::with_text(PromptKind::CreateWorktreeBase, base))
                    .or_else(|| Some(PromptInput::new(PromptKind::CreateWorktreeBase)));
                self.status = PromptKind::CreateWorktreeBase.title().to_string();
            }
            KeyCode::Char('s') => {
                if let Err(err) = self.git_panel.stage_selected(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            // Webui git-panel `stageAll: KeyG`: toggle stage all from
            // the Changes view without the prefix.
            KeyCode::Char('G') if self.git_panel.view == GitView::Changes => {
                match self.git_panel.toggle_stage_all(&self.web_api) {
                    Ok(()) => self.status = "staged state toggled".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('d') => {
                // Discarding the file under edit would make the dirty
                // buffer diverge from disk with no reload prompt; the
                // 409-style guard belongs here too.
                let selected_path = self
                    .git_panel
                    .selected_file()
                    .map(|entry| entry.path.clone());
                if self.file_explorer.preview.dirty
                    && selected_path.is_some_and(|path| {
                        self.file_explorer.preview.path.as_deref() == Some(path.as_str())
                    })
                {
                    self.error = Some(
                        "unsaved edits: save or reload before discarding this file".to_string(),
                    );
                } else if let Err(err) = self.git_panel.discard_selected(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('f') => {
                if let Err(err) = self.git_panel.fetch(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('p') => {
                if let Err(err) = self.git_panel.pull(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('P') => {
                if let Err(err) = self.git_panel.push(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            // Webui branch creation: `B` prompts for a new branch name
            // (git_switch create: true) in the Branches view. Plain `c`
            // opens the commit modal in every git view, so the old
            // triple-dispatch (commit / create / compare) is gone.
            KeyCode::Char('B') if self.git_panel.view == GitView::Branches => {
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateBranch));
                self.status = PromptKind::CreateBranch.title().to_string();
            }
            KeyCode::Char('c') => {
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: false,
                });
            }
            KeyCode::Char('a') => {
                if self.git_panel.view == GitView::Stash {
                    // Stash view: a applies the selected stash (webui
                    // stash apply button; Enter is the diff preview now).
                    if let Err(err) = self.git_panel.stash_apply(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "stash applied".to_string();
                    }
                } else {
                    self.commit_input = Some(CommitInput {
                        text: String::new(),
                        amend: true,
                    });
                }
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Char('D') => match self.git_panel.view {
                GitView::Branches => {
                    let selected = self.git_panel.branches.get(self.git_panel.branch_selected);
                    match selected {
                        Some(entry) if entry.current => {
                            self.error = Some("cannot delete the current branch".to_string());
                        }
                        Some(_) => {
                            self.prompt_input = Some(PromptInput {
                                kind: PromptKind::ConfirmDeleteBranch,
                                text: String::new(),
                            });
                        }
                        None => self.error = Some("no branch selected".to_string()),
                    }
                }
                GitView::Stash => {
                    if self
                        .git_panel
                        .stashes
                        .get(self.git_panel.stash_selected)
                        .is_some()
                    {
                        self.prompt_input = Some(PromptInput {
                            kind: PromptKind::ConfirmDropStash,
                            text: String::new(),
                        });
                    } else {
                        self.error = Some("no stash selected".to_string());
                    }
                }
                _ => {}
            },
            KeyCode::Enter => match self.git_panel.view {
                GitView::Changes => {
                    if let Err(err) = self.git_panel.refresh_diff(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
                // Stash split view: Enter loads the selected stash's diff
                // (webui stash view preview).
                GitView::Stash => {
                    if let Err(err) = self.git_panel.load_stash_diff(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "stash diff loaded".to_string();
                    }
                }
                // History rows are commits: Enter loads the selected commit's
                // diff (webui `showHistoryCommit`) into the History diff
                // pane; the view itself stays so the file context is kept.
                GitView::History => {
                    let hash = self
                        .git_panel
                        .commits
                        .get(self.git_panel.commit_selected)
                        .map(|commit| commit.hash.clone());
                    match hash {
                        Some(hash) => {
                            let file = self.git_panel.history_file.clone();
                            match self.git_panel.load_commit_diff(&self.web_api, &hash) {
                                Ok(()) => {
                                    self.status = format!(
                                        "commit {hash}{}",
                                        file.map(|f| format!(" · {f}")).unwrap_or_default()
                                    );
                                }
                                Err(err) => self.error = Some(err.to_string()),
                            }
                        }
                        None => self.error = Some("no commit selected".to_string()),
                    }
                }
                GitView::Branches => {
                    if let Err(err) = self.git_panel.switch_selected(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        // The worktree stamp cache still answers with the
                        // pre-switch branch; drop it so the next refresh
                        // re-stamps the workspace badge from a real
                        // worktree.list call.
                        self.invalidate_stamp(&self.git_panel.cwd.clone());
                        self.status = format!(
                            "switched to {}",
                            self.git_panel
                                .branches
                                .get(self.git_panel.branch_selected)
                                .map(|entry| entry.name.clone())
                                .unwrap_or_default()
                        )
                    }
                }
                GitView::Log => {
                    // Webui log commit preview: compare the selected
                    // commit with its parent into the Log diff pane.
                    let hash = self.git_panel.selected_commit_hash().map(str::to_string);
                    match hash {
                        Some(hash) => {
                            match self.git_panel.log_compare_parent(&self.web_api, &hash) {
                                Ok(()) => self.status = format!("compare {hash}^..{hash}"),
                                Err(err) => self.error = Some(err.to_string()),
                            }
                        }
                        None => self.error = Some("no commit selected".to_string()),
                    }
                }
                GitView::Conflicts | GitView::Cleanup => {}
            },
            // Conflicts view actions (webui conflicts tab buttons).
            // Keys avoid the shared git actions: o/e/t/m for resolve modes
            // (p is pull and r is refresh in every git view), R/S/A for the
            // operation continue/skip/abort.
            KeyCode::Char('o') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::Ours)
                {
                    Ok(()) => self.status = "resolved with HEAD".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('e') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::Parent)
                {
                    Ok(()) => self.status = "resolved with parent".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('t') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::Remote)
                {
                    Ok(()) => self.status = "resolved with remote".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('m') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::MarkResolved)
                {
                    Ok(()) => self.status = "marked resolved".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('R') if self.git_panel.view == GitView::Conflicts => {
                let action = if self.git_panel.rebase_in_progress {
                    ConflictAction::RebaseContinue
                } else {
                    ConflictAction::MergeContinue
                };
                match self.git_panel.conflict_action(&self.web_api, action) {
                    Ok(()) => self.status = "operation continued".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('S') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .conflict_action(&self.web_api, ConflictAction::RebaseSkip)
                {
                    Ok(()) => self.status = "rebase commit skipped".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('A') if self.git_panel.view == GitView::Conflicts => {
                let action = if self.git_panel.rebase_in_progress {
                    ConflictAction::RebaseAbort
                } else {
                    ConflictAction::MergeAbort
                };
                match self.git_panel.conflict_action(&self.web_api, action) {
                    Ok(()) => self.status = "operation aborted".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            // Webui cleanup multi-select: Space toggles the mark on the
            // cursor row (webui checkbox), `x` opens the delete confirm.
            KeyCode::Char(' ') if self.git_panel.view == GitView::Cleanup => {
                self.git_panel.cleanup_toggle_mark();
                self.status = format!("marked {} item(s)", self.git_panel.cleanup_marked.len());
            }
            KeyCode::Char('x') if self.git_panel.view == GitView::Cleanup => {
                match self.git_panel.selected_cleanup_item() {
                    Some(_) => {
                        self.prompt_input =
                            Some(PromptInput::new(PromptKind::ConfirmCleanupDelete));
                    }
                    None => self.error = Some("no cleanup item selected".to_string()),
                }
            }
            KeyCode::Char('B') if self.git_panel.view == GitView::Cleanup => {
                match self.git_panel.cleanup_prune(&self.web_api) {
                    Ok(()) => {
                        // A prune that removed administrative entries
                        // changed the worktree.list rows; drop the stamp
                        // cache for the pane's own repo so the next
                        // refresh re-stamps from a real reply.
                        let repo = self
                            .git_panel
                            .selected_cleanup_item()
                            .map(|item| item.repo)
                            .unwrap_or_else(|| self.git_panel.cwd.clone());
                        self.invalidate_stamp(&repo);
                        self.status = "worktrees pruned".to_string();
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            // Plain ? opens the help overlay from any git view (the
            // footer advertises Ctrl+B ?; a bare ? is the natural reflex).
            KeyCode::Char('?') => {
                self.open_help_overlay();
            }
            KeyCode::Esc | KeyCode::Char('q') => self.screen = TuiScreen::Terminal,
            _ => {}
        }
    }

    pub(crate) fn handle_navigation_key(&mut self, key: KeyEvent) {
        // The Files and Git screens own their keys in Navigate mode too;
        // only the Terminal screen keeps the workspace/agent list keys.
        if self.screen != TuiScreen::Terminal {
            self.handle_panel_key(key);
            return;
        }
        // Split/move overlays own the keyboard while open (design:
        // hjkl/arrows walk, Tab flips, p cycles, Enter commits, Esc
        // cancels). They sit above the pane-scroll and sidebar keys so
        // no accidental scroll moves anything mid-preview.
        if self.split_mode.is_some() {
            self.handle_split_mode_key(key);
            return;
        }
        if self.move_mode.is_some() {
            self.handle_move_mode_key(key);
            return;
        }
        if self.resize_mode.is_some() {
            self.handle_resize_mode_key(key);
            return;
        }
        // Double-Esc reflex: when the previous key closed a split/move
        // overlay, the immediate next Esc swallows here instead of
        // opening the quit confirm. Any other key clears the flag.
        if key.code == KeyCode::Esc {
            if self.just_closed_mode {
                self.just_closed_mode = false;
                self.status = "press q to quit".to_string();
                return;
            }
        } else {
            self.just_closed_mode = false;
        }
        // Focus walker (Ctrl+B . / ,) regions: when the main screen
        // owns focus, j/k and Enter stop moving the sidebar cursor and
        // act on the pane instead (Enter attach, j/k pane scroll is not
        // a pane feature so they stay inert there); the sidebar keys
        // (Tab/a/w) still work so focus never traps the user. When the
        // sidebar owns focus the old behavior applies (ux fix: the
        // walker used to be a status-line message with no effect).
        if self.main_focused {
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => self.request_quit(),
                KeyCode::Char('?') => {
                    self.open_help_overlay();
                }
                KeyCode::Char('r') => self.refresh_active_screen(),
                // Plain Shift+L / Shift+C (review F1): the TerminalMain
                // footer advertises these keys, so the main-focus arm
                // must honor them, not only the Ctrl+B chord. They
                // share the exact dispatch body with the prefix route.
                KeyCode::Char('L') => self.toggle_lens_from_footer(),
                KeyCode::Char('C') => self.open_composer_from_footer(),
                KeyCode::Tab | KeyCode::BackTab => self.toggle_sidebar_focus(),
                KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
                KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
                KeyCode::Enter => self.attach_selected(),
                // Split-active tile walk (design: hjkl/arrows walk focus
                // between tiles): when a walk finds a neighbor the focus
                // moves there; with a single tile the keys fall back to
                // pane scroll so the pre-split behavior stays.
                // Ctrl+hjkl/arrows scroll the focused pane instead of
                // walking: the explicit scroll escape when the walk
                // would move to a neighbor (docs: tui-shortcuts).
                KeyCode::Up | KeyCode::Char('k')
                    if key.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    self.scroll_pane_up(1);
                }
                KeyCode::Down | KeyCode::Char('j')
                    if key.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    self.scroll_pane_down(1);
                }
                KeyCode::Up | KeyCode::Char('k') => self.nav_vertical_key(-1),
                KeyCode::Down | KeyCode::Char('j') => self.nav_vertical_key(1),
                KeyCode::Left | KeyCode::Char('h') => {
                    if !self.split_walk_fallback(-1, 0) {
                        // Horizontal keys had no pre-split scroll binding;
                        // with a single tile they stay inert.
                    }
                }
                KeyCode::Right | KeyCode::Char('l') => if !self.split_walk_fallback(1, 0) {},
                KeyCode::PageUp => {
                    self.scroll_pane_up(10);
                }
                KeyCode::PageDown => {
                    self.scroll_pane_down(10);
                }
                KeyCode::Char('G') | KeyCode::End => {
                    self.scroll_pane_down(usize::MAX);
                }
                KeyCode::Char('g') | KeyCode::Home => {
                    let len = self.pane_scrollback_lines().len();
                    self.scroll_pane_up(len);
                }
                _ => {}
            }
            return;
        }
        match key.code {
            // Only the Terminal screen reaches this handler; Files and Git
            // delegate to their panel handlers above.
            KeyCode::Char('q') | KeyCode::Esc => self.request_quit(),
            KeyCode::Char('?') => {
                self.open_help_overlay();
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            // Page keys scroll the pane even with the sidebar focused:
            // the pane is the main surface, the lists have no page
            // semantics to shadow.
            KeyCode::PageUp => {
                self.scroll_pane_up(10);
            }
            KeyCode::PageDown => {
                self.scroll_pane_down(10);
            }
            KeyCode::Tab | KeyCode::BackTab => self.toggle_sidebar_focus(),
            // Footer-advertised lens/composer keys work with the
            // sidebar focused too: the hint line renders in both
            // focus states, so the keys must not be focus-dependent
            // (review F1).
            KeyCode::Char('L') => self.toggle_lens_from_footer(),
            KeyCode::Char('C') => self.open_composer_from_footer(),
            KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
            KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
            KeyCode::Enter => self.attach_selected(),
            _ => {}
        }
    }

    /// Lens overlay keys, same directions as the pane view: k/Up
    /// scrolls toward older lines (deep-fetching past the held top),
    /// j/Down toward newer, G jumps back to the tail, g the oldest
    /// held line, Esc closes. Anything else is swallowed so no
    /// navigation or attach input fires under the reading view.
    pub(crate) fn handle_lens_key(&mut self, key: KeyEvent) {
        let len = self.pane_scrollback_lines().len();
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('i') => {
                self.lens.close();
                self.status = "lens closed".to_string();
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.scroll_lens_up(1);
            }
            KeyCode::Char('j') | KeyCode::Down => self.lens.scroll_down(1, len),
            KeyCode::PageDown => {
                self.lens.scroll_down(10, len);
            }
            KeyCode::PageUp => {
                self.scroll_lens_up(10);
            }
            KeyCode::Char('G') | KeyCode::End => self.lens.scroll_down(usize::MAX, len),
            KeyCode::Char('g') | KeyCode::Home => {
                self.scroll_lens_up(len);
            }
            _ => {}
        }
    }

    /// Scroll the lens up, deep-fetching older scrollback when the
    /// offset reaches the held top, then re-observing the grown buffer
    /// so the unread hint keeps tracking.
    pub(crate) fn scroll_lens_up(&mut self, delta: usize) {
        let mut remaining = delta;
        loop {
            let len = self.pane_scrollback_lines().len();
            let max = len.saturating_sub(1);
            let target = self.lens.scroll_up.saturating_add(remaining);
            if target <= max {
                self.lens.scroll_up(remaining, len);
                self.lens.observe_len(len);
                return;
            }
            let advance = max.saturating_sub(self.lens.scroll_up);
            self.lens.scroll_up(advance, len);
            remaining = remaining.saturating_sub(advance);
            if self.deepen_pane_history() == 0 {
                self.lens.observe_len(len);
                return;
            }
        }
    }

    pub(crate) fn handle_attach_key(&mut self, key: KeyEvent) {
        // Menu keys (Ctrl+B) never reach this handler while the prefix
        // owns them: the feed in `handle_key` consumes them first. With
        // terminal_prefix_passthrough on, Ctrl+B skips that feed and the
        // generic key_to_terminal_bytes path below forwards it to the
        // PTY (0x02, readline backward-char / tmux prefix).
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('g') {
            self.mode = TuiMode::Navigate;
            self.status = "detached".to_string();
            // The detach acknowledges whatever killed the pane: a
            // drain error holds the footer for STATUS_HOLD, so it
            // would otherwise outrank "detached" until the hold lapses.
            self.error = None;
            return;
        }
        let Some(terminal_id) = self.view_terminal_id().map(str::to_string) else {
            self.mode = TuiMode::Navigate;
            self.error = Some("selected pane has no terminal".to_string());
            return;
        };
        if let Some(bytes) = key_to_terminal_bytes(key) {
            let (attach_cols, attach_rows) = self.attach_viewport();
            match self
                .client
                .attach_terminal(&terminal_id, attach_cols, attach_rows)
            {
                Ok(mut terminal) => {
                    let send = terminal.send_input(&bytes).and_then(|_| terminal.detach());
                    self.record_attach_send_result(send);
                    self.refresh_tail();
                }
                Err(err) => self.error = Some(err.to_string()),
            }
        }
    }

    /// Coverage is off because the send error arm has no deterministic
    /// fixture: the send chain is two back-to-back writes with no read
    /// in between, so a fixture can only drop the peer before the
    /// AttachTerminal write (EPIPE lands inside attach_terminal, the
    /// outer Err arm) or after it (both Input and Detach beat the close
    /// propagation and succeed). No drop point between the client's two
    /// write calls exists; the window is inside one function body, not
    /// observable from another thread. The success arm runs on every
    /// send-input path.
    #[cfg_attr(coverage, coverage(off))]
    pub(crate) fn record_attach_send_result(
        &mut self,
        send: Result<(), crate::backend_client::BackendClientError>,
    ) {
        match send {
            Ok(()) => self.status = "sent input".to_string(),
            Err(err) => self.report_attach_send_error(err),
        }
    }

    /// Coverage is off because the send error arm has no deterministic
    /// fixture (see the coverage note at the call site): the window
    /// between the two back-to-back writes lives inside one function
    /// body, not observable from another thread.
    #[cfg_attr(coverage, coverage(off))]
    pub(crate) fn report_attach_send_error(
        &mut self,
        err: crate::backend_client::BackendClientError,
    ) {
        self.error = Some(err.to_string());
    }

    pub(crate) fn attach_selected(&mut self) {
        if self.view_terminal_id().is_some() {
            self.mode = TuiMode::Attach;
            // Entering the terminal is like the desktop focus change:
            // a stale armed prefix would let the next plain key fire a
            // chord, violating the passthrough expectation.
            self.prefix.cancel();
            // Truthful attach hint: with passthrough on, Ctrl+B is no
            // longer a shortcut entry while attached, so the hint says
            // so instead of teaching a dead key.
            self.status = if self.terminal_prefix_passthrough {
                "attach mode: Ctrl-G detach · Ctrl+B goes to the shell".to_string()
            } else {
                "attach mode: Ctrl-G detach".to_string()
            };
            self.refresh_tail();
            let (cols, rows) = self.attach_viewport();
            self.load_selected_terminal_history(cols, rows);
        } else {
            self.error = Some("no terminal selected".to_string());
        }
    }

    pub(crate) fn toggle_sidebar_focus(&mut self) {
        self.sidebar_focus = match self.sidebar_focus {
            SidebarFocus::Workspaces => SidebarFocus::Agents,
            SidebarFocus::Agents => SidebarFocus::Workspaces,
        };
    }
}
