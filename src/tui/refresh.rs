//! Background refresh and stamp-fetch plumbing for TuiApp.

use super::*;

impl TuiApp {
    pub fn refresh(&mut self) -> Result<(), BackendClientError> {
        let ping = self.client.ping()?;
        let snapshot = self.client.snapshot()?;
        self.apply_refresh(ping, snapshot);
        Ok(())
    }

    pub fn refresh_if_due(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        self.poll_refresh();
        let due = self
            .last_refresh
            .map(|loaded| loaded.elapsed() >= self.refresh_interval)
            .unwrap_or(true);
        if due && self.refresh_inflight.is_none() {
            self.spawn_refresh();
        } else if !due {
            // Live preview while not attached (ux fix): the tail used to
            // refresh only with the snapshot cadence (default 1s), so the
            // pane preview looked frozen compared to the webui terminal.
            // The tail read is a single pane.read round-trip, cheap enough
            // to poll 5x faster than the snapshot; attach mode owns the
            // screen through the live pty instead, and the tail is also
            // skipped while a modal/prompt would fight the redraw.
            let tail_due = self
                .last_tail_refresh
                .map(|loaded| loaded.elapsed() >= TAIL_REFRESH_INTERVAL)
                .unwrap_or(true);
            if tail_due && self.mode != TuiMode::Attach && self.screen == TuiScreen::Terminal {
                self.refresh_tail();
                self.refresh_tile_tails();
                self.last_tail_refresh = Some(Instant::now());
            }
        }
        self.poll_tile_tails();
    }

    /// Start the ping+snapshot round-trip off-loop. The old inline call
    /// froze the whole event loop for the full backend timeout when the
    /// backend went silent — no redraws, no keys — and the footer could
    /// not say anything about it. A short-lived worker keeps the loop
    /// alive; the reply lands in `poll_refresh` on a later tick.
    pub(crate) fn spawn_refresh(&mut self) {
        let client = self.client.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = client
                .ping()
                .and_then(|ping| client.snapshot().map(|snapshot| (ping, snapshot)));
            let _ = tx.send(result);
        });
        self.refresh_inflight = Some(RefreshInflight {
            started: Instant::now(),
            receiver: rx,
        });
    }

    /// Non-blocking drain of a pending refresh worker. One round-trip
    /// per worker; the next `refresh_if_due` re-arms only after a reply
    /// (or error) lands, so a dead backend costs one worker per refresh
    /// interval, not per tick.
    pub(crate) fn poll_refresh(&mut self) {
        self.poll_stamp_fetches();
        let Some(inflight) = self.refresh_inflight.take() else {
            return;
        };
        match inflight.receiver.try_recv() {
            Ok(Ok((ping, snapshot))) => self.apply_refresh(ping, snapshot),
            Ok(Err(err)) => {
                self.error = Some(err.to_string());
                self.last_refresh = Some(Instant::now());
                self.refresh_inflight = None;
                self.mark_dirty();
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                // Still waiting: keep the worker, keep the footer spinner
                // fed. The bin loop redraws every 100ms unconditionally,
                // so no extra wake-up source is needed.
                self.refresh_inflight = Some(inflight);
                self.mark_dirty();
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {}
        }
    }

    /// Commit a finished round-trip. Split from the blocking `refresh`
    /// (key/shortcut actions still want the synchronous path) so the two
    /// cannot drift apart on the post-processing steps.
    pub(crate) fn apply_refresh(&mut self, ping: Value, snapshot: Value) {
        let first_refresh = self.last_refresh.is_none();
        self.snapshot = TuiSnapshot::from_backend_response(&snapshot);
        if first_refresh {
            self.select_focused_items();
        }
        self.clamp_selection();
        self.sync_split_tree();
        if self.mode != TuiMode::Attach {
            self.refresh_tail();
            self.last_tail_refresh = Some(Instant::now());
        }
        // The backend summary is idle-state chrome: an action that
        // just reported its outcome owns the line for STATUS_HOLD.
        if !self
            .status_hold_until
            .is_some_and(|deadline| Instant::now() < deadline)
        {
            self.status_hold_until = None;
            self.status = format!(
                "backend {} · protocol {} · {} workspaces · {} agents",
                value_str(&ping, &["version"]).unwrap_or("built-in"),
                value_u64(&ping, &["protocol"]).unwrap_or_default(),
                self.snapshot.workspaces.len(),
                self.snapshot.agents.len(),
            );
        }
        // A terminal-drain error keeps the line for the same
        // STATUS_HOLD the status notice uses: refreshes must not wipe
        // why a pane dropped before the user reads it. Any other error
        // (stale validation, a failed action the user just retried)
        // stays clearable by a healthy refresh.
        if !self
            .status_hold_until
            .is_some_and(|deadline| Instant::now() < deadline)
            || self.error.is_none()
        {
            self.error = None;
        }
        self.last_refresh = Some(Instant::now());
        // Worktree identity for the new rows: serve fresh cached
        // replies first (no round trip), then arm a fetch per cwd the
        // cache cannot answer. Backend-stamped rows (external session)
        // are left verbatim.
        self.apply_cached_stamps();
        self.spawn_stamp_fetches();
        self.mark_dirty();
    }

    /// Non-blocking drain of every armed `worktree.list` worker. A
    /// reply (or worker death) is committed the moment it lands, so
    /// stamps update mid-interval instead of waiting for the next
    /// snapshot refresh to find the reply.
    pub(crate) fn poll_stamp_fetches(&mut self) {
        if self.stamp_inflight.is_empty() {
            return;
        }
        let workers = std::mem::take(&mut self.stamp_inflight);
        let mut armed: Vec<StampInflight> = Vec::with_capacity(workers.len());
        for worker in workers {
            match worker.receiver.try_recv() {
                Ok(Ok(response)) => {
                    self.commit_stamp(&worker.cwd, response);
                }
                Ok(Err(_)) => {
                    // A failed fetch keeps the previous stamp and stays
                    // quiet: worktree identity is secondary data, it
                    // self-heals on the next refresh, and a recurring
                    // failure must not overwrite primary status text.
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => armed.push(worker),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    // Worker died without a reply. Drop it silently, the
                    // same policy as a dead snapshot worker: not an
                    // error the user can act on.
                }
            }
            self.mark_dirty();
        }
        self.stamp_inflight = armed;
    }

    /// Serve the freshest cached `worktree.list` reply for each
    /// unstamped workspace. Rows that arrive already stamped by the
    /// backend (external client sessions) keep their stamp: the
    /// backend knows better than a cache snapshot.
    pub(crate) fn apply_cached_stamps(&mut self) {
        if self.stamp_cache.is_empty() {
            return;
        }
        for workspace in &mut self.snapshot.workspaces {
            if workspace.worktree.is_some() {
                continue;
            }
            let Some(entry) = self.stamp_cache.get(&workspace.cwd) else {
                continue;
            };
            if entry.fetched_at.elapsed() > STAMP_CACHE_TTL {
                continue;
            }
            let Some(stamp) = parse_worktree_list_response(&entry.response, &workspace.cwd) else {
                continue;
            };
            workspace.worktree = Some(stamp);
        }
    }

    /// Arm one `worktree.list` fetch per workspace cwd that has no
    /// fresh cache entry. One worker per cwd per refresh round; the
    /// next round re-arms only after this one lands.
    pub(crate) fn spawn_stamp_fetches(&mut self) {
        for workspace in &self.snapshot.workspaces {
            let cwd = workspace.cwd.clone();
            if cwd.is_empty() {
                continue;
            }
            if workspace.worktree.is_some() {
                continue;
            }
            if let Some(entry) = self.stamp_cache.get(&cwd) {
                if entry.fetched_at.elapsed() <= STAMP_CACHE_TTL {
                    continue;
                }
            }
            if self.stamp_inflight.iter().any(|w| w.cwd == cwd) {
                continue;
            }
            let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BackendClientError>>();
            let client = self.client.clone();
            let fetch_cwd = cwd.clone();
            std::thread::spawn(move || {
                let _ = tx.send(client.list_worktrees(Some(&fetch_cwd)));
            });
            self.stamp_inflight
                .push(StampInflight { cwd, receiver: rx });
        }
    }

    /// Land a `worktree.list` reply: cache it for the TTL, then stamp
    /// every workspace at the asking cwd right away so the badge
    /// renders this frame instead of waiting for the next snapshot
    /// refresh to replay the cache.
    pub(crate) fn commit_stamp(&mut self, cwd: &str, response: Value) {
        let stamp = parse_worktree_list_response(&response, cwd);
        self.stamp_cache.insert(
            cwd.to_string(),
            StampCacheEntry {
                fetched_at: Instant::now(),
                response,
            },
        );
        let Some(stamp) = stamp else {
            return;
        };
        for workspace in &mut self.snapshot.workspaces {
            if workspace.cwd == cwd && workspace.worktree.is_none() {
                workspace.worktree = Some(stamp.clone());
            }
        }
    }

    /// Drop the cached `worktree.list` reply for a cwd whose repo state
    /// just changed out of band (branch switch through the picker or the
    /// git panel). The cached stamp names the pre-switch branch, so the
    /// badge would answer with the old HEAD for the rest of the TTL.
    pub(crate) fn invalidate_stamp(&mut self, cwd: &str) {
        self.stamp_cache.remove(cwd);
        for workspace in &mut self.snapshot.workspaces {
            if workspace.cwd == cwd {
                workspace.worktree = None;
            }
        }
    }

    pub fn refresh_tail(&mut self) {
        // Lens gate (design section 6): the overlay must not survive a
        // pane switch onto a pane without a transcript provider — same
        // force-off the webui applies when the switch disappears.
        // Runs before the early returns so every navigation path is
        // covered, not just the successful read.
        if self.lens.active && self.lens_chat_supported() != LensGate::Supported {
            self.lens.close();
            self.status = "lens closed (pane has no transcript provider)".to_string();
        }
        let Some(pane_id) = self.view_pane_id() else {
            self.pane_tail.clear();
            self.pane_tail_styles.clear();
            self.pane_scroll = 0;
            self.pane_history.clear();
            self.pane_history_exhausted = false;
            self.pane_buffers_pane_id = None;
            self.reset_terminal_output_buffer();
            return;
        };
        if self.pane_buffers_pane_id.as_deref() != Some(pane_id.as_str()) {
            // Pane switch: the old scroll offset and deep history
            // describe another pane's output, so both start over.
            self.pane_scroll = 0;
            self.pane_history.clear();
            self.pane_history_exhausted = false;
            self.pane_buffers_pane_id = Some(pane_id.clone());
        }
        match self.client.read_pane_screen(&pane_id) {
            Ok(value) => {
                let text = value
                    .get("read")
                    .and_then(|read| read.get("text"))
                    .and_then(Value::as_str)
                    .or_else(|| value.get("text").and_then(Value::as_str))
                    .unwrap_or("");
                self.reset_terminal_output_buffer();
                self.set_pane_tail_from_text(&strip_ansi_lossy(text));
                // The lens reads the tail: feed it the new length so the
                // unread hint tracks new output while scrolled up.
                self.lens.observe_len(self.pane_tail.len());
                self.mark_dirty();
            }
            Err(err) => {
                self.error = Some(err.to_string());
                self.mark_dirty();
            }
        }
    }

    pub(crate) fn reset_terminal_output_buffer(&mut self) {
        self.terminal_raw_output.clear();
        self.terminal_raw_terminal_id = None;
    }

    /// Fetch the tail of every visible non-focused tile. The focused
    /// tile keeps the full `refresh_tail` pipeline (styles, scroll,
    /// deep history); the rest get plain text at the same cadence, one
    /// `pane.read` per tile. Entries for panes that left the tree are
    /// dropped so the cache never outlives its tiles. Fetches run on a
    /// short-lived worker per tick (same pattern as `spawn_refresh`):
    /// a dead backend must not freeze keys and redraws.
    pub(crate) fn refresh_tile_tails(&mut self) {
        let focused = self.focused_pane_id();
        let visible: Vec<String> = self
            .split_tree
            .leaves()
            .into_iter()
            .filter(|id| Some(*id) != focused.as_deref())
            .map(|id| id.to_string())
            .collect();
        self.tile_tails.retain(|id, _| visible.contains(id));
        if visible.is_empty() {
            return;
        }
        // One worker per tick fetches every tile tail and ships the
        // whole batch back; the next tick drains it. A worker still
        // running means no new spawn until it lands (same re-arm rule
        // as `spawn_refresh`).
        if self.tile_tail_rx.is_some() {
            return;
        }
        let client = self.client.clone();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<(String, String)>>();
        std::thread::spawn(move || {
            let mut tails = Vec::with_capacity(visible.len());
            for pane_id in &visible {
                let text = client
                    .read_pane_screen(pane_id)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("read")
                            .and_then(|read| read.get("text"))
                            .and_then(Value::as_str)
                            .or_else(|| value.get("text").and_then(Value::as_str))
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                tails.push((pane_id.clone(), text));
            }
            let _ = tx.send(tails);
        });
        self.tile_tail_rx = Some(rx);
    }

    /// Drain a finished tile-tail worker into the cache. Called from
    /// the tick; `Empty` keeps the receiver for the next tick, a dead
    /// worker clears it so the next refresh can spawn a new one. A
    /// failed fetch keeps the previous tail (a missing tile shows its
    /// last content, not a blank).
    pub(crate) fn poll_tile_tails(&mut self) {
        let Some(rx) = self.tile_tail_rx.take() else {
            return;
        };
        match rx.try_recv() {
            Ok(tails) => {
                for (pane_id, text) in tails {
                    self.tile_tails.insert(pane_id, text);
                }
                self.mark_dirty();
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                self.tile_tail_rx = Some(rx);
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {}
        }
    }
}
