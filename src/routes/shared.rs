//! Cross-module plumbing for the route handlers: `use super::shared::*`
//! in each routes file restores the flat main.rs namespace the moved
//! code was written against.

#![allow(unused_imports)]
pub(crate) use crate::{
    api_for_headers, api_for_headers_ensured, api_for_query_session_ensured,
    api_for_query_session_routed, api_for_target_session, backend_target_enabled,
    backend_target_for_headers, backend_target_for_query, begin_temporary_tab_promote,
    builtin_session_dir, builtin_socket_paths, canonical_session_name,
    client_socket_for_query_session, default_backend_target, detect_herdr_install,
    finish_temporary_tab_promote, home_folder_path, known_builtin_sessions,
    known_external_sessions, known_sessions, read_json_line, register_worktree_list_cache,
    requested_session_from_headers, require_auth, session_display_name, session_from_headers,
    start_no_sleep_guard, unix_ms_now, workspace_panes_store, worktree_cache_invalidated,
    ApiClient, BackendCompatibility, GraphicsBridgePayload, HerdrWorktreeApi, NoSleepState,
    PromotedTemporaryTabs, SessionBackendTarget, SessionQuery, TerminalGraphicsEvent,
    TerminalQuery, TlsMode, WebState, WorkspaceQuery, MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE,
    MIN_SUPPORTED_PROTOCOL_VERSION, PANE_PROMPT_TAIL_LINES, WORKTREE_LIST_CACHES,
};

pub(crate) use super::auth::{authorized, login, logout, me, persist_session_token};
pub(crate) use super::panes::{
    pane_conversation, pane_conversation_image, pane_prompt, pane_tool_output, promote_tab,
    submit_pane,
};
pub(crate) use super::session::{
    action_backend, action_session, cleanup_sessions, close_session, ensure_builtin_session,
    launch_session, proxy_request_async, proxy_server_stop, sessions, versions,
};
pub(crate) use super::settings::{
    no_sleep, persist_server_settings, server_settings, sync_auto_no_sleep,
    sync_auto_no_sleep_from_agents, update_no_sleep, update_server_settings,
};
pub(crate) use super::workspace::{
    agents, clear_recent_workspaces, close_pane, close_tab, close_workspace, create_tab,
    create_workspace, enrich_session_snapshot, enrich_workspace_cwds, existing_workspace_cwd,
    expand_user_path_string, filter_snapshot_rows_by_workspace, git_branches, list_git_branches,
    pane_layout, panes, push_recent_workspace, recent_workspaces, record_recent_workspace,
    record_recent_workspace_endpoint, remove_recent_workspace, remove_worktree, rename_tab,
    rename_workspace, session_snapshot, set_workspace_order, snapshot_counts_by_workspace, tabs,
    unix_now_seconds, workspace_order, workspace_order_key, workspaces, OpenRecentWorkspaceRequest,
};
pub(crate) use super::worktree::{
    create_worktree, create_worktree_checkout, fetch_worktree_results_by_cwd, git_branch_exists,
    git_failure, invalidate_registered_worktree_caches, latest_worktree_commit,
    open_created_worktree_request, open_recent_workspace, open_worktree, pull_base_branch,
    remove_worktree_path, run_git_capture, same_checkout_path, stamp_workspace_worktrees,
    worktrees,
};
pub(crate) use super::ws::{
    base64_encode, cols_of, connect_terminal_graphics_shell, events_ws, graphics_bridge_payload,
    rows_of, should_auto_close_temporary_tab, terminal_graphics_text_messages,
    terminal_graphics_ws, terminal_release_toggle, terminal_text_messages, terminal_ws,
    web_event_kind,
};
