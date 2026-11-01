//! Session manager overlay (webui session manager parity).
//!
//! The webui's session manager is an HTTP surface (`/api/sessions`,
//! `/api/session/launch|close|cleanup`): the backend socket dispatch has
//! no session.launch/close/cleanup methods, so every action here goes
//! through [`crate::tui::web_api::WebApiClient`] like the webui does.
//! Switching rebuilds `TuiApp::client` on the target session's sockets
//! (built-in rows through `builtin_session`, external rows from the
//! listed api_socket path) and resets the view state, mirroring the
//! webui `switchSession` teardown (`state.ws/pane/terminalId` cleared,
//! terminal destroyed, then a full refresh).

use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::tui::model::TuiSessionRow;
use crate::tui::{PromptInput, PromptKind, TuiApp, TuiMode};

use super::workspace::WorkspaceResult;

impl TuiApp {
    /// Open the session manager overlay (prefix Shift+P, webui session
    /// manager surface). The row list reloads on every open: running
    /// flags go stale between visits, and the webui fetches the list
    /// every time the surface mounts.
    pub(crate) fn open_session_manager(&mut self) {
        self.refresh_session_rows();
        if self.mode != TuiMode::SessionManager {
            self.open_overlay(TuiMode::SessionManager);
        }
    }

    /// Fetch `/api/sessions` into `session_rows`. Without the WebUI
    /// server the overlay still opens with the load error shown in
    /// place of rows (the desktop surface stays usable for local
    /// navigation when its own fetch fails the same way).
    pub(crate) fn refresh_session_rows(&mut self) {
        match self.web_api.sessions_list() {
            Ok(value) => {
                self.session_rows = TuiSessionRow::list_from_response(&value);
                self.session_load_error = None;
                if self.session_selected >= self.session_rows.len() {
                    self.session_selected = self.session_rows.len().saturating_sub(1);
                }
            }
            Err(err) => {
                self.session_rows.clear();
                self.session_selected = 0;
                self.session_load_error = Some(err.to_string());
            }
        }
    }

    /// Keys inside the session manager overlay. j/k or arrows move,
    /// Enter targets the selected session, `l` launches, `x` closes,
    /// `c` cleans up stale built-in slots, `n` opens the create prompt,
    /// `r` reloads the list, Esc closes (webui surface actions).
    pub(crate) fn handle_session_manager_key(&mut self, key: KeyEvent) {
        let len = self.session_rows.len();
        match key.code {
            KeyCode::Esc => self.close_overlay(),
            KeyCode::Down if len > 0 => {
                self.session_selected = (self.session_selected + 1) % len;
            }
            KeyCode::Up if len > 0 => {
                self.session_selected = (self.session_selected + len.saturating_sub(1)) % len;
            }
            KeyCode::Char('j') if len > 0 => {
                self.session_selected = (self.session_selected + 1) % len;
            }
            KeyCode::Char('k') if len > 0 => {
                self.session_selected = (self.session_selected + len.saturating_sub(1)) % len;
            }
            KeyCode::Enter if len > 0 => match self.session_target_row() {
                Some(row) => {
                    let result = self.session_target(&row.name, &row.backend);
                    self.workspace_status(result);
                }
                None => self.status = "no session selected".to_string(),
            },
            // `l` launches (webui "New Herdr"/revive flow): the server
            // starts the backend if needed, then the row targets it.
            KeyCode::Char('l') if len > 0 => match self.session_target_row() {
                Some(row) => {
                    let result = self.session_launch_and_target(&row.name, &row.backend);
                    self.workspace_status(result);
                }
                None => self.status = "no session selected".to_string(),
            },
            // `x` closes the selected session's backend. Closing the
            // session the client is pointed at is allowed: the webui
            // closes its current session too, and the next refresh
            // just fails against the dead socket (status shows it).
            KeyCode::Char('x') if len > 0 => match self.session_target_row() {
                Some(row) => {
                    let result = self.session_close(&row.name, &row.backend);
                    self.workspace_status(result);
                }
                None => self.status = "no session selected".to_string(),
            },
            // `c` removes stale built-in slots (webui "Clean up closed
            // sessions"): the server only deletes sessions whose socket
            // probe fails and keeps `default` plus live handles.
            KeyCode::Char('c') => {
                let result = self.session_cleanup();
                self.workspace_status(result);
            }
            // `n` opens the create prompt; Enter there launches the
            // typed name as a built-in session and targets it (webui
            // "New built-in" input).
            KeyCode::Char('n') => {
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateSession));
                self.status = PromptKind::CreateSession.title().to_string();
            }
            KeyCode::Char('r') => {
                self.refresh_session_rows();
                self.status = format!("sessions reloaded ({} rows)", self.session_rows.len());
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.refresh_session_rows();
                self.status = format!("sessions reloaded ({} rows)", self.session_rows.len());
            }
            _ => {}
        }
        self.mark_dirty();
    }

    fn session_target_row(&self) -> Option<TuiSessionRow> {
        self.session_rows.get(self.session_selected).cloned()
    }

    /// Target the selected session without launching it: the row's
    /// recorded sockets are used as-is. This is the tap-to-switch of
    /// the webui (a running session switches, an offline one can be
    /// closed but targeting it fails the next refresh with the dead
    /// socket error, same as the webui targeting an offline session).
    pub(crate) fn session_target(&mut self, name: &str, backend: &str) -> WorkspaceResult {
        let Some(row) = self
            .session_rows
            .iter()
            .find(|row| row.name == name && row.backend == backend)
            .cloned()
        else {
            return Err("session no longer listed".to_string());
        };
        if !row.running {
            return Err(format!(
                "{} is offline (l launches it)",
                session_display_name(name)
            ));
        }
        self.retarget_session(name, backend, &row.api_socket)
    }

    /// Launch (or revive) the selected session, then target it. Webui
    /// `newSession`/retry flow: `POST /api/session/launch` starts the
    /// backend, then the browser retargets and refreshes.
    pub(crate) fn session_launch_and_target(
        &mut self,
        name: &str,
        backend: &str,
    ) -> WorkspaceResult {
        let launched = self
            .web_api
            .session_launch(name, backend)
            .map_err(|err| err.to_string())?;
        let ok = launched
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !ok {
            let message = launched
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("launch failed");
            return Err(message.to_string());
        }
        let api_socket = self
            .session_rows
            .iter()
            .find(|row| row.name == name && row.backend == backend)
            .map(|row| row.api_socket.clone())
            .unwrap_or_default();
        self.retarget_session(name, backend, &api_socket)
    }

    /// Stop the selected session's backend. `POST /api/session/close`
    /// is idempotent (an already-stopped target answers success).
    /// Closing the current session keeps the client pointed at the
    /// dead socket: the next refresh reports it, the same dead-target
    /// behavior the webui accepts after its own close flow.
    pub(crate) fn session_close(&mut self, name: &str, backend: &str) -> WorkspaceResult {
        let closed = self
            .web_api
            .session_close(name, backend)
            .map_err(|err| err.to_string())?;
        let ok = closed
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        self.refresh_session_rows();
        if !ok {
            let message = closed
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("close failed");
            return Err(message.to_string());
        }
        Ok(format!(
            "session {} closed (backend {})",
            session_display_name(name),
            backend
        ))
    }

    /// Remove stale built-in session slots. `POST /api/session/cleanup`
    /// keeps `default` and live handles; the response names what went.
    pub(crate) fn session_cleanup(&mut self) -> WorkspaceResult {
        let cleaned = self
            .web_api
            .session_cleanup()
            .map_err(|err| err.to_string())?;
        let removed = cleaned
            .get("removed_count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        self.refresh_session_rows();
        if removed == 0 {
            return Ok("no stale built-in sessions".to_string());
        }
        Ok(format!(
            "removed {removed} closed session{}",
            if removed == 1 { "" } else { "s" }
        ))
    }

    /// Point the app at `session`'s sockets and reset the view state.
    ///
    /// Built-in rows rebuild the client with
    /// [`crate::backend_client::BackendClient::builtin_session`] so a
    /// launched session gets the canonical socket pair even when the
    /// listed `api_socket` came from a stale listing. External rows
    /// use the listed sockets directly (the `sessions/<name>` layout
    /// is exactly what `api_socket_path_for` produces server-side).
    /// The view resets mirror the webui `switchSession` teardown: the
    /// old snapshot/panes describe the previous session, so selection,
    /// tail, lens, and per-pane buffers all start over.
    fn retarget_session(&mut self, name: &str, backend: &str, api_socket: &str) -> WorkspaceResult {
        if name == self.current_session && backend == self.current_backend {
            return Ok("already targeting this session".to_string());
        }
        let client = if backend == "builtin" {
            crate::backend_client::BackendClient::builtin_session(if name == "default" {
                None
            } else {
                Some(name)
            })
        } else {
            let api = PathBuf::from(api_socket);
            let terminal = api
                .parent()
                .map(|dir| dir.join("herdr-client.sock"))
                .unwrap_or_else(|| api.clone());
            crate::backend_client::BackendClient::new(api, terminal)
        };
        self.client = client;
        self.current_session = name.to_string();
        self.current_backend = backend.to_string();
        // Webui switchSession teardown: everything bound to the old
        // session's panes dies with it.
        self.snapshot = Default::default();
        self.selected_workspace = 0;
        self.selected_agent = 0;
        self.pane_scroll = 0;
        self.pane_history.clear();
        self.pane_history_exhausted = false;
        self.pane_tail.clear();
        self.pane_tail_styles.clear();
        self.pane_buffers_pane_id = None;
        self.lens.close();
        self.mode = TuiMode::Navigate;
        self.overlay_stack.clear();
        self.last_refresh = None;
        self.refresh_inflight = None;
        self.session_generation = self.session_generation.wrapping_add(1);
        self.refresh().map_err(|err| err.to_string())?;
        Ok(format!(
            "switched to session {} (backend {})",
            session_display_name(name),
            backend
        ))
    }
}

fn session_display_name(name: &str) -> &str {
    if name.is_empty() {
        "default"
    } else {
        name
    }
}
