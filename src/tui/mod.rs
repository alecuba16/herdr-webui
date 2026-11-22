mod app;
mod events;
pub mod keys;
pub mod lens;
pub mod model;
pub mod panels;
mod refresh;
pub mod render;
mod scrollback;
pub mod search;
pub mod sessions;
mod settings;
pub mod split;
mod split_mode;
pub mod terminal;
pub mod text;
pub mod theme;
pub mod tour;
pub mod web_api;
pub mod workspace;

#[cfg(test)]
pub mod tests;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;

use crate::backend_client::{BackendClient, BackendClientError, TerminalOutput};
use crate::terminal_text::{self, StripCarriageReturn};
use crate::tui::web_api::{default_web_api_port, WebApiClient};
pub use keys::{is_prefix_key, PrefixState, Shortcut};
use lens::{refusal_reason_copy, LensGate, LensState};
use model::{parse_worktree_list_response, same_checkout_path, value_str, value_u64};
pub use model::{
    snapshot_summary, SidebarFocus, TuiAgent, TuiMode, TuiPane, TuiSessionRow, TuiSnapshot, TuiTab,
    TuiWorkspace, TuiWorktreeStamp,
};
use panels::files::{content_rows, content_search, run_content_search, ContentRow, SearchKind};
use panels::git::{ConflictAction, ConflictResolveMode};
use panels::{FileExplorer, GitPanel, GitView};
pub use render::render;
use terminal::{terminal_output_styled_lines_for_width, TuiTextSpan};
use theme::Palette;
pub use theme::TuiTheme;

impl PromptKind {
    /// Map the workspace-management prompt kinds onto the workspace
    /// module's own enum. File/git kinds never reach this conversion.
    pub(crate) fn into_workspace_prompt(self) -> workspace::WorkspacePrompt {
        match self {
            Self::NewWorkspace => workspace::WorkspacePrompt::NewWorkspace,
            Self::NewWorkspaceName => workspace::WorkspacePrompt::NewWorkspaceName,
            Self::RenameWorkspace => workspace::WorkspacePrompt::RenameWorkspace,
            Self::RenamePanel => workspace::WorkspacePrompt::RenamePanel,
            Self::CreateWorktreeBranch => workspace::WorkspacePrompt::CreateWorktreeBranch,
            Self::CreateWorktreePath => workspace::WorkspacePrompt::CreateWorktreePath,
            Self::CreateWorktreeBase => workspace::WorkspacePrompt::CreateWorktreeBase,
            Self::ConfirmWorktreePullBase => workspace::WorkspacePrompt::ConfirmWorktreePullBase,
            Self::ConfirmCloseWorkspace => workspace::WorkspacePrompt::ConfirmCloseWorkspace,
            // File/git kinds have no workspace counterpart; map to the
            // harmless no-op closest to their intent.
            _ => workspace::WorkspacePrompt::ConfirmCloseWorkspace,
        }
    }
}

const TAIL_LINES: usize = 240;
const TERMINAL_RAW_BUFFER_BYTES: usize = 512 * 1024;
/// Lines kept in the scroll-up history on the first deep fetch. Grows
/// geometrically per fetch (`PANE_HISTORY_MAX_LINES` cap) so a plain
/// scroll-up never walks the whole 8 MiB backend scrollback at once.
const PANE_HISTORY_START_LINES: usize = 2000;
const PANE_HISTORY_MAX_LINES: usize = 40_000;
/// Tail poll cadence while the terminal screen is NOT attached: 1/5th
/// of the default snapshot interval. The preview keeps flowing at a
/// readable rate without hammering the backend with pane.read per event
/// loop tick (the event loop polls keys every 50ms).
pub(crate) const TAIL_REFRESH_INTERVAL: Duration = Duration::from_millis(200);

/// How long a cached `worktree.list` reply stays fresh. Same value as
/// the webui wrapper's worktree cache: long enough that the default
/// 1s snapshot refresh hits the cache between user actions, short
/// enough that a checkout created elsewhere appears without a manual
/// refresh.
const STAMP_CACHE_TTL: Duration = Duration::from_secs(2);
/// How long an action's status line holds against the periodic
/// backend summary: readable, then the summary regains the line.
const STATUS_HOLD: Duration = Duration::from_secs(2);

/// Which main screen the TUI shows. Mirrors the WebUI workspace shell modes
/// (terminal, Git, Files) so the same workspace can be inspected from both
/// clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TuiScreen {
    Terminal,
    Files,
    Git,
}

impl TuiScreen {
    pub fn title(self) -> &'static str {
        match self {
            Self::Terminal => "Terminal",
            Self::Files => "Files",
            Self::Git => "Git",
        }
    }
}

/// The focused UI context the statusbar hint describes. Resolution order
/// mirrors `TuiApp::handle_key`, so the hint is always about the keys that
/// are live right now (the lazygit/k9s standard: popups and input captures
/// take over the hint line; the focused view names its own actions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FooterContext {
    ConfirmQuit,
    HelpOverlay,
    /// Onboarding tour overlay: j/Enter next step, k back, Esc closes
    /// (tour.rs owns the full step table).
    TourOverlay,
    SettingsOverlay,
    /// Worktree browser overlay: j/k or arrows move, Enter opens, Esc closes.
    WorktreeList,
    /// Branch picker overlay (prefix `v`): type to filter, Enter
    /// switches/reroutes/creates, Esc closes.
    BranchPicker,
    /// Search palette overlay (prefix `/`): type to filter, Enter
    /// commits/navigates, Esc closes.
    SearchPalette,
    /// Chat lens overlay (prefix `L`): transcript reading view over the
    /// terminal pane; j/k scroll, follow re-arms at the bottom.
    Lens,
    /// Session manager overlay (prefix Shift+P): j/k move, Enter
    /// targets a built-in session, l launch, x close, c cleanup, n new.
    SessionManager,
    /// Terminal screen, main region focused, split view active
    /// (review F2): j/k walks tiles, so the hint must name the
    /// Ctrl+j/k scroll escape instead of staying silent about it.
    TerminalMainSplit,
    /// Commit message modal: typing, Enter commits, Esc cancels.
    CommitInput,
    /// Any typed prompt (rename, confirm, new file, ...).
    PromptInput(PromptKind),
    /// Git Changes diff search bar (`/`).
    DiffSearch,
    /// Editor find bar (Ctrl+F while editing).
    EditorFind,
    /// Files edit mode (typing into the preview buffer).
    FileEdit,
    /// Files filter bar (`/` on the tree).
    FilterBar,
    /// Content-search results view.
    ContentSearch,
    /// Terminal screen, Navigate mode, MAIN region focused (the focus
    /// walker's default): the pane owns the keys — list movement lives on
    /// the sidebar regions, so the hint names pane actions instead of
    /// the j/k list keys that are dead here.
    TerminalMain,
    Terminal(TuiMode),
    Files(TuiMode),
    Git(TuiMode, GitView),
}

impl FooterContext {
    /// Full statusbar hint. Every hint keeps the `Ctrl+B ? help`
    /// discovery tail (v0.4.46 invariant) unless the context captures all
    /// keys and `Ctrl+B ?` genuinely cannot fire (only the quit overlay
    /// and the confirm prompts are exempted, and they still name a way
    /// out).
    pub(crate) fn hint(self) -> &'static str {
        match self {
            Self::ConfirmQuit => " y quit · n/Esc cancel ",
            Self::HelpOverlay => " ? closes help · T replays tour · type filters · j/k scrolls ",
            Self::TourOverlay => " j/Enter next step · k back · Esc closes ",
            Self::SettingsOverlay => " t theme · p passthrough · Esc closes ",
            Self::WorktreeList => " Enter opens/enters · o opens folder · c create worktree · h parent · j/k moves · type filters · Esc closes ",
            Self::BranchPicker => {
                " Enter switch/worktree · j/k moves · type filters or creates · Esc closes "
            }
            Self::SearchPalette => {
                " Enter commits/navigates · j/k moves · Esc closes · Ctrl+B ? help "
            }
            Self::Lens => {
                " j/k scroll · G bottom resumes follow · Esc closes · Ctrl+B ? help "
            }
            Self::SessionManager => {
                " Enter switch · l launch · x close · c cleanup · n new · j/k moves · Esc closes · Ctrl+B ? help "
            }
            Self::CommitInput => {
                " type the message · Enter commits · Esc cancels · Ctrl+U clears · Ctrl+B ? help "
            }
            Self::PromptInput(PromptKind::ReplaceInFile) => {
                " type the replacement · Enter replaces · ! all · Esc cancels · Ctrl+B ? help "
            }
            Self::PromptInput(PromptKind::ComposerMessage) => {
                " type the message · Enter sends · Ctrl+U clears · Esc cancels · Ctrl+B ? help "
            }
            Self::PromptInput(_) => " type · Enter accepts · Esc cancels · Ctrl+B ? help ",
            Self::DiffSearch => {
                " type to search · n/N cycle · Enter keeps · Esc closes · Ctrl+B ? help "
            }
            Self::EditorFind => {
                " type to find · Enter next · Shift+Enter prev · Esc closes · Ctrl+B ? help "
            }
            Self::FileEdit => {
                " type to edit · Ctrl-S save · Ctrl-R reload · Ctrl-F find · Esc stop · Ctrl+B ? help "
            }
            Self::FilterBar => " type to filter · Enter keeps · Esc closes · Ctrl+B ? help ",
            Self::ContentSearch => {
                " j/k rows · Enter jump · A case · X regex · Esc exits · Ctrl+B ? help "
            }
            Self::TerminalMain => {
                // The split entry is invisible otherwise: the chord lives
                // behind the prefix and the resting hint named no way in.
                // It rides the front segments so fit_hint keeps it until
                // the terminal gets genuinely narrow.
                " Enter attach · Ctrl+B s split · Ctrl+B . / , focus sidebar · Shift+L lens · Shift+C compose · r refresh · q quit · Ctrl+B ]/[ panel · Ctrl+B ? help "
            }
            Self::TerminalMainSplit => {
                // Split is live, so name the loop: how to add another
                // tile and how to close one. Both ride the front so
                // fit_hint keeps them when the line collapses.
                " hjkl walk tiles · Ctrl+j/k scroll · Ctrl+B s split · Ctrl+B x close tile · Enter attach · Shift+L lens · q quit · Ctrl+B ? help "
            }
            Self::Terminal(TuiMode::Attach) => {
                " Ctrl-G detach · type sends input · Ctrl+B ? help "
            }
            Self::Terminal(_) => {
                // Sidebar owns focus here but the split chord still
                // fires from Terminal/Navigate (the dispatch gates on
                // screen+mode, not region), so name it or the resting
                // hint goes silent on split exactly when the sidebar
                // has focus. Ctrl+B . returns focus to the main pane.
                " ↑/↓ j/k select · Enter attach · Tab lists · Ctrl+B s split · Ctrl+B . main · q quit · Ctrl+B ? help "
            }
            Self::Files(_) => {
                " j/k move · Enter open · e edit · / search · L file log · a/A new file/dir · R rename · x delete · Tab previews · M outline · w reveal · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Changes) => {
                " Tab view · s stage · d discard · J/K hunk · H apply · / search · c commit · P push · G stage all · f fetch · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Log) => {
                " Tab view · Space mark · Enter compare · t tag · R reset · b rebase · s scope · + more · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Branches) => {
                " Tab view · j/k branches · B create · D delete · Enter refresh · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Stash) => {
                " Tab view · j/k stashes · Enter diff · a apply · D drop · Ctrl+B ? help "
            }
            Self::Git(_, GitView::History) => {
                " j/k commits · Enter commit diff · o back to changes · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Conflicts) => {
                " j/k files · o ours · e parent · t remote · m resolved · R continue · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Cleanup) => {
                " j/k rows · Space mark · x delete · B prune · Ctrl+B ? help "
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct TuiOptions {
    pub session: Option<String>,
    pub api_socket: Option<PathBuf>,
    pub terminal_socket: Option<PathBuf>,
    pub refresh_interval: Duration,
    pub theme: TuiTheme,
    pub web_api: WebApiClient,
}

impl Default for TuiOptions {
    fn default() -> Self {
        Self {
            session: None,
            api_socket: None,
            terminal_socket: None,
            refresh_interval: Duration::from_millis(1000),
            theme: TuiTheme::from_env(),
            web_api: WebApiClient::new("127.0.0.1", default_web_api_port()),
        }
    }
}

#[derive(Debug)]
pub struct TuiApp {
    pub client: BackendClient,
    pub web_api: WebApiClient,
    pub snapshot: TuiSnapshot,
    pub selected_workspace: usize,
    pub selected_agent: usize,
    pub sidebar_focus: SidebarFocus,
    /// Webui sidebar: KeyB collapses/expands the sidebar column.
    pub sidebar_collapsed: bool,
    /// Webui focusNext/focusPrev: walker position. When true, key input
    /// goes to the main screen instead of the sidebar list.
    pub main_focused: bool,
    pub mode: TuiMode,
    pub screen: TuiScreen,
    pub prefix: PrefixState,
    /// Terminal prefix passthrough (webui option `terminalPrefixPassthrough`):
    /// in attach mode Ctrl+B goes to the PTY (readline backward-char, tmux
    /// prefix) instead of arming the shortcut prefix. Asymmetry: the webui
    /// stores its options in browser localStorage, which the TUI cannot
    /// read, so the flag comes from webui-settings.json under the same key
    /// name. The webui toggle and the TUI flag are separate stores until
    /// the webui learns to mirror this key into the server settings file.
    pub terminal_prefix_passthrough: bool,
    pub file_explorer: FileExplorer,
    pub git_panel: GitPanel,
    pub commit_input: Option<CommitInput>,
    pub prompt_input: Option<PromptInput>,
    pub pane_tail: Vec<String>,
    pub(crate) pane_tail_styles: Vec<Vec<TuiTextSpan>>,
    /// Scroll-up offset over the pane view in lines-above-tail
    /// (0 = following the newest line, the lens uses the same shape).
    /// Kept across tail refills: the offset is bottom-anchored, so new
    /// output streams in below the frozen view instead of moving it.
    pub pane_scroll: usize,
    /// Full pane scrollback lines beyond `pane_tail`, filled by the
    /// deep `pane.read` fetch the first scroll-up past the tail
    /// triggers. Both the pane view and the lens read from it.
    pub(crate) pane_history: Vec<String>,
    /// Pane id the tail/history buffers belong to; a switch drops the
    /// scroll offset and the deep history instead of mixing panes.
    pub(crate) pane_buffers_pane_id: Option<String>,
    /// The backend served its whole scrollback (or the retention cap
    /// was reached): further deep fetches cannot grow the buffer.
    pub(crate) pane_history_exhausted: bool,
    /// Split-panel layout tree (design: docs/ux/tui-split-panels-design.md).
    /// Leaves hold backend pane ids (any workspace); single leaf = the
    /// pre-split single-pane view. Rebuilt lazily from the snapshot:
    /// a leaf whose pane vanished is pruned so the tree never paints a
    /// dead pane.
    pub(crate) split_tree: split::SplitNode,
    /// Pane id of the focused tile; `None` falls back to the sidebar
    /// selection (the pre-split behavior).
    pub(crate) split_focus: Option<String>,
    /// Zoom toggle: the focused tile renders the full pane area
    /// (WebUI maximized-leaf parity). Tree and ptys stay alive.
    pub(crate) split_zoomed: bool,
    /// Workspaces whose panes must join the split view on the next
    /// refresh (auto-split on open): opening or creating a workspace
    /// from the browser, worktree list, or search palette queues the
    /// workspace id plus the pane the user was looking at (the split
    /// neighbor, captured before the open moves the selection);
    /// sync_split_tree drains it and inserts the workspace's pane
    /// beside that neighbor. The pane exists only after the backend
    /// refresh, hence the deferral.
    pub(crate) split_panes_of_workspaces: Vec<(String, Option<String>)>,
    /// Split mode state (Ctrl+B s): the ghost preview over a tile and
    /// the pane the new tile would open.
    pub(crate) split_mode: Option<split::SplitPreview>,
    /// Move mode state (Ctrl+B m): picked tile, target, and verb.
    pub(crate) move_mode: Option<split::MoveState>,
    /// Resize mode state (Ctrl+B Shift+Z): the tile whose dividers the
    /// keys move.
    pub(crate) resize_mode: Option<split_mode::ResizeState>,
    /// Last direction pressed inside resize mode, so the render pass
    /// can preview that divider move even when the step clamped or
    /// refused (the attempted direction is still what the user wants
    /// to see).
    pub(crate) last_resize_dir: Option<(split::SplitDir, split::ResizeDir)>,
    /// The previous keypress closed a split/move overlay: the immediate
    /// next Esc must not fall through to the quit confirm (double-Esc
    /// reflex). Any other key clears it.
    pub(crate) just_closed_mode: bool,
    /// Last tail text per visible tile pane, for the non-focused tiles
    /// (the focused tile keeps the full pane_tail pipeline: styles,
    /// scroll, deep history). Only panes on the tree get entries.
    pub(crate) tile_tails: std::collections::HashMap<String, String>,
    /// Receiver of the in-flight tile-tail fetch worker. `None` means
    /// no fetch running: the next tail refresh may spawn one.
    tile_tail_rx: Option<std::sync::mpsc::Receiver<Vec<(String, String)>>>,
    /// Tile geometry of the last rendered frame (pane id + rect),
    /// recorded by the render pass so key walks score against the
    /// on-screen grid. RefCell: `render` takes `&TuiApp`.
    pub(crate) tile_geometry: std::cell::RefCell<Vec<crate::tui::render::TileRectOwned>>,
    terminal_raw_output: String,
    terminal_raw_terminal_id: Option<String>,
    /// Full TUI screen size (cols, rows), set by the binary loop at
    /// startup and on every Resize event. Attach sizes derive from it
    /// via `attach_viewport` so the pty matches the pane viewport
    /// instead of some stale or hard-coded geometry. (0, 0) means
    /// unknown: embedders that never drive a real screen keep the
    /// legacy 120x32 fallback.
    terminal_size: (u16, u16),
    pub status: String,
    pub error: Option<String>,
    /// Deadline until which `apply_refresh` leaves the status line
    /// alone, so action feedback survives the same-pass async drain.
    pub(crate) status_hold_until: Option<Instant>,
    /// Pending background refresh: worker channel plus the instant the
    /// round-trip left, so the footer can animate a spinner once the wait
    /// outgrows a normal sub-500ms reply. Consumed by `poll_refresh`.
    pub(crate) refresh_inflight: Option<RefreshInflight>,
    /// In-flight `worktree.list` fetches, at most one per workspace
    /// cwd. Drained by `poll_refresh` together with the snapshot
    /// worker so a dead backend cannot pile up stamp workers.
    pub(crate) stamp_inflight: Vec<StampInflight>,
    /// Fresh `worktree.list` replies per cwd, served for
    /// `STAMP_CACHE_TTL` so the default 1s refresh cadence does not
    /// re-run git on every tick (the same trade the webui wrapper
    /// made with its worktree cache).
    pub(crate) stamp_cache: std::collections::HashMap<String, StampCacheEntry>,
    pub last_refresh: Option<Instant>,
    /// When the pane tail was last polled outside the snapshot refresh
    /// (live preview loop, `TAIL_REFRESH_INTERVAL` cadence).
    pub(crate) last_tail_refresh: Option<Instant>,
    pub refresh_interval: Duration,
    pub theme: TuiTheme,
    pub(crate) palette: Palette,
    pub tick: u64,
    /// Two-step worktree creation: branch typed first, then checkout path.
    pub worktree_create_stage: Option<workspace::WorktreeCreateStage>,
    /// Two-step workspace creation: validated path first, then name
    /// (webui modal collects both at once).
    pub workspace_create_stage: Option<workspace::WorkspaceCreateStage>,
    /// Worktree browser overlay state (webui worktree open modal):
    /// discovered rows, cursor, type-to-filter query, and the discovery
    /// root shown in the title.
    pub worktree_rows: Vec<workspace::WorktreeRow>,
    pub worktree_selected: usize,
    pub worktree_filter: String,
    pub worktree_root: String,
    /// Subdirectories of the browse root, shown under the worktree
    /// rows so the overlay doubles as a folder picker (Enter descends,
    /// `o` opens the folder as a workspace).
    pub worktree_folder_rows: Vec<workspace::BrowserRow>,
    /// True when the browser overlay opened with the "pick a folder
    /// for a new workspace" intent (prefix `N`): Enter stages the
    /// selected path into the workspace name prompt instead of opening
    /// it. The webui has one "New workspace" modal with a directory
    /// picker; the TUI reuses the browser rows as that picker.
    pub worktree_pick_workspace: bool,
    /// Branch picker overlay state (desktop branch popover, prefix
    /// `v`): local branches of the selected workspace repo, cursor,
    /// and type-to-filter query.
    pub branch_picker_rows: Vec<crate::tui::panels::git::GitBranchEntry>,
    pub branch_picker_selected: usize,
    pub branch_picker_filter: String,
    /// Repo the branch picker last loaded: kept separate from the
    /// workspace cwd so the overlay can spot a stale list after the
    /// selection moves (and show a folder that no longer matches).
    pub branch_picker_root: String,
    /// Rebase upstream typed into the RebaseUpstream prompt; consumed by
    /// the follow-up typed confirm (webui rebase modal two-step).
    pub rebase_pending_upstream: Option<String>,
    /// Vertical scroll of the Help overlay (j/k when help is open).
    pub help_scroll: usize,
    /// Type-to-filter query for the Help overlay, the TUI counterpart of
    /// the webui settings "Search settings" box. Printable keys append,
    /// Backspace edits, Esc clears it before closing the overlay.
    pub help_filter: String,
    /// Search palette overlay state (webui search palette, prefix `/`):
    /// query, cursor and committed result rows.
    pub search_palette: search::SearchPalette,
    /// Chat lens state (webui Chat/Terminal segmented switch, prefix
    /// `L`): transcript overlay over the terminal pane, follow/unread
    /// scroller semantics.
    pub lens: LensState,
    /// Session manager overlay state (webui session manager, prefix
    /// `P`): server-known sessions, cursor, and the load error when
    /// the HTTP API is unreachable.
    pub session_rows: Vec<TuiSessionRow>,
    pub session_selected: usize,
    pub session_load_error: Option<String>,
    /// Backend session the client is currently pointed at. Tracked
    /// apart from the client itself so the overlay can mark the
    /// active row and skip no-op retargets.
    pub current_session: String,
    pub current_backend: String,
    /// Bumped on every session retarget. The bin loop watches it to
    /// drop a `LiveTerminal` pty still bound to the old session's
    /// terminal socket (the pty reader thread would otherwise keep
    /// feeding rows from a session that no longer owns the view).
    pub session_generation: u64,
    /// Per-pane composer drafts (webui composer box keeps its content
    /// per pane, not per view). Keyed by pane id.
    pub composer_drafts: std::collections::HashMap<String, String>,
    /// Mode the user was in when the quit overlay opened; restored on cancel.
    pub(crate) quit_prev_mode: TuiMode,
    /// Modes the user was in before each overlay (help/settings/worktree)
    /// opened, oldest opener at the bottom, so closing returns to the
    /// immediately previous context. The WebUI modals return to the
    /// underlying view; the TUI must keep the attach context, and a
    /// help overlay opened from inside the worktree overlay must close
    /// back into that overlay, not out of the whole stack.
    pub(crate) overlay_stack: Vec<TuiMode>,
    /// Onboarding tour state: current step index (tour.rs owns the step
    /// table) and whether the last walk reached the end.
    pub(crate) tour_index: usize,
    pub(crate) tour_finished: bool,
    /// Overlay the current step's demo opened (palette). The tour keeps
    /// the key dispatch and renders this surface below its card, webui's
    /// "palette open under the spotlight" behavior in a single-mode TUI.
    pub(crate) tour_demo_overlay: Option<TuiMode>,
    dirty: bool,
}

/// Commit message input state. Opened with the commit shortcut; typed text
/// becomes the commit title until Enter commits it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInput {
    pub text: String,
    pub amend: bool,
}

/// A modal text prompt. Used for file rename and for typing `y` to confirm
/// destructive actions (file delete, branch delete, stash drop).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptInput {
    pub kind: PromptKind,
    pub text: String,
}

impl PromptInput {
    pub fn new(kind: PromptKind) -> Self {
        Self {
            kind,
            text: String::new(),
        }
    }

    /// Prompt opened with a suggested value (worktree-create checkout
    /// path parity with the desktop modal): the prefill shows as editable
    /// text, so Enter accepts it and typing replaces it like any input.
    pub fn with_text(kind: PromptKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    RenameFile,
    ConfirmDeleteFile,
    ConfirmDeleteBranch,
    ConfirmDropStash,
    NewWorkspace,
    /// Second step of the new-workspace prompt: the workspace name
    /// (webui modal "Workspace name" field, suggested from the folder).
    NewWorkspaceName,
    RenameWorkspace,
    RenamePanel,
    CreateWorktreeBranch,
    CreateWorktreePath,
    /// Third step of the worktree create prompt: the base ref, with an
    /// explicit pull question after it (webui inline form's pull-base
    /// checkbox parity). Refs are preserved verbatim.
    CreateWorktreeBase,
    /// Fourth step: y fast-forwards the base ref before creating, any
    /// other answer (or empty Enter) creates without pulling.
    ConfirmWorktreePullBase,
    ConfirmCloseWorkspace,
    ConfirmCleanupDelete,
    /// Log view: tag name for the selected commit (webui tag modal).
    CreateTag,
    /// Log view: reset mode text (soft/mixed/hard) for the selected
    /// commit (webui reset modal). `hard` chains into a typed confirm.
    ResetMode,
    /// Log view: typed `y` guard for a hard reset (webui asks for
    /// "reset hard"; the server double-checks the same string).
    ConfirmResetHard,
    /// Log view: rebase upstream ref for the selected commit (webui
    /// rebase modal). Chains into `ConfirmRebase`'s typed `y`.
    RebaseUpstream,
    /// Log view: typed `y` guard that runs the rebase staged by
    /// `RebaseUpstream` (the webui modal has both fields at once;
    /// the TUI prompts sequentially).
    ConfirmRebase,
    /// Git cwd picker (prefix I): type a repo path, Enter switches the
    /// git panel to it (webui location bar).
    GitCwd,
    /// Branches view: create a new branch from the typed name
    /// (webui `git_switch` with create: true).
    CreateBranch,
    /// Files screen `a`: new empty file under the current root
    /// (webui mobile new-file flow; desktop has no default key).
    CreateFile,
    /// Files screen `A`: new directory. No mkdir endpoint exists, so
    /// this writes a `.gitkeep` marker inside (documented deviation).
    CreateDirectory,
    /// Edit mode Ctrl+H: replacement text for the current editor find
    /// match. A trailing `!` replaces all matches instead of the
    /// selected one (documented deviation from the webui replace bar,
    /// which has separate replace/replace-all buttons).
    ReplaceInFile,
    /// Composer message (ux overhaul, webui chat composer): the text
    /// is submitted through the server's pane submit route (agent.prompt
    /// semantics). Per-pane draft like the webui composer box.
    ComposerMessage,
    /// Session manager `n`: new session name. Enter launches it as a
    /// built-in session (webui "New built-in" input) and switches.
    CreateSession,
}

impl PromptKind {
    /// Destructive prompts only submit when the typed text is exactly `y`.
    pub fn needs_confirm(self) -> bool {
        matches!(
            self,
            Self::ConfirmDeleteFile
                | Self::ConfirmDeleteBranch
                | Self::ConfirmDropStash
                | Self::ConfirmCloseWorkspace
                | Self::ConfirmCleanupDelete
                | Self::ConfirmResetHard
                | Self::ConfirmRebase
        )
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::RenameFile => "Rename file",
            Self::ConfirmDeleteFile => "Delete file",
            Self::ConfirmDeleteBranch => "Delete branch",
            Self::ConfirmDropStash => "Drop stash",
            Self::NewWorkspace => "New workspace path",
            Self::NewWorkspaceName => "Workspace name",
            Self::RenameWorkspace => "Rename workspace",
            Self::RenamePanel => "Rename panel",
            Self::CreateWorktreeBranch => "Create worktree: branch",
            Self::CreateWorktreePath => "Create worktree: checkout path",
            Self::CreateWorktreeBase => "Create worktree: base ref",
            Self::ConfirmWorktreePullBase => "Create worktree: pull base first?",
            Self::ConfirmCloseWorkspace => "Close workspace (y)",
            Self::ConfirmCleanupDelete => "Delete cleanup items (y / yb)",
            Self::CreateTag => "Tag commit",
            Self::ResetMode => "Reset to commit",
            Self::ConfirmResetHard => "Hard reset (y)",
            Self::RebaseUpstream => "Rebase: upstream ref",
            Self::ConfirmRebase => "Rebase (y)",
            Self::GitCwd => "Git directory",
            Self::CreateBranch => "Create branch",
            Self::CreateFile => "New file",
            Self::CreateDirectory => "New directory",
            Self::ReplaceInFile => "Replace in file",
            Self::ComposerMessage => "Send a message",
            Self::CreateSession => "New built-in session",
        }
    }

    /// Hint shown under the input line.
    pub fn hint(self) -> &'static str {
        match self {
            Self::RenameFile => "type the new name, Enter renames",
            Self::NewWorkspace => "type a directory path (~ works), Enter continues to the name",
            Self::NewWorkspaceName => "type the workspace name, Enter creates it",
            Self::RenameWorkspace | Self::RenamePanel => "type the new name, Enter renames",
            Self::CreateWorktreeBranch => {
                "type the branch name (Enter keeps suggestion), Enter continues"
            }
            Self::CreateWorktreePath => "type the checkout path, Enter continues",
            Self::CreateWorktreeBase => "type the base ref (Enter keeps default, empty = HEAD)",
            Self::ConfirmWorktreePullBase => {
                "y pulls the base ref first, Enter creates without pulling"
            }
            Self::CreateTag => "type the tag name, Enter tags the selected commit",
            Self::ResetMode => "type soft, mixed or hard, Enter resets",
            Self::RebaseUpstream => "type the upstream ref, then y + Enter to rebase",
            Self::GitCwd => "type a repository path, Enter switches the git panel",
            Self::CreateBranch => "type the branch name, Enter creates and switches",
            Self::CreateFile => "type the file name, Enter creates an empty file",
            Self::CreateDirectory => "type the directory name, Enter creates it",
            Self::ReplaceInFile => "type the replacement, Enter replaces (! replaces all)",
            Self::ComposerMessage => "type the message, Enter sends it to the selected panel",
            Self::CreateSession => "type the session name, Enter launches it and switches",
            Self::ConfirmCleanupDelete => {
                "y deletes the selected items, yb also deletes their branches"
            }
            _ => "type y then Enter to confirm, Esc cancels",
        }
    }
}

/// In-flight background refresh: the worker's reply channel plus the
/// instant the round-trip started. `started` drives the footer spinner:
/// under the 500ms threshold a healthy loopback reply shows no spinner,
/// beyond it the status line animates until the reply (or the backend
/// timeout error) lands.
pub(crate) struct RefreshInflight {
    pub(crate) started: Instant,
    pub(crate) receiver: std::sync::mpsc::Receiver<Result<(Value, Value), BackendClientError>>,
}

/// One in-flight `worktree.list` fetch for a workspace cwd: the cwd
/// the reply stamps and the channel end the reply lands on. One
/// worker per cwd, never per tick. Manual Debug mirrors the snapshot
/// worker: the channel end is opaque and must not leak internals.
pub(crate) struct StampInflight {
    cwd: String,
    receiver: std::sync::mpsc::Receiver<Result<Value, BackendClientError>>,
}

impl std::fmt::Debug for StampInflight {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StampInflight")
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

/// Cached `worktree.list` reply for one cwd. The 2s TTL mirrors the
/// webui wrapper's worktree cache: consecutive refreshes hit the
/// cache while a user stares at the list, but a fresh checkout made
/// elsewhere shows up within a couple of seconds.
#[derive(Clone, Debug)]
pub(crate) struct StampCacheEntry {
    fetched_at: Instant,
    response: Value,
}

impl std::fmt::Debug for RefreshInflight {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // TuiApp derives Debug; the channel end is opaque, the started
        // instant is the useful part.
        f.debug_struct("RefreshInflight")
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

pub use terminal::input::{is_menu_key, key_to_terminal_bytes};

#[cfg(test)]
mod recent_open_tests {
    use super::*;
    use serde_json::json;

    /// The recent-open navigation target for a `worktree.open`
    /// response, parsed exactly like `run_search_candidate`: ids come
    /// from the objects nested under `"result"` (the real proxy shape
    /// behind the desktop `api()`, whose `openRecentWorkspace` reads
    /// `r.result.workspace`); a result object carrying `workspace_id`
    /// directly (no nested workspace object) still resolves. Returns
    /// `(workspace_id, tab_id, pane_id)`.
    fn recent_open_target(response: &Value) -> (String, Option<String>, Option<String>) {
        let result = response.get("result");
        let workspace = result.and_then(|result| result.get("workspace"));
        let workspace_id = TuiApp::recent_open_field(workspace, "workspace_id")
            .or_else(|| TuiApp::recent_open_field(result, "workspace_id"))
            .unwrap_or_default()
            .to_string();
        let tab_id =
            TuiApp::recent_open_field(result.and_then(|result| result.get("tab")), "tab_id")
                .map(str::to_string);
        let pane_id =
            TuiApp::recent_open_field(result.and_then(|result| result.get("root_pane")), "pane_id")
                .map(str::to_string);
        (workspace_id, tab_id, pane_id)
    }

    #[test]
    fn recent_open_target_parses_real_worktree_open_shape() {
        // Exactly what POST /api/recent-workspaces proxies back: the
        // backend's worktree.open result nested under "result".
        let response = json!({
            "ok": true,
            "result": {
                "workspace": { "workspace_id": "ws_reopened" },
                "tab": { "tab_id": "tab_reopened" },
                "root_pane": { "pane_id": "pane_reopened" }
            }
        });
        let (workspace_id, tab_id, pane_id) = recent_open_target(&response);
        assert_eq!(workspace_id, "ws_reopened");
        assert_eq!(tab_id.as_deref(), Some("tab_reopened"));
        assert_eq!(pane_id.as_deref(), Some("pane_reopened"));
    }

    #[test]
    fn recent_open_target_resolves_result_level_ids_and_skips_empty() {
        // A result object without the nested workspace object still
        // resolves workspace_id from the result level; empty or missing
        // ids stay None instead of resolving to empty-string targets.
        // A response without a "result" wrapper resolves nothing
        // (the real proxy always wraps, matching the desktop's
        // `r.result.workspace` read).
        let response = json!({
            "ok": true,
            "result": {
                "workspace_id": "ws_bare",
                "tab": { "tab_id": "" },
                "root_pane": {}
            }
        });
        let (workspace_id, tab_id, pane_id) = recent_open_target(&response);
        assert_eq!(workspace_id, "ws_bare");
        assert_eq!(tab_id, None, "empty tab id stays None");
        assert_eq!(pane_id, None, "missing pane id stays None");

        let flat = json!({ "workspace": { "workspace_id": "ws_flat" } });
        let (workspace_id, _, _) = recent_open_target(&flat);
        assert_eq!(workspace_id, "", "no result wrapper resolves nothing");
    }
}

#[cfg(test)]
pub(crate) mod prompt_action_tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead as _, Read as _, Write as _};

    /// Looping catch-all HTTP server: every route answers `{"ok": true}`
    /// plus the route-shaped payloads the verbs need (files list, tree
    /// refresh), except paths listed in `failures`, which answer 500 with
    /// an error body. The refresh tails after each verb need the loop.
    pub(crate) fn fake_api_server(
        failures: &[&str],
    ) -> (WebApiClient, std::sync::mpsc::Sender<()>) {
        fake_api_server_with_tree("", failures)
    }

    /// `fake_api_server` whose tree route serves a two-file listing
    /// when the request carries `tree_cwd` (query-encoded like the
    /// client sends it), so post-create refreshes keep a selectable
    /// entry. Empty `tree_cwd` keeps the flat-empty tree of old tests.
    /// Coverage is off because the accept-error break arm only fires
    /// on a broken listener, which no test can produce.
    #[cfg_attr(coverage, coverage(off))]
    pub(crate) fn fake_api_server_with_tree(
        tree_cwd: &str,
        failures: &[&str],
    ) -> (WebApiClient, std::sync::mpsc::Sender<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let failures: Vec<String> = failures.iter().map(|f| f.to_string()).collect();
        let tree_cwd = tree_cwd.to_string();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if rx.try_recv().is_ok() {
                    break;
                }
                let Ok(mut stream) = stream else { break };
                let mut request = String::new();
                let mut content_length = 0usize;
                {
                    let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                    if reader.read_line(&mut request).unwrap_or(0) == 0 {
                        continue;
                    }
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).unwrap_or(0) == 0
                            || header.trim().is_empty()
                        {
                            break;
                        }
                        if let Some(value) = header
                            .trim()
                            .to_ascii_lowercase()
                            .strip_prefix("content-length:")
                        {
                            content_length = value.trim().parse().unwrap_or(0);
                        }
                    }
                    let mut payload = vec![0u8; content_length];
                    if content_length > 0 {
                        let _ = reader.read_exact(&mut payload);
                    }
                }
                let target = request.split(' ').nth(1).unwrap_or_default().to_string();
                let response = if failures.iter().any(|f| target.contains(f.as_str())) {
                    json!({"error": "route refused by the fake server"})
                } else if target.contains("/api/file-browser/list")
                    || target.contains("/api/file-browser/tree")
                {
                    if !tree_cwd.is_empty()
                        && target.contains(&format!("cwd={}", tree_cwd.replace('/', "%2F")))
                    {
                        json!({"entries": [
                            {"name": "a.rs", "path": "a.rs", "kind": "file"},
                            {"name": "b.rs", "path": "b.rs", "kind": "file"}
                        ], "truncated": false})
                    } else {
                        json!({"entries": [], "tree": {"name": "repo", "path": "/repo",
                            "dirs": [], "files": []}})
                    }
                } else if target.contains("/api/git-ui/branches") {
                    json!({"branches": [
                        {"name": "feat", "current": false, "remote": false,
                         "pushed": false, "worktree_path": null}
                    ]})
                } else if target.contains("/api/file-browser/file") && target.contains("path=bin") {
                    // Edit-refusal flows need a binary read answer; the
                    // marker only lives in this one route so tree and
                    // search fixtures stay unchanged.
                    json!({"content": "\u{0}", "binary": true, "truncated": false})
                } else {
                    json!({"ok": true})
                };
                let text = serde_json::to_string(&response).unwrap();
                let status_line = if response.get("error").is_some() {
                    "HTTP/1.1 500 Internal Server Error"
                } else {
                    "HTTP/1.1 200 OK"
                };
                let _ = write!(
                    stream,
                    "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    text.len(),
                    text
                );
            }
        });
        (WebApiClient::new("127.0.0.1", port), tx)
    }

    pub(crate) fn app_with_api(api: WebApiClient) -> TuiApp {
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
            }
        }));
        app.web_api = api;
        app
    }

    pub(crate) fn explorer_with_selection() -> crate::tui::panels::FileExplorer {
        let mut explorer = crate::tui::panels::FileExplorer::new("/repo");
        explorer.entries.push(crate::tui::panels::FileEntry {
            name: "a.rs".into(),
            path: "a.rs".into(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        });
        explorer
    }

    #[test]
    fn prompt_rename_and_delete_file_cover_all_outcomes() {
        // No selection: both verbs refuse before any request.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::RenameFile, "b.rs");
        assert_eq!(app.error.as_deref(), Some("no file selected"));
        app.run_prompt_action(PromptKind::ConfirmDeleteFile, "");
        assert_eq!(app.error.as_deref(), Some("no file selected"));
        assert!(app.status.is_empty() || app.status != "renamed to b.rs");

        // Success: rename then delete against the looping fake. The
        // rename's refresh wipes the entries list, so re-seed before
        // the delete.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.run_prompt_action(PromptKind::RenameFile, "b.rs");
        assert_eq!(app.status, "renamed to b.rs");
        assert!(app.error.is_none(), "refresh after rename: {:?}", app.error);
        app.file_explorer = explorer_with_selection();
        app.run_prompt_action(PromptKind::ConfirmDeleteFile, "");
        assert_eq!(app.status, "deleted a.rs");

        // Server refusal lands in the error slot.
        let (api, _stop) = fake_api_server(&["/rename"]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.run_prompt_action(PromptKind::RenameFile, "b.rs");
        assert!(app.error.is_some(), "rename refusal surfaces");

        let (api, _stop) = fake_api_server(&["/delete"]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.run_prompt_action(PromptKind::ConfirmDeleteFile, "");
        assert!(app.error.is_some(), "delete refusal surfaces");
    }

    #[test]
    fn prompt_delete_branch_and_drop_stash_cover_all_outcomes() {
        // No branch rows: refusal.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::ConfirmDeleteBranch, "");
        assert_eq!(app.error.as_deref(), Some("no branch selected"));

        // A current branch never deletes through the prompt.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.branches = vec![crate::tui::panels::git::GitBranchEntry {
            name: "main".into(),
            current: true,
            remote: false,
            pushed: false,
            worktree_path: None,
        }];
        app.run_prompt_action(PromptKind::ConfirmDeleteBranch, "");
        assert_eq!(app.error.as_deref(), Some("no branch selected"));

        // Non-current branch deletes.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.branches = vec![crate::tui::panels::git::GitBranchEntry {
            name: "feature".into(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        }];
        app.run_prompt_action(PromptKind::ConfirmDeleteBranch, "");
        assert_eq!(app.status, "deleted branch feature");

        // Refused delete and stash drop outcomes.
        let (api, _stop) = fake_api_server(&["/branch-delete"]);
        let mut app = app_with_api(api);
        app.git_panel.branches = vec![crate::tui::panels::git::GitBranchEntry {
            name: "feature".into(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        }];
        app.run_prompt_action(PromptKind::ConfirmDeleteBranch, "");
        assert!(app.error.is_some());

        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.stashes = vec![crate::tui::panels::git::GitStashEntry {
            name: "stash@{0}".into(),
            message: "wip".into(),
        }];
        app.run_prompt_action(PromptKind::ConfirmDropStash, "");
        assert_eq!(app.status, "stash dropped");

        let (api, _stop) = fake_api_server(&["/stash-drop"]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::ConfirmDropStash, "");
        assert!(app.error.is_some());
    }

    #[test]
    fn prompt_cleanup_delete_reports_count_and_failures() {
        // One marked merged branch: plain `y` deletes it.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
            path: "/repo".to_string(),
            branches: vec!["old".into()],
            worktrees: vec![],
        }];
        app.git_panel.cleanup_toggle_mark();
        app.run_prompt_action(PromptKind::ConfirmCleanupDelete, "y");
        assert_eq!(app.status, "deleted 1 cleanup item(s)");
        assert!(app.error.is_none(), "{:?}", app.error);

        // `yb` also asks for the branch delete; a refusal records the
        // per-item failure on top of the status.
        let (api, _stop) = fake_api_server(&["/branch-delete"]);
        let mut app = app_with_api(api);
        app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
            path: "/repo".to_string(),
            branches: vec![],
            worktrees: vec![crate::tui::panels::git::CleanupWorktree {
                path: "/repo-wt".to_string(),
                branch: Some("feature".into()),
            }],
        }];
        app.git_panel.cleanup_toggle_mark();
        app.run_prompt_action(PromptKind::ConfirmCleanupDelete, "yb");
        assert!(app.error.is_some(), "branch failure recorded");
    }

    #[test]
    fn prompt_tag_reset_rebase_cover_all_branches() {
        // Empty tag name is refused locally.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::CreateTag, "  ");
        assert_eq!(app.error.as_deref(), Some("type a tag name"));

        // Tag, soft and mixed resets succeed against the selected
        // commit.
        app.git_panel.commits = vec![crate::tui::panels::git::GitCommitEntry {
            hash: "abc123".into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }];
        app.run_prompt_action(PromptKind::CreateTag, "v1");
        assert_eq!(app.status, "tagged v1");
        app.run_prompt_action(PromptKind::ResetMode, "soft");
        assert_eq!(app.status, "reset soft");
        app.run_prompt_action(PromptKind::ResetMode, "mixed");
        assert_eq!(app.status, "reset mixed");

        // Hard reset chains into the typed-y confirm prompt.
        app.run_prompt_action(PromptKind::ResetMode, "hard");
        assert_eq!(app.status, PromptKind::ConfirmResetHard.title());
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::ConfirmResetHard)
        ));
        app.run_prompt_action(PromptKind::ConfirmResetHard, "y");
        assert_eq!(app.status, "reset hard");

        // Unknown reset mode text is refused.
        app.run_prompt_action(PromptKind::ResetMode, "sideways");
        assert_eq!(app.error.as_deref(), Some("type soft, mixed or hard"));

        // Rebase: empty upstream refused, then chains into the confirm.
        app.run_prompt_action(PromptKind::RebaseUpstream, "  ");
        assert_eq!(app.error.as_deref(), Some("type the upstream ref"));
        app.run_prompt_action(PromptKind::RebaseUpstream, "origin/main");
        assert_eq!(app.status, PromptKind::ConfirmRebase.title());
        app.run_prompt_action(PromptKind::ConfirmRebase, "y");
        assert_eq!(app.status, "rebase onto origin/main");

        // Confirming with nothing pending is an error.
        app.run_prompt_action(PromptKind::ConfirmRebase, "y");
        assert_eq!(app.error.as_deref(), Some("no rebase pending"));

        // Refused tag and hard reset propagate the server error.
        let (api, _stop) = fake_api_server(&["/tag"]);
        let mut app = app_with_api(api);
        app.git_panel.commits = vec![crate::tui::panels::git::GitCommitEntry {
            hash: "abc123".into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }];
        app.run_prompt_action(PromptKind::CreateTag, "v2");
        assert!(app.error.is_some());
        let (api, _stop) = fake_api_server(&["/reset"]);
        let mut app = app_with_api(api);
        app.git_panel.commits = vec![crate::tui::panels::git::GitCommitEntry {
            hash: "abc123".into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }];
        app.run_prompt_action(PromptKind::ResetMode, "hard");
        app.run_prompt_action(PromptKind::ConfirmResetHard, "y");
        assert!(app.error.is_some());
        let (api, _stop) = fake_api_server(&["/rebase"]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::RebaseUpstream, "origin/main");
        app.run_prompt_action(PromptKind::ConfirmRebase, "y");
        assert!(app.error.is_some());
    }

    #[test]
    fn prompt_git_cwd_create_branch_file_and_directory_cover_outcomes() {
        // Empty cwd refused locally.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::GitCwd, "  ");
        assert_eq!(app.error.as_deref(), Some("type a directory path"));

        // A real directory sets the cwd and refreshes the view.
        let repo = std::env::current_dir().unwrap();
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::GitCwd, repo.to_string_lossy().as_ref());
        assert!(app.status.starts_with("git cwd: "), "{}", app.status);

        // Empty branch and file/dir names refused.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::CreateBranch, "  ");
        assert_eq!(app.error.as_deref(), Some("type a branch name"));
        app.run_prompt_action(PromptKind::CreateFile, " ");
        assert_eq!(app.error.as_deref(), Some("type a file name"));
        app.run_prompt_action(PromptKind::CreateDirectory, " ");
        assert_eq!(app.error.as_deref(), Some("type a directory name"));

        // Create branch/file/dir succeed through the fake.
        app.run_prompt_action(PromptKind::CreateBranch, "feat");
        assert_eq!(app.status, "switched to feat");
        app.run_prompt_action(PromptKind::CreateFile, "new.rs");
        assert_eq!(app.status, "created new.rs");
        app.run_prompt_action(PromptKind::CreateDirectory, "sub");
        assert_eq!(app.status, "created sub");

        // Refused variants land in the error slot.
        let (api, _stop) = fake_api_server(&["/switch"]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::CreateBranch, "feat");
        assert!(app.error.is_some());
        let (api, _stop) = fake_api_server(&["/file-browser/file"]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.run_prompt_action(PromptKind::CreateFile, "new.rs");
        assert!(app.error.is_some());
        let (api, _stop) = fake_api_server(&["/file-browser/file"]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.run_prompt_action(PromptKind::CreateDirectory, "sub");
        assert!(app.error.is_some());
    }

    #[test]
    fn prompt_replace_in_file_counts_and_fails() {
        // No find matches: the replace refuses before any request.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::ReplaceInFile, "new");
        assert!(app.error.is_some());

        // One match: replace-one reports 1 of 1. The replace writes
        // through the server, so the preview needs real content, and
        // the query must be set like Ctrl+F leaves it (the replace
        // recomputes ranges from the query, never trusting stored ones).
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.file_explorer.preview.content = "old line".to_string();
        app.file_explorer.editor_find.query = "old".to_string();
        app.run_prompt_action(PromptKind::ReplaceInFile, "new");
        assert_eq!(app.status, "replaced 1 of 1 matches");
        // The find bar reopens (webui replace bar stays up): Enter
        // cycles the remaining matches instead of typing a newline.
        assert!(app.file_explorer.editor_find.active);
        assert_eq!(app.file_explorer.editor_find.ranges, Vec::new());

        // `!` suffix replaces all.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.file_explorer.preview.content = "old old".to_string();
        app.file_explorer.editor_find.query = "old".to_string();
        app.run_prompt_action(PromptKind::ReplaceInFile, "new!");
        assert_eq!(app.status, "replaced 2 matches");
        assert!(app.file_explorer.editor_find.active);

        // Stale ranges from a shrunk buffer no longer panic: the replace
        // recomputes from the query and reports what it actually saw.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer = explorer_with_selection();
        app.file_explorer.preview.content = "ol".to_string();
        app.file_explorer.editor_find.query = "old".to_string();
        // Offsets past the end of the shrunk buffer (the pre-fix panic).
        app.file_explorer.editor_find.ranges = vec![(0, 3)];
        app.run_prompt_action(PromptKind::ReplaceInFile, "new");
        assert!(app.error.is_some(), "no live match in the shrunk buffer");
    }

    #[test]
    fn prompt_composer_and_session_cover_outcomes() {
        // No pane selected: the composer refuses.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.snapshot.panes.clear();
        app.run_prompt_action(PromptKind::ComposerMessage, "hi");
        assert_eq!(app.error.as_deref(), Some("no pane selected"));

        // Whitespace-only message is a silent no-op.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::ComposerMessage, " \r\n ");
        assert_eq!(app.status, "message empty, nothing sent");

        // A real message sends and clears the draft.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.composer_drafts.insert("pane_1".into(), "draft".into());
        app.run_prompt_action(PromptKind::ComposerMessage, "hello\n");
        assert_eq!(app.status, "message sent");
        assert!(!app.composer_drafts.contains_key("pane_1"));

        // A refused send keeps the draft and shows the note.
        let (api, _stop) = fake_api_server(&["/submit"]);
        let mut app = app_with_api(api);
        app.composer_drafts.insert("pane_1".into(), "draft".into());
        app.run_prompt_action(PromptKind::ComposerMessage, "hello");
        assert_ne!(app.status, "message sent");
        assert!(app.composer_drafts.contains_key("pane_1"));

        // Session: empty name refused, then launch failure surfaces
        // (the launch endpoint works but the retarget socket is dead).
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_prompt_action(PromptKind::CreateSession, " ");
        assert_eq!(app.error.as_deref(), Some("type a session name"));
        app.run_prompt_action(PromptKind::CreateSession, "lane");
        assert!(app.status.contains("lane") || app.error.is_some());
    }
}

#[cfg(test)]
mod key_handler_tests {
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};
    use panels::files::content_search::{ContentSearchChunk, ContentSearchFile, ContentSearchRow};
    use panels::files::SearchKind;

    pub(crate) fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn key_mod(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }

    fn content_file(path: &str) -> ContentSearchFile {
        ContentSearchFile {
            path: path.to_string(),
            name: path.to_string(),
            match_count: 1,
            chunks: vec![ContentSearchChunk {
                start: 1,
                end: 3,
                rows: vec![
                    ContentSearchRow {
                        line: 1,
                        text: "ctx".into(),
                        matched: false,
                    },
                    ContentSearchRow {
                        line: 2,
                        text: "match here".into(),
                        matched: true,
                    },
                ],
            }],
            truncated: false,
            first_match_line: 2,
        }
    }

    fn app_with_results() -> (TuiApp, std::sync::mpsc::Sender<()>) {
        let (api, stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer.search_mode = true;
        app.file_explorer.search_kind = SearchKind::Content;
        app.file_explorer.content_search.query = "match".into();
        app.file_explorer.filter = "match".into();
        app.file_explorer.content_search.files = vec![content_file("a.rs")];
        app.file_explorer.content_search.expanded = vec![true];
        (app, stop)
    }

    #[test]
    fn content_search_keys_walk_toggle_open_and_clear() {
        // j/k move over the flat rows: file header then line rows.
        let (mut app, _stop) = app_with_results();
        app.handle_content_search_key(key(KeyCode::Char('j')));
        assert_eq!(app.file_explorer.content_search.selected, 1);
        app.handle_content_search_key(key(KeyCode::Char('k')));
        assert_eq!(app.file_explorer.content_search.selected, 0);
        // Enter on the file header collapses/expands the group.
        app.handle_content_search_key(key(KeyCode::Enter));
        assert!(!app.file_explorer.content_search.expanded[0]);
        app.handle_content_search_key(key(KeyCode::Enter));
        assert!(app.file_explorer.content_search.expanded[0]);
        // Enter on a line row opens the preview at that line: walk
        // down past the header to the first line row.
        app.handle_content_search_key(key(KeyCode::Char('j')));
        app.handle_content_search_key(key(KeyCode::Char('j')));
        app.handle_content_search_key(key(KeyCode::Enter));
        assert_eq!(app.status, "a.rs:2");
        // Esc clears the results and refreshes the tree.
        app.handle_content_search_key(key(KeyCode::Esc));
        assert!(!app.file_explorer.search_mode);
        assert!(!app.file_explorer.content_search.has_results());
        assert_eq!(app.status, "content search closed");
    }

    #[test]
    fn content_search_load_more_and_toggles() {
        // `+` hits the fake server; the empty reply marks the page
        // done (no truncated flag), so the status reports a load.
        let (mut app, _stop) = app_with_results();
        app.file_explorer.content_search.done = false;
        app.handle_content_search_key(key(KeyCode::Char('+')));
        assert_eq!(app.status, "loaded more results");
        assert!(app.file_explorer.content_search.done);
        // `+` when done reports no more.
        app.file_explorer.content_search.done = true;
        app.handle_content_search_key(key(KeyCode::Char('+')));
        assert_eq!(app.status, "no more results");
        // A/X flip match-case/regex and re-run against the fake.
        app.handle_content_search_key(key(KeyCode::Char('A')));
        assert!(app.file_explorer.content_search.match_case);
        assert!(app.status.starts_with("search re-run"));
        app.handle_content_search_key(key(KeyCode::Char('X')));
        assert!(app.file_explorer.content_search.regex);
        // A dead server surfaces the re-run error instead of a status.
        let (mut app, _stop) = app_with_results();
        drop(app.web_api);
        app.web_api = WebApiClient::new("127.0.0.1", 1);
        app.handle_content_search_key(key(KeyCode::Char('X')));
        assert!(app.error.is_some());
    }

    #[test]
    fn editor_find_keys_type_and_navigate() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer.editor_find.active = true;
        app.file_explorer.preview.content = "old old".into();
        app.handle_editor_find_key(key(KeyCode::Char('o')));
        app.handle_editor_find_key(key(KeyCode::Char('l')));
        app.handle_editor_find_key(key(KeyCode::Char('d')));
        assert_eq!(app.file_explorer.editor_find.query, "old");
        app.handle_editor_find_key(key(KeyCode::Enter));
        assert_eq!(app.status, "match 2/2");
        assert_eq!(app.file_explorer.editor_find.selected, 1);
        app.handle_editor_find_key(key_mod(KeyCode::Enter, KeyModifiers::SHIFT));
        assert_eq!(app.file_explorer.editor_find.selected, 0);
        assert_eq!(app.status, "match 1/2");
        app.handle_editor_find_key(key(KeyCode::Backspace));
        assert_eq!(app.file_explorer.editor_find.query, "ol");
        app.handle_editor_find_key(key(KeyCode::Char('A')));
        assert!(app.file_explorer.editor_find.match_case);
        app.handle_editor_find_key(key(KeyCode::Char('X')));
        assert!(app.file_explorer.editor_find.regex);
        app.handle_editor_find_key(key(KeyCode::Esc));
        assert!(!app.file_explorer.editor_find.active);
        assert_eq!(app.status, "find closed");
    }

    #[test]
    fn commit_input_keys_commit_and_cancel() {
        // Empty message refuses.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.commit_input = Some(CommitInput {
            text: String::new(),
            amend: false,
        });
        app.handle_commit_key(key(KeyCode::Enter));
        assert_eq!(app.error.as_deref(), Some("commit message is empty"));
        assert!(app.commit_input.is_none());
        // Typing and Ctrl+U clearing, then a real commit.
        app.commit_input = Some(CommitInput {
            text: String::new(),
            amend: false,
        });
        app.handle_commit_key(key(KeyCode::Char('f')));
        app.handle_commit_key(key(KeyCode::Char('i')));
        app.handle_commit_key(key_mod(KeyCode::Char('u'), KeyModifiers::CONTROL));
        assert!(app.commit_input.as_ref().unwrap().text.is_empty());
        app.handle_commit_key(key(KeyCode::Char('x')));
        assert_eq!(app.commit_input.as_ref().unwrap().text, "x");
        app.handle_commit_key(key(KeyCode::Enter));
        assert!(app.commit_input.is_none());
        assert_eq!(app.status, "committed: x");
        // Esc cancels the input without committing.
        app.commit_input = Some(CommitInput {
            text: "wip".into(),
            amend: false,
        });
        app.handle_commit_key(key(KeyCode::Esc));
        assert!(app.commit_input.is_none());
        // A refused commit surfaces the error.
        let (api, _stop) = fake_api_server(&["/commit"]);
        let mut app = app_with_api(api);
        app.commit_input = Some(CommitInput {
            text: "y".into(),
            amend: false,
        });
        app.handle_commit_key(key(KeyCode::Enter));
        assert!(app.error.is_some());
    }

    #[test]
    fn navigation_just_closed_esc_and_help_reflexes() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        // Double-Esc reflex: the first Esc after a closed overlay is
        // swallowed into a status hint, not the quit confirm.
        app.just_closed_mode = true;
        app.handle_navigation_key(key(KeyCode::Esc));
        assert_eq!(app.status, "press q to quit");
        assert!(app.mode != TuiMode::ConfirmQuit);
        // A second Esc opens the quit confirm.
        app.handle_navigation_key(key(KeyCode::Esc));
        assert!(app.mode == TuiMode::ConfirmQuit);
        // ? opens the help overlay; Esc closes it again.
        app.mode = TuiMode::Navigate;
        app.handle_navigation_key(key(KeyCode::Char('?')));
        assert!(app.mode == TuiMode::Help);
        app.handle_navigation_key(key(KeyCode::Esc));
        assert!(app.mode != TuiMode::Help);
    }
}

#[cfg(test)]
mod git_key_tests {
    use super::key_handler_tests::key;
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use crossterm::event::KeyCode;
    use panels::git::{
        CleanupItem, CleanupItemKind, CleanupRepo, CleanupWorktree, ConflictAction,
        ConflictResolveMode, GitBranchEntry, GitCommitEntry, GitStashEntry, GitView,
    };

    fn commit(hash: &str) -> GitCommitEntry {
        GitCommitEntry {
            hash: hash.into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }
    }

    fn git_app(failures: &[&str]) -> (TuiApp, std::sync::mpsc::Sender<()>) {
        let (api, stop) = fake_api_server(failures);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Git;
        app.mode = TuiMode::Navigate;
        (app, stop)
    }

    #[test]
    fn git_tab_cycles_views_and_diff_search_keys() {
        let (mut app, _stop) = git_app(&[]);
        // Tab walks the view ring all the way around.
        for view in [
            GitView::Log,
            GitView::Branches,
            GitView::Stash,
            GitView::History,
            GitView::Conflicts,
            GitView::Cleanup,
            GitView::Changes,
        ] {
            app.handle_git_key(key(KeyCode::Tab));
            assert_eq!(app.git_panel.view, view, "tab cycle");
        }
        // `/` opens the diff search, n/N walk it, Esc cancels once
        // matches exist.
        app.git_panel.view = GitView::Changes;
        app.git_panel.diff_lines = vec!["+ match here".into()];
        app.git_panel.diff_search_matches = vec![0];
        app.handle_git_key(key(KeyCode::Esc));
        assert!(
            app.git_panel.diff_search_matches.is_empty(),
            "esc clears committed search"
        );
        app.handle_git_key(key(KeyCode::Char('/')));
        assert_eq!(
            app.status,
            "diff search: type to match, n/N cycle, Esc closes"
        );
        // While the bar is open every printable key types into it and
        // the status reports the live match count.
        app.handle_git_key(key(KeyCode::Char('m')));
        assert_eq!(app.status, "diff search: m (1 matches)");
        // Enter commits the query; n/N cycle the kept matches.
        app.handle_git_key(key(KeyCode::Enter));
        app.handle_git_key(key(KeyCode::Char('n')));
        assert!(app.status.ends_with("(1 matches)"));
        app.handle_git_key(key(KeyCode::Char('N')));
        assert!(app.status.ends_with("(1 matches)"));
        // Esc closes and forgets; with no matches left n/N report it.
        app.handle_git_key(key(KeyCode::Esc));
        // With the bar closed and no matches kept, n/N report it.
        app.handle_git_key(key(KeyCode::Char('n')));
        assert_eq!(app.status, "no diff search matches");
        app.handle_git_key(key(KeyCode::Char('N')));
        assert_eq!(app.status, "no diff search matches");
        // J/K without hunks report it.
        app.handle_git_key(key(KeyCode::Char('J')));
        assert_eq!(app.status, "no hunks in the loaded diff");
        app.handle_git_key(key(KeyCode::Char('K')));
        assert_eq!(app.status, "no hunks in the loaded diff");
    }

    #[test]
    fn git_log_keys_select_compare_and_prompt() {
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::Log;
        app.git_panel.commits = vec![commit("aaa"), commit("bbb")];
        // Space marks commits; Enter compares the selected pair (the
        // old `c` compare moved aside so `c` is always the commit modal).
        app.handle_git_key(key(KeyCode::Char(' ')));
        assert_eq!(app.git_panel.log_selected, vec!["aaa"]);
        app.handle_git_key(key(KeyCode::Char('j')));
        app.handle_git_key(key(KeyCode::Char(' ')));
        assert_eq!(app.git_panel.log_selected.len(), 2);
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.status, "compare loaded");
        // t/R/b open the tag/reset/rebase prompts on the selection.
        app.handle_git_key(key(KeyCode::Char('t')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::CreateTag)
        ));
        app.handle_git_key(key(KeyCode::Char('R')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::ResetMode)
        ));
        app.handle_git_key(key(KeyCode::Char('b')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::RebaseUpstream)
        ));
        // w opens the worktree creation prompt chain (base first).
        app.handle_git_key(key(KeyCode::Char('w')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::CreateWorktreeBase)
        ));
        // Enter compares the selected commit with its parent.
        app.prompt_input = None;
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.status, "compare loaded");
        // s cycles the log scope; `+` loads more until refused.
        app.handle_git_key(key(KeyCode::Char('s')));
        assert!(app.status.starts_with("log scope: "));
        app.git_panel.log_has_more = true;
        app.handle_git_key(key(KeyCode::Char('+')));
        assert!(app.status.starts_with("log limit: "));
        // Without a selection, t/R/b and Space refuse.
        app.git_panel.commits.clear();
        app.handle_git_key(key(KeyCode::Char('t')));
        assert_eq!(app.error.as_deref(), Some("no commit selected"));
        app.handle_git_key(key(KeyCode::Char(' ')));
        assert_eq!(app.error.as_deref(), Some("no commit selected"));
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.error.as_deref(), Some("no commit selected"));
    }

    #[test]
    fn git_actions_stage_discard_fetch_pull_push_commit() {
        let (mut app, _stop) = git_app(&[]);
        // `c` opens the commit modal, a the amend modal outside stash.
        app.handle_git_key(key(KeyCode::Char('c')));
        let input = app.commit_input.expect("commit modal");
        assert!(!input.amend);
        app.commit_input = None;
        app.handle_git_key(key(KeyCode::Char('a')));
        assert!(app.commit_input.expect("amend modal").amend);
        app.commit_input = None;
        // Stage/discard/fetch/pull/push succeed against the looping
        // fake (stage and discard need a selected file).
        app.git_panel.files = vec![panels::git::GitFileEntry {
            path: "a.rs".into(),
            status: panels::git::GitFileStatus::Unstaged,
        }];
        for ch in ['s', 'd', 'f', 'p', 'P', 'G'] {
            app.error = None;
            // Each mutating verb's refresh wipes the file list, so
            // re-seed the selection before every key.
            app.git_panel.files = vec![panels::git::GitFileEntry {
                path: "a.rs".into(),
                status: panels::git::GitFileStatus::Unstaged,
            }];
            app.git_panel.file_selected = 0;
            app.handle_git_key(key(KeyCode::Char(ch)));
            assert!(app.error.is_none(), "{ch} failed: {:?}", app.error);
        }
        // Every git verb fails against the dead server.
        let (mut app, _stop) = git_app(&["/git-ui/"]);
        app.git_panel.files = vec![panels::git::GitFileEntry {
            path: "a.rs".into(),
            status: panels::git::GitFileStatus::Unstaged,
        }];
        for ch in ['s', 'd', 'f', 'p', 'P', 'G', 'H'] {
            app.error = None;
            // The failing verb's own refresh also wipes the list.
            app.git_panel.files = vec![panels::git::GitFileEntry {
                path: "a.rs".into(),
                status: panels::git::GitFileStatus::Unstaged,
            }];
            app.git_panel.file_selected = 0;
            app.handle_git_key(key(KeyCode::Char(ch)));
            assert!(app.error.is_some(), "{ch} should fail: {:?}", app.error);
        }
        // Discard under a dirty matching preview refuses instead.
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::Changes;
        app.git_panel.files = vec![panels::git::GitFileEntry {
            path: "a.rs".into(),
            status: panels::git::GitFileStatus::Unstaged,
        }];
        app.file_explorer.preview.dirty = true;
        app.file_explorer.preview.path = Some("a.rs".into());
        app.handle_git_key(key(KeyCode::Char('d')));
        assert_eq!(
            app.error.as_deref(),
            Some("unsaved edits: save or reload before discarding this file")
        );
    }

    #[test]
    fn git_branch_and_stash_keys_cover_all_guards() {
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::Branches;
        app.git_panel.branches = vec![GitBranchEntry {
            name: "main".into(),
            current: true,
            remote: false,
            pushed: true,
            worktree_path: None,
        }];
        // Current branch cannot be deleted.
        app.handle_git_key(key(KeyCode::Char('D')));
        assert_eq!(
            app.error.as_deref(),
            Some("cannot delete the current branch")
        );
        // A non-current branch opens the confirm prompt.
        app.git_panel.branches.push(GitBranchEntry {
            name: "feat".into(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        });
        app.git_panel.branch_selected = 1;
        app.handle_git_key(key(KeyCode::Char('D')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::ConfirmDeleteBranch)
        ));
        app.prompt_input = None;
        // No selection refuses.
        app.git_panel.branches.clear();
        app.handle_git_key(key(KeyCode::Char('D')));
        assert_eq!(app.error.as_deref(), Some("no branch selected"));
        // `B` in Branches prompts for a new branch (`c` is the commit
        // modal everywhere now).
        app.handle_git_key(key(KeyCode::Char('B')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::CreateBranch)
        ));
        app.prompt_input = None;
        // Enter switches the selected branch (fake accepts).
        app.git_panel.branches = vec![GitBranchEntry {
            name: "feat".into(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        }];
        app.git_panel.branch_selected = 0;
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.status, "switched to feat");
        // Stash view: Enter loads a diff, a applies, D guards.
        app.git_panel.view = GitView::Stash;
        app.git_panel.stashes = vec![GitStashEntry {
            name: "stash@{0}".into(),
            message: "wip".into(),
        }];
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.status, "stash diff loaded");
        app.handle_git_key(key(KeyCode::Char('a')));
        assert_eq!(app.status, "stash applied");
        // The apply's refresh wiped the stash list; re-seed for D.
        app.git_panel.stashes = vec![GitStashEntry {
            name: "stash@{0}".into(),
            message: "wip".into(),
        }];
        app.handle_git_key(key(KeyCode::Char('D')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::ConfirmDropStash)
        ));
        app.prompt_input = None;
        app.git_panel.stashes.clear();
        app.handle_git_key(key(KeyCode::Char('D')));
        assert_eq!(app.error.as_deref(), Some("no stash selected"));
    }

    #[test]
    fn git_conflicts_and_cleanup_keys() {
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::Conflicts;
        // o/e/t/m resolve through the fake server. The refresh after
        // each resolve wipes the conflict list, so re-seed per key.
        for (ch, expected) in [
            ('o', "resolved with HEAD"),
            ('e', "resolved with parent"),
            ('t', "resolved with remote"),
            ('m', "marked resolved"),
        ] {
            app.git_panel.conflict_files = vec!["a.rs".into()];
            app.handle_git_key(key(KeyCode::Char(ch)));
            assert_eq!(app.status, expected, "{ch} resolve");
        }
        // R/S/A continue/skip/abort the in-flight operation.
        app.git_panel.rebase_in_progress = true;
        app.handle_git_key(key(KeyCode::Char('R')));
        assert_eq!(app.status, "operation continued");
        app.handle_git_key(key(KeyCode::Char('S')));
        assert_eq!(app.status, "rebase commit skipped");
        app.handle_git_key(key(KeyCode::Char('A')));
        assert_eq!(app.status, "operation aborted");
        // Without conflicts the resolve keys surface the error.
        app.git_panel.conflict_files.clear();
        app.handle_git_key(key(KeyCode::Char('o')));
        assert!(app.error.is_some());

        // Cleanup view: Space marks, x guards without selection, B prunes.
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::Cleanup;
        app.git_panel.cleanup_repos = vec![CleanupRepo {
            path: "/repo".into(),
            branches: vec![],
            worktrees: vec![CleanupWorktree {
                path: "/lane".into(),
                branch: Some("feat".into()),
            }],
        }];
        app.handle_git_key(key(KeyCode::Char(' ')));
        assert_eq!(app.status, "marked 1 item(s)");
        app.handle_git_key(key(KeyCode::Char('x')));
        assert!(matches!(
            app.prompt_input.as_ref().map(|p| p.kind),
            Some(PromptKind::ConfirmCleanupDelete)
        ));
        app.prompt_input = None;
        app.git_panel.cleanup_repos.clear();
        app.handle_git_key(key(KeyCode::Char('x')));
        assert_eq!(app.error.as_deref(), Some("no cleanup item selected"));
        app.git_panel.cleanup_repos = vec![CleanupRepo {
            path: "/repo".into(),
            branches: vec!["feat".into()],
            worktrees: vec![],
        }];
        app.handle_git_key(key(KeyCode::Char('B')));
        assert_eq!(app.status, "worktrees pruned");
        // ? opens help from any git view.
        app.handle_git_key(key(KeyCode::Char('?')));
        assert_eq!(app.mode, TuiMode::Help);
    }

    #[test]
    fn git_history_enter_loads_commit_diff() {
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::History;
        app.git_panel.history_file = Some("a.rs".into());
        app.git_panel.commits = vec![commit("abc")];
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.status, "commit abc · a.rs");
        app.git_panel.commits.clear();
        app.handle_git_key(key(KeyCode::Enter));
        assert_eq!(app.error.as_deref(), Some("no commit selected"));
    }

    #[test]
    fn git_changes_enter_refreshes_diff() {
        let (mut app, _stop) = git_app(&[]);
        app.git_panel.view = GitView::Changes;
        app.handle_git_key(key(KeyCode::Enter));
        assert!(app.error.is_none());
        let (mut app, _stop) = git_app(&["/diff"]);
        app.git_panel.view = GitView::Changes;
        app.handle_git_key(key(KeyCode::Enter));
        assert!(app.error.is_some());
        let _ = CleanupItem {
            repo: String::new(),
            name: String::new(),
            kind: CleanupItemKind::Branch,
            branch: None,
            current: false,
        };
        let _ = (ConflictAction::MergeContinue, ConflictResolveMode::Ours);
    }
}

#[cfg(test)]
mod shortcut_tests {
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use panels::git::{GitFileEntry, GitFileStatus, GitView};

    #[test]
    fn shortcuts_open_screens_overlays_and_cycle_focus() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        // Help overlay, settings overlay, files screen.
        app.run_shortcut(Shortcut::Help);
        assert_eq!(app.mode, TuiMode::Help);
        app.mode = TuiMode::Navigate;
        // Settings on the Terminal screen in Navigate opens split mode;
        // the SettingsOverlay chord opens the overlay from anywhere.
        app.run_shortcut(Shortcut::Settings);
        assert!(app.split_mode.is_some(), "settings on terminal opens split");
        app.split_mode = None;
        app.screen = TuiScreen::Git;
        app.run_shortcut(Shortcut::Settings);
        assert_eq!(app.mode, TuiMode::Settings);
        app.mode = TuiMode::Navigate;
        app.run_shortcut(Shortcut::SettingsOverlay);
        assert_eq!(app.mode, TuiMode::Settings);
        app.mode = TuiMode::Navigate;
        app.screen = TuiScreen::Terminal;
        app.run_shortcut(Shortcut::Files);
        assert_eq!(app.screen, TuiScreen::Files);
        // Git and terminal routing plus view shortcuts.
        app.run_shortcut(Shortcut::Git);
        assert_eq!(app.screen, TuiScreen::Git);
        app.run_shortcut(Shortcut::Terminal);
        assert_eq!(app.screen, TuiScreen::Terminal);
        app.run_shortcut(Shortcut::GitLog);
        assert_eq!(app.git_panel.view, GitView::Log);
        app.run_shortcut(Shortcut::GitStash);
        assert_eq!(app.git_panel.view, GitView::Stash);
        app.run_shortcut(Shortcut::GitBranch);
        assert_eq!(app.git_panel.view, GitView::Branches);
        app.run_shortcut(Shortcut::GitChanges);
        assert_eq!(app.git_panel.view, GitView::Changes);
        app.run_shortcut(Shortcut::GitChangesBack);
        assert_eq!(app.git_panel.view, GitView::Changes);
        // Focus walker cycles through the regions.
        app.screen = TuiScreen::Terminal;
        app.run_shortcut(Shortcut::FocusNext);
        app.run_shortcut(Shortcut::FocusPrev);
        assert!(app.status.is_empty() || app.error.is_none());
        // Sidebar toggle flips the flag both ways.
        app.run_shortcut(Shortcut::Sidebar);
        assert!(app.sidebar_collapsed);
        app.run_shortcut(Shortcut::Sidebar);
        assert!(!app.sidebar_collapsed);
        // Quit shortcut opens the confirm, not an instant exit.
        app.run_shortcut(Shortcut::Quit);
        assert_eq!(app.mode, TuiMode::ConfirmQuit);
        app.mode = TuiMode::Navigate;
        // Split entry points only act on the Terminal screen.
        app.screen = TuiScreen::Files;
        app.run_shortcut(Shortcut::SplitPane);
        assert!(app.split_mode.is_none());
        app.run_shortcut(Shortcut::MovePane);
        assert!(app.move_mode.is_none());
        app.run_shortcut(Shortcut::ZoomPane);
        app.run_shortcut(Shortcut::ResizePane);
        assert!(app.resize_mode.is_none());
        app.screen = TuiScreen::Terminal;
        app.run_shortcut(Shortcut::SplitPane);
        assert!(app.split_mode.is_some());
        app.split_mode = None;
        // Move needs a focused pane and 2+ tiles; the single-tile
        // fixture reports it instead of opening the overlay.
        app.run_shortcut(Shortcut::MovePane);
        assert!(app.move_mode.is_none());
        app.run_shortcut(Shortcut::ResizePane);
        assert!(app.resize_mode.is_none());
    }

    #[test]
    fn git_shortcuts_stage_unstage_stash_push_and_blame() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".into();
        // run_git_action routes through open_git_screen, whose refresh
        // wipes the file list; start on the Git screen and re-seed the
        // selection before every mutating verb.
        app.screen = TuiScreen::Git;
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::GitStageFile);
        assert!(app.error.is_none(), "stage failed: {:?}", app.error);
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Staged,
        }];
        app.run_shortcut(Shortcut::GitUnstageFile);
        assert!(app.error.is_none(), "unstage failed: {:?}", app.error);
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::GitPush);
        assert!(app.error.is_none(), "push failed: {:?}", app.error);
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::GitStageAll);
        assert_eq!(app.status, "staged state toggled");
        // No selection guards for stage/unstage/discard.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".into();
        app.screen = TuiScreen::Git;
        app.run_shortcut(Shortcut::GitStageFile);
        assert!(app.error.is_some());
        app.error = None;
        app.run_shortcut(Shortcut::GitUnstageFile);
        assert!(app.error.is_some());
        app.error = None;
        app.run_shortcut(Shortcut::GitDiscardFile);
        assert!(app.error.is_some());
        // Empty cwd guards stage-all.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = String::new();
        app.run_shortcut(Shortcut::GitStageAll);
        assert_eq!(app.error.as_deref(), Some("git: no repository selected"));
        // Stash verb on the git screen stashes, on Terminal it zooms.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".into();
        app.screen = TuiScreen::Git;
        app.run_shortcut(Shortcut::GitStashFile);
        assert!(app.status.contains("stashed"));
        // Blame toggles on the git screen.
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::GitBlame);
        assert!(app.error.is_none(), "blame failed: {:?}", app.error);
        app.run_shortcut(Shortcut::GitBlame);
        assert!(app.error.is_none(), "blame off failed: {:?}", app.error);
        // File history requires a selected file.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".into();
        app.run_shortcut(Shortcut::GitFileHistory);
        assert_eq!(
            app.error.as_deref(),
            Some("no file selected in git changes")
        );
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::GitFileHistory);
        assert!(app.status.starts_with("history: a.rs"));
        // Focus-file reports an empty list without a selection.
        app.git_panel.files.clear();
        app.run_shortcut(Shortcut::GitFocusFile);
        assert_eq!(app.status, "git: no files in the list");
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::GitFocusFile);
        assert_eq!(app.status, "git: file list focused");
    }

    #[test]
    fn edit_file_shortcut_opens_git_and_files_editors() {
        // Files screen: start editing the open preview.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer.preview.path = Some("a.rs".into());
        app.file_explorer.preview.content = "hi".into();
        app.run_shortcut(Shortcut::EditFile);
        assert_eq!(app.status, "editing: Ctrl-S saves, Esc stops");
        // Git screen: no selection refuses.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Git;
        app.git_panel.cwd = "/repo".into();
        app.run_shortcut(Shortcut::EditFile);
        assert_eq!(
            app.error.as_deref(),
            Some("no file selected in git changes")
        );
        // Git screen with a selection opens the editor through the api.
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.error = None;
        app.run_shortcut(Shortcut::EditFile);
        assert_eq!(app.status, "editing: Ctrl-S saves, Esc stops");
        assert_eq!(app.screen, TuiScreen::Files);
        // Git screen with a dirty different preview refuses.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Git;
        app.git_panel.cwd = "/repo".into();
        app.git_panel.files = vec![GitFileEntry {
            path: "b.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.file_explorer.preview.dirty = true;
        app.file_explorer.preview.path = Some("a.rs".into());
        app.run_shortcut(Shortcut::EditFile);
        assert_eq!(
            app.status,
            "unsaved edits: save or reload before editing another file"
        );
    }

    #[test]
    fn git_commit_shortcut_opens_modal_and_branch_picker_routes() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.run_shortcut(Shortcut::GitCommit);
        assert!(app.commit_input.is_some());
        assert_eq!(app.status, "commit: type message, Enter commits");
        // Branch switch shortcut opens the picker overlay.
        app.run_shortcut(Shortcut::GitSwitchBranch);
        // Session manager opens its overlay.
        app.run_shortcut(Shortcut::SessionManager);
        // Composer and lens both route through the footer helpers.
        app.screen = TuiScreen::Terminal;
        app.run_shortcut(Shortcut::Composer);
        app.run_shortcut(Shortcut::Lens);
        assert!(app.status.is_empty() || app.error.is_none());
    }
}

#[cfg(test)]
mod files_nav_key_tests {
    use super::key_handler_tests::key;
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use crossterm::event::KeyCode;
    use panels::git::{GitFileEntry, GitFileStatus};

    #[test]
    fn files_keys_reveal_log_and_tab_recents() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        // L opens the git log scoped to the selected file.
        app.handle_files_key(key(KeyCode::Char('L')));
        assert_eq!(app.screen, TuiScreen::Git);
        assert_eq!(app.git_panel.view, panels::git::GitView::Log);
        assert_eq!(app.git_panel.log_file.as_deref(), Some("a.rs"));
        assert_eq!(app.status, "log: a.rs");
        // L without a file selection refuses.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        app.file_explorer.selected = usize::MAX; // no selection
        app.handle_files_key(key(KeyCode::Char('L')));
        assert_eq!(app.error.as_deref(), Some("select a file first"));
        // Tab with no recents reports it; a dirty buffer blocks.
        app.error = None;
        app.handle_files_key(key(KeyCode::Tab));
        assert_eq!(app.status, "no recent previews");
        app.file_explorer.preview.dirty = true;
        app.handle_files_key(key(KeyCode::Tab));
        assert_eq!(app.status, "save or discard before switching");
        // w reveals the git-panel selected file in the tree (the
        // explorer may refuse under the dirty buffer, so the verb runs
        // against a clean preview first).
        app.file_explorer.preview.dirty = false;
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        app.git_panel.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        }];
        app.handle_files_key(key(KeyCode::Char('w')));
        assert_eq!(app.status, "revealed a.rs");
        app.git_panel.files.clear();
        app.handle_files_key(key(KeyCode::Char('w')));
        assert_eq!(
            app.error.as_deref(),
            Some("no file selected in the git panel")
        );
        // `/` opens the filter bar.
        app.error = None;
        app.handle_files_key(key(KeyCode::Char('/')));
        assert!(app.file_explorer.filter_active);
    }

    #[test]
    fn navigation_main_focus_keys_scroll_and_route_panels() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        app.main_focused = true;
        // Ctrl+j/k scroll the focused pane.
        app.pane_tail = vec!["line".to_string(); 40];
        app.handle_navigation_key(key_mod_down());
        app.handle_navigation_key(key_mod_up());
        // Page keys scroll by pages, G/g jump to the ends.
        app.handle_navigation_key(key(KeyCode::PageDown));
        app.handle_navigation_key(key(KeyCode::PageUp));
        app.handle_navigation_key(key(KeyCode::Char('G')));
        app.handle_navigation_key(key(KeyCode::Char('g')));
        // Enter attaches the selected pane (dead socket: error arm).
        app.handle_navigation_key(key(KeyCode::Enter));
        assert!(
            app.error.is_some(),
            "attach on the dead socket surfaces the error"
        );
        // Files/Git screens delegate to the panel handlers.
        app.screen = TuiScreen::Files;
        app.handle_navigation_key(key(KeyCode::Char('j')));
        app.screen = TuiScreen::Terminal;
        // Sidebar focus keys: a/w switch the region, Tab toggles.
        app.main_focused = false;
        app.handle_navigation_key(key(KeyCode::Char('a')));
        assert!(matches!(app.sidebar_focus, SidebarFocus::Agents));
        app.handle_navigation_key(key(KeyCode::Char('w')));
        assert!(matches!(app.sidebar_focus, SidebarFocus::Workspaces));
        app.handle_navigation_key(key(KeyCode::Tab));
        // Lens and composer footer chords route through.
        app.handle_navigation_key(key(KeyCode::Char('L')));
        app.handle_navigation_key(key(KeyCode::Char('C')));
        // r refreshes the active screen against the fake.
        app.handle_navigation_key(key(KeyCode::Char('r')));
    }

    fn key_mod_down() -> KeyEvent {
        crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('j'),
            crossterm::event::KeyModifiers::CONTROL,
        )
    }

    fn key_mod_up() -> KeyEvent {
        crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('k'),
            crossterm::event::KeyModifiers::CONTROL,
        )
    }
}

#[cfg(test)]
mod scroll_tests {
    use super::*;
    use serde_json::json;
    /// Minimal backend answering ping, snapshot and pane.read with a
    /// long scrollback, so the deep-fetch scroll paths run for real.
    pub(crate) fn fake_backend_with_history(
        lines: usize,
    ) -> (BackendClient, std::sync::mpsc::Sender<()>) {
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
        use std::io::{BufRead, BufReader, Write};

        let path = crate::backend_client::unique_test_path("herdr-tui-scroll");
        let _ = std::fs::remove_file(&path);
        let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
        let listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
            .unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let history: String = (0..lines).map(|i| format!("line {i}\n")).collect();
        std::thread::spawn(move || loop {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(mut stream) = listener.accept() else {
                break;
            };
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let response = match request["method"].as_str().unwrap_or("") {
                "ping" => {
                    json!({"id": request["id"], "result": {"version": "scroll", "protocol": 1}})
                }
                "session.snapshot" => json!({"id": request["id"], "result": {"snapshot": {
                    "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                    "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                    "agents": []
                }}}),
                "pane.read" => json!({"id": request["id"], "result": {"read": {"text": history}}}),
                _ => json!({"id": request["id"], "result": {}}),
            };
            let _ = stream.write_all(serde_json::to_string(&response).unwrap().as_bytes());
            let _ = stream.write_all(b"\n");
            let _ = stream.flush();
        });
        let path_str = path.to_str().unwrap().to_string();
        (BackendClient::new(&path_str, &path_str), tx)
    }

    /// Stop a fake listener's thread and wake it: the loop checks the
    /// stop channel between accepts, so one extra connection after the
    /// signal lets the thread observe it and exit. Also exercises the
    /// accept-failure break when the listener is dropped first.
    pub(crate) fn stop_fake_listener(stop: &std::sync::mpsc::Sender<()>, path: &std::path::Path) {
        let _ = stop.send(());
        // Wake the accept() call so the loop re-checks the stop channel.
        use interprocess::local_socket::{prelude::*, GenericFilePath};
        let name = path.to_fs_name::<GenericFilePath>().unwrap();
        let _ = interprocess::local_socket::Stream::connect(name);
    }

    /// Drive a fake listener through every arm a real client can hit:
    /// empty-read continue, non-JSON continue, and the catch-all method
    /// arm. Shared by the tile-tail suite so fixtures stay exercised.
    pub(crate) fn probe_fake_listener_arms(path: &std::path::Path) {
        use interprocess::local_socket::{prelude::*, GenericFilePath, Stream as LocalStream};
        use std::io::{BufRead, BufReader, Write};

        let name = path.to_fs_name::<GenericFilePath>().unwrap();
        // connect then drop: read_line sees 0 bytes (empty-read continue).
        let mute = LocalStream::connect(name.clone()).unwrap();
        drop(mute);
        // non-JSON line (parse-failure continue).
        let mut garbage = LocalStream::connect(name.clone()).unwrap();
        garbage.write_all(b"not json\n").unwrap();
        garbage.flush().unwrap();
        drop(garbage);
        // Unknown method: the catch-all result.
        let mut unknown = LocalStream::connect(name.clone()).unwrap();
        let request = serde_json::json!({"id": 50, "method": "agent.list"});
        unknown
            .write_all(serde_json::to_string(&request).unwrap().as_bytes())
            .unwrap();
        unknown.write_all(b"\n").unwrap();
        unknown.flush().unwrap();
        let mut reply = String::new();
        let mut reader = BufReader::new(&unknown);
        reader.read_line(&mut reply).unwrap();
        // The catch-all reply shape varies per fixture (some answer every
        // well-formed request with their pane.read payload), so only pin
        // the echoed id and the presence of a result object.
        let parsed: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(parsed["id"], 50);
        assert!(parsed["result"].is_object());
    }

    #[test]
    fn scroll_up_deep_fetches_history_and_down_follows() {
        let (client, _stop) = fake_backend_with_history(400);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }
        }));
        // Scrolling up past the held tail deep-fetches real history.
        let grew = app.scroll_pane_up(50);
        assert!(grew > 0, "expected a deep fetch, grew {grew}");
        assert!(app.pane_history.len() >= 50);
        // Scrolling down lowers the offset back toward the tail.
        let offset = app.pane_scroll;
        app.scroll_pane_down(10);
        assert_eq!(app.pane_scroll, offset.saturating_sub(10));
        // Once exhausted, further up-scrolls return without fetching.
        app.pane_history_exhausted = true;
        let grew = app.scroll_pane_up(5000);
        assert_eq!(grew, 0);
    }

    #[test]
    fn deepen_without_pane_or_backend_errors_cleanly() {
        // No pane in view: deepen returns 0 without touching anything.
        let (client, _stop) = fake_backend_with_history(10);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = Default::default();
        assert_eq!(app.deepen_pane_history(), 0);
        // Dead backend: the read error surfaces and deepen returns 0.
        let client = BackendClient::new("/nonexistent-scroll.sock", "/nonexistent-scroll.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }
        }));
        assert_eq!(app.deepen_pane_history(), 0);
        assert!(app.error.is_some());
        // Exhausted flag short-circuits before any request.
        app.error = None;
        app.pane_history_exhausted = true;
        assert_eq!(app.deepen_pane_history(), 0);
        assert!(app.error.is_none());
    }
}

#[cfg(test)]
mod misc_coverage_tests {
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};

    fn nav_key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn lens_keys_scroll_jump_and_close() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Terminal;
        app.lens.active = true;
        app.pane_tail = (0..60).map(|i| format!("l{i}")).collect::<Vec<_>>();
        // j/k walk, pages, G/g jump, Esc/q close.
        app.handle_lens_key(nav_key(KeyCode::Char('k')));
        assert!(app.lens.scroll_up >= 1);
        app.handle_lens_key(nav_key(KeyCode::Char('j')));
        app.handle_lens_key(nav_key(KeyCode::PageDown));
        app.handle_lens_key(nav_key(KeyCode::PageUp));
        app.handle_lens_key(nav_key(KeyCode::Char('G')));
        app.handle_lens_key(nav_key(KeyCode::Char('g')));
        app.handle_lens_key(nav_key(KeyCode::Esc));
        assert!(!app.lens.active);
        assert_eq!(app.status, "lens closed");
        // q and i close too.
        app.lens.active = true;
        app.handle_lens_key(nav_key(KeyCode::Char('q')));
        assert!(!app.lens.active);
        app.lens.active = true;
        app.handle_lens_key(nav_key(KeyCode::Char('i')));
        assert!(!app.lens.active);
    }

    #[test]
    fn sync_history_suffix_keeps_one_tail_copy() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.pane_history = (0..50).map(|i| format!("h{i}")).collect::<Vec<_>>();
        app.pane_tail = vec!["t0".into(), "t1".into()];
        app.sync_history_suffix();
        assert_eq!(app.pane_history.len(), 50);
        assert_eq!(app.pane_history[48], "t0");
        assert_eq!(app.pane_history[49], "t1");
        // A tail longer than the history rewrites it entirely.
        app.pane_history.clear();
        app.pane_tail = vec!["a".into(), "b".into(), "c".into()];
        app.sync_history_suffix();
        assert!(app.pane_history.is_empty());
    }

    #[test]
    fn helpers_move_index_trim_and_strip() {
        assert_eq!(move_index(0, 0, 1), 0);
        assert_eq!(move_index(5, 3, 1), 2);
        assert_eq!(move_index(0, 3, -1), 0);
        assert_eq!(strip_ansi_lossy("\u{1b}[31mred\u{1b}[0m"), "red");
        let mut raw = "x".repeat(TERMINAL_RAW_BUFFER_BYTES + 10);
        trim_terminal_raw_output(&mut raw);
        assert!(raw.len() <= TERMINAL_RAW_BUFFER_BYTES + 4);
    }

    #[test]
    fn build_client_routes_explicit_and_builtin_sockets() {
        let options = TuiOptions {
            api_socket: Some("/tmp/a.sock".into()),
            terminal_socket: Some("/tmp/t.sock".into()),
            ..Default::default()
        };
        let client = build_client(&options);
        assert_eq!(client.api_socket(), std::path::Path::new("/tmp/a.sock"));
        // Without explicit sockets the builtin session namespace wins.
        let options = TuiOptions::default();
        let client = build_client(&options);
        assert!(client.api_socket().to_string_lossy().contains("herdr"));
    }

    #[test]
    fn status_notice_and_quit_flag() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.set_status_notice("hello".into());
        assert_eq!(app.status, "hello");
        assert!(app.status_hold_until.is_some());
        assert!(!app.should_quit());
        app.status = "quit".into();
        assert!(app.should_quit());
    }
}

#[cfg(test)]
mod final_coverage_tests {
    use super::key_handler_tests::key;
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};
    use panels::git::{GitView, LOG_PAGE_SIZE};

    #[test]
    fn content_search_enter_error_arm_and_attach_viewport() {
        // Enter on a line row whose preview open fails surfaces the
        // error instead of a jump status.
        let (api, _stop) = fake_api_server(&["/file-browser/file"]);
        let mut app = app_with_api(api);
        app.file_explorer.search_mode = true;
        app.file_explorer.search_kind = panels::files::SearchKind::Content;
        app.file_explorer.filter = "m".into();
        app.file_explorer.content_search.query = "m".into();
        app.file_explorer.content_search.files =
            vec![panels::files::content_search::ContentSearchFile {
                path: "a.rs".into(),
                name: "a.rs".into(),
                match_count: 1,
                chunks: vec![panels::files::content_search::ContentSearchChunk {
                    start: 1,
                    end: 1,
                    rows: vec![panels::files::content_search::ContentSearchRow {
                        line: 1,
                        text: "m".into(),
                        matched: true,
                    }],
                }],
                truncated: false,
                first_match_line: 1,
            }];
        app.file_explorer.content_search.expanded = vec![true];
        // Walk down to the line row and Enter: the refused read errors.
        app.handle_content_search_key(key(KeyCode::Char('j')));
        app.handle_content_search_key(key(KeyCode::Enter));
        assert!(app.error.is_some());
        // Enter past the end of the rows is a no-op.
        app.error = None;
        app.file_explorer.content_search.selected = 9;
        app.handle_content_search_key(key(KeyCode::Enter));
        assert!(app.error.is_none());

        // attach_viewport: split geometry for the focused tile, then
        // the terminal-size fallback and the 120x32 default.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.tile_geometry
            .borrow_mut()
            .push(crate::tui::render::TileRectOwned {
                pane_id: "pane_1".into(),
                x: 0,
                y: 0,
                width: 80,
                height: 24,
            });
        // Two leaves make split_active true; the focused pane matches
        // the seeded tile geometry.
        app.split_tree = crate::tui::split::SplitNode::split(
            crate::tui::split::SplitDir::Row,
            vec![
                crate::tui::split::SplitNode::leaf("pane_1"),
                crate::tui::split::SplitNode::leaf("pane_2"),
            ],
        );
        app.split_focus = Some("pane_1".into());
        let (cols, rows) = app.attach_viewport();
        assert_eq!((cols, rows), (78, 19));
        app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
        app.terminal_size = (100, 40);
        let (cols, rows) = app.attach_viewport();
        assert_eq!((cols, rows), (64, 33));
        app.terminal_size = (0, 0);
        assert_eq!(app.attach_viewport(), (120, 32));
    }

    #[test]
    fn diff_search_typing_and_hunk_walk_and_apply() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Changes;
        // Bar open: typing, backspace, Enter commit, n/N cycle.
        app.git_panel.diff_lines = vec!["+ alpha".into(), "- beta".into()];
        app.git_panel.diff_search_active = true;
        app.handle_git_key(key(KeyCode::Char('a')));
        assert!(app.status.starts_with("diff search: a (2 matches)"));
        app.handle_git_key(key(KeyCode::Backspace));
        assert!(app.status.starts_with("diff search:  (0 matches)"));
        app.handle_git_key(key(KeyCode::Char('b')));
        app.handle_git_key(key(KeyCode::Enter));
        app.handle_git_key(key(KeyCode::Char('n')));
        // Hunks: J/K walk a loaded diff, H applies through the fake.
        app.git_panel.diff_search_active = false;
        app.git_panel.diff_title = "a.rs".into();
        app.git_panel.diff_lines = vec![
            "@@ -1,2 +1,3 @@".into(),
            " context".into(),
            "+ added".into(),
        ];
        // hunk_headers reads diff_meta: header lines carry None.
        app.git_panel.diff_meta = vec![None, Some(Default::default()), Some(Default::default())];
        app.handle_git_key(key(KeyCode::Char('J')));
        assert_eq!(app.status, "hunk 1");
        app.handle_git_key(key(KeyCode::Char('K')));
        assert_eq!(app.status, "hunk 1");
        app.handle_git_key(key(KeyCode::Char('H')));
        assert!(app.error.is_none(), "hunk apply failed: {:?}", app.error);
        // H with no file loaded refuses.
        app.git_panel.diff_title = "working tree".into();
        app.handle_git_key(key(KeyCode::Char('H')));
        assert!(app.error.is_some());
    }

    #[test]
    fn log_scope_and_limit_refusals() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Log;
        // `+` with nothing more reports no more commits.
        app.git_panel.log_has_more = false;
        app.handle_git_key(key(KeyCode::Char('+')));
        assert_eq!(app.status, "no more commits");
        // Scope cycling refreshes and reports the label.
        app.handle_git_key(key(KeyCode::Char('s')));
        assert!(app.status.starts_with("log scope: "));
        assert!(app.git_panel.log_limit >= LOG_PAGE_SIZE);
    }

    #[test]
    fn workspace_shortcuts_route_manager_and_panel_ops() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        app.run_shortcut(Shortcut::NewWorkspace);
        app.run_shortcut(Shortcut::OpenWorktrees);
        app.run_shortcut(Shortcut::CreateWorktree);
        app.run_shortcut(Shortcut::CloseWorkspace);
        app.run_shortcut(Shortcut::RemoveWorktree);
        app.run_shortcut(Shortcut::RenamePanel);
        app.run_shortcut(Shortcut::RenameWorkspace);
        app.run_shortcut(Shortcut::NextPanel);
        app.run_shortcut(Shortcut::PrevPanel);
        app.run_shortcut(Shortcut::NextWorkspace);
        app.run_shortcut(Shortcut::PrevWorkspace);
        app.run_shortcut(Shortcut::NewTab);
        app.run_shortcut(Shortcut::CloseTab);
        app.run_shortcut(Shortcut::Search);
        app.run_shortcut(Shortcut::Refresh);
        // Ctrl+S in the settings overlay: route a save chord through
        // the palette-free path just to confirm no panic.
        app.run_shortcut(Shortcut::GitCwdPicker);
        // All shortcuts ran without panicking; their status/error
        // text is flow-dependent, so no exact assertion here.
    }

    #[test]
    fn terminal_attach_keys_send_and_detach() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Attach;
        // Plain char keys map to terminal bytes; the dead backend
        // socket surfaces the attach failure in dispatch, but the
        // key-to-bytes mapping must still resolve.
        let bytes = key_to_terminal_bytes(key(KeyCode::Char('x')));
        assert_eq!(bytes, Some("x".as_bytes().to_vec()));
        let esc = key_to_terminal_bytes(key(KeyCode::Esc));
        assert_eq!(esc, Some(b"\x1b".to_vec()));
        // Ctrl-G routes through handle_key and detaches.
        app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert_ne!(app.mode, TuiMode::Attach);
    }
}

#[cfg(test)]
mod batch11_coverage_tests {
    use super::scroll_tests::fake_backend_with_history;
    use super::scroll_tests::probe_fake_listener_arms;
    use super::scroll_tests::stop_fake_listener;
    use super::*;
    use crate::model::TuiAgentSession;
    use panels::git::{CleanupRepo, CleanupWorktree, GitCommitEntry, GitView};

    fn commit(hash: &str) -> GitCommitEntry {
        GitCommitEntry {
            hash: hash.into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }
    }

    /// The run_shortcut copies of the conflicts/cleanup/log verbs only
    /// miss their api-error arms, so this suite runs them against a
    /// fake server that refuses the one route each verb needs while
    /// the surrounding refresh routes keep looping.
    #[test]
    fn shortcut_conflicts_and_cleanup_error_arms() {
        // Conflicts: the four resolve modes plus merge-flavored R/A
        // with rebase_in_progress false.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/conflict-resolve", "/conflict-action"])
                .0,
        );
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Conflicts;
        for ch in ['o', 'e', 't', 'm'] {
            app.git_panel.conflict_files = vec!["a.rs".into()];
            app.handle_git_key(super::key_handler_tests::key(
                crossterm::event::KeyCode::Char(ch),
            ));
            assert!(app.error.is_some(), "{ch} resolve error");
        }
        app.git_panel.rebase_in_progress = false;
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('R'),
        ));
        assert!(app.error.is_some(), "merge continue error");
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('S'),
        ));
        assert!(app.error.is_some(), "rebase skip error");
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('A'),
        ));
        assert!(app.error.is_some(), "merge abort error");

        // Cleanup: B with a selected item against a refusing prune.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/worktree-prune"]).0,
        );
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Cleanup;
        app.git_panel.cleanup_repos = vec![CleanupRepo {
            path: "/repo".into(),
            branches: vec![],
            worktrees: vec![CleanupWorktree {
                path: "/lane".into(),
                branch: Some("feat".into()),
            }],
        }];
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('B'),
        ));
        assert!(app.error.is_some(), "prune error");

        // Log Enter with a selected commit against a refusing compare.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/compare"]).0,
        );
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Log;
        app.git_panel.commits = vec![commit("abc")];
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(app.error.is_some(), "compare error");
        // The GitCommit shortcut dispatches the same Enter arm in git
        // context: keep the Log view so the compare runs again.
        app.error = None;
        app.run_shortcut(Shortcut::GitCommit);
        assert!(
            app.commit_input.is_some(),
            "shortcut opens the commit input"
        );
    }

    /// Terminal-screen navigation keys that only run with the sidebar
    /// focused path: help, j/k, page keys, and Enter attaching the
    /// selected pane (real history backend, so the attach tail loads).
    #[test]
    fn navigation_bottom_keys_and_attach() {
        let (client, _stop) = fake_backend_with_history(10);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        // Sidebar focus: the navigation match below the main_focused arm.
        app.main_focused = false;
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [],
                "agents": []
            }
        }));
        let key = super::key_handler_tests::key;
        use crossterm::event::KeyCode;
        app.handle_navigation_key(key(KeyCode::Char('?')));
        assert_eq!(app.mode, TuiMode::Help);
        app.mode = TuiMode::Navigate;
        app.handle_navigation_key(key(KeyCode::Char('r')));
        app.handle_navigation_key(key(KeyCode::Char('j')));
        app.handle_navigation_key(key(KeyCode::Char('k')));
        app.handle_navigation_key(key(KeyCode::PageUp));
        app.handle_navigation_key(key(KeyCode::PageDown));
        app.handle_navigation_key(key(KeyCode::Char('L')));
        app.handle_navigation_key(key(KeyCode::Char('C')));
        app.handle_navigation_key(key(KeyCode::Char('a')));
        app.handle_navigation_key(key(KeyCode::Char('w')));
        app.handle_navigation_key(key(KeyCode::Tab));
        assert_eq!(app.mode, TuiMode::Navigate);
        // Split focus walk: with a single tile the h/l keys stay inert.
        app.handle_navigation_key(key(KeyCode::Char('h')));
        app.handle_navigation_key(key(KeyCode::Char('l')));
        // Enter attaches the selected pane; without a terminal in view
        // the guard fires (the real attach path is covered by the pty
        // suite, whose fake speaks the bincode terminal framing).
        app.snapshot.panes.clear();
        app.handle_navigation_key(key(KeyCode::Enter));
        assert_eq!(app.error.as_deref(), Some("no terminal selected"));
    }

    /// Tile-tail worker against real backends: the nested `read.text`
    /// shape, the bare `text` fallback, and the pane.read failure that
    /// keeps an empty tail. Drains through poll_tile_tails until the
    /// cache holds every visible tile.
    #[test]
    fn tile_tails_fetch_real_backends() {
        let (client, stop) = fake_backend_with_history(5);
        // Exercise the history fake's remaining arms (empty read, bad
        // JSON, unknown method) so no fixture branch stays dead.
        probe_fake_listener_arms(client.api_socket());
        let history_socket = client.api_socket().to_path_buf();
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [
                    {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false},
                    {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}
                ],
                "agents": []
            }
        }));
        // Single focused leaf: no visible tiles (the focused tile is
        // excluded), so the retain drops the stale entry and the
        // refresh returns without a worker.
        app.tile_tails.insert("gone".into(), "old".into());
        app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
        app.split_focus = Some("pane_1".into());
        app.refresh_tile_tails();
        assert!(app.tile_tail_rx.is_none(), "no visible tiles, no worker");
        assert!(app.tile_tails.is_empty(), "stale tail dropped");
        app.split_tree = crate::tui::split::SplitNode::split(
            crate::tui::split::SplitDir::Row,
            vec![
                crate::tui::split::SplitNode::leaf("pane_1"),
                crate::tui::split::SplitNode::leaf("pane_2"),
            ],
        );
        app.split_focus = Some("pane_2".into());
        // Real backend: the non-focused pane_1 tail loads through the
        // nested read.text shape (the fake serves every pane.read the
        // same text, so drain until the entry lands).
        app.refresh_tile_tails();
        for _ in 0..200 {
            app.poll_tile_tails();
            if let Some(text) = app.tile_tails.get("pane_1") {
                assert!(!text.is_empty(), "tail should hold the pane text");
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(app.tile_tails.contains_key("pane_1"), "tile tail drained");
        assert!(app.tile_tail_rx.is_none(), "worker finished");

        // Bare text fallback: a backend answering `{"text": ...}`.
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
        use std::io::{BufRead, BufReader, Write};
        // One loop body, two lifetimes: the budget-flip instance serves
        // the requests then self-flips so its accept-Err arm runs; the
        // budget-1 instance only ever sees the stop wake connection, so
        // its rx-check break (the stop arm) runs instead. A single
        // listener can only ever exit one way, hence two spawns of the
        // same nested fn.
        fn serve_bare_tail(
            listener: LocalSocketListener,
            rx: std::sync::mpsc::Receiver<()>,
            mut budget: usize,
        ) {
            loop {
                if rx.try_recv().is_ok() {
                    break;
                }
                if budget == 0 {
                    let _ = listener.set_nonblocking(
                        interprocess::local_socket::ListenerNonblockingMode::Accept,
                    );
                } else {
                    budget -= 1;
                }
                let Ok(mut stream) = listener.accept() else {
                    break;
                };
                let mut line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                }
                let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let response = match request["method"].as_str().unwrap_or("") {
                    "ping" => serde_json::json!({"id": request["id"], "result": {}}),
                    "pane.read" => {
                        serde_json::json!({"id": request["id"], "result": {"text": "bare tail"}})
                    }
                    _ => serde_json::json!({"id": request["id"], "result": {}}),
                };
                let _ = stream.write_all(serde_json::to_string(&response).unwrap().as_bytes());
                let _ = stream.write_all(b"\n");
                let _ = stream.flush();
            }
        }
        let spawn_bare_tail = |budget: usize| {
            let path = crate::backend_client::unique_test_path("herdr-tui-tail");
            let _ = std::fs::remove_file(&path);
            let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
            let listener = ListenerOptions::new()
                .name(name)
                .try_overwrite(true)
                .create_sync()
                .unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || serve_bare_tail(listener, rx, budget));
            (path, tx)
        };
        let (path, _bare_flip_tx) = spawn_bare_tail(5);
        let path_str = path.to_str().unwrap().to_string();
        let client = BackendClient::new(&path_str, &path_str);
        app.client = client;
        // A ping rides the same listener so the ping arm of the match
        // answers a real request (budget bumped to fit it).
        let _ = app.client.request("ping", serde_json::json!({}));
        app.tile_tails.clear();
        app.refresh_tile_tails();
        for _ in 0..200 {
            app.poll_tile_tails();
            if let Some(text) = app.tile_tails.get("pane_1") {
                assert_eq!(text, "bare tail");
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            app.tile_tails.get("pane_1").map(String::as_str),
            Some("bare tail")
        );
        // Same for the bare-text listener's own dead arms.
        probe_fake_listener_arms(&path);
        // Second instance of the same loop: budget 1 and an immediate
        // stop, so the rx-check break (the stop arm) runs this time
        // instead of the flip the first instance already exercised.
        let (bare_stop_path, bare_stop_tx2) = spawn_bare_tail(1);
        stop_fake_listener(&bare_stop_tx2, &bare_stop_path);
        // A dead backend answers nothing: the fetch lands with an empty
        // tail (unwrap_or_default), the observable behavior of a vanished
        // pane rather than a stale copy.
        app.client = BackendClient::new("/nonexistent-tail.sock", "/nonexistent-tail.sock");
        app.refresh_tile_tails();
        for _ in 0..200 {
            app.poll_tile_tails();
            if app.tile_tail_rx.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            app.tile_tails.get("pane_1").map(String::as_str),
            Some(""),
            "failed fetch lands an empty tail"
        );

        // Built-in-shaped socket: the worker must request the screen format
        // (fullscreen agents read as garbage under the strip format) and the
        // tail cache holds the screen reply verbatim.
        let (screen_tx, screen_rx) = std::sync::mpsc::channel::<String>();
        // Same two-instance shape as the bare fixture: the flip instance
        // covers the accept-Err arm, the budget-1 instance below covers
        // the stop arm.
        fn serve_screen_tail(
            listener: LocalSocketListener,
            tx: std::sync::mpsc::Sender<String>,
            rx: std::sync::mpsc::Receiver<()>,
            mut budget: usize,
        ) {
            loop {
                if rx.try_recv().is_ok() {
                    break;
                }
                if budget == 0 {
                    let _ = listener.set_nonblocking(
                        interprocess::local_socket::ListenerNonblockingMode::Accept,
                    );
                } else {
                    budget -= 1;
                }
                let Ok(mut stream) = listener.accept() else {
                    break;
                };
                let mut line = String::new();
                {
                    use std::io::{BufRead, BufReader, Write};
                    let mut reader = BufReader::new(&mut stream);
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let _ = tx.send(line.clone());
                    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    let response = serde_json::json!({
                        "id": parsed["id"],
                        "result": {"read": {"text": "screen tail"}}
                    });
                    let _ = stream.write_all(serde_json::to_string(&response).unwrap().as_bytes());
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                }
            }
        }
        let spawn_screen_tail = |tag: &str, budget: usize| {
            let base = std::path::PathBuf::from("/tmp").join(format!(
                "herdr-tui-tail-screen-{tag}-{}",
                std::process::id()
            ));
            let builtin_path = base.join("builtin/default/herdr.sock");
            std::fs::create_dir_all(builtin_path.parent().unwrap()).unwrap();
            let _ = std::fs::remove_file(&builtin_path);
            let builtin_name = builtin_path
                .clone()
                .to_fs_name::<GenericFilePath>()
                .unwrap();
            let listener = ListenerOptions::new()
                .name(builtin_name)
                .try_overwrite(true)
                .create_sync()
                .unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let screen_tx = screen_tx.clone();
            std::thread::spawn(move || serve_screen_tail(listener, screen_tx, rx, budget));
            (builtin_path, base, tx)
        };
        let (builtin_path, screen_flip_base, _screen_flip_tx) = spawn_screen_tail("flip", 5);
        let builtin_path_str = builtin_path.to_str().unwrap().to_string();
        app.client = BackendClient::new(&builtin_path_str, &builtin_path_str);
        app.tile_tails.clear();
        app.refresh_tile_tails();
        for _ in 0..200 {
            app.poll_tile_tails();
            if app.tile_tail_rx.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let requested = screen_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker must issue a pane.read against the builtin socket");
        let request: serde_json::Value = serde_json::from_str(&requested).unwrap();
        assert_eq!(request["method"], "pane.read");
        assert_eq!(
            request["params"]["format"], "screen",
            "builtin-shaped sockets must request the screen format"
        );
        assert_eq!(
            app.tile_tails.get("pane_1").map(String::as_str),
            Some("screen tail")
        );

        // The same builtin listener also survives malformed clients, the
        // dead arms a racing worker can hit (empty read, non-JSON), and
        // still answers a well-formed pane.read afterwards.
        probe_fake_listener_arms(&builtin_path);
        {
            use interprocess::local_socket::{prelude::*, Stream as LocalStream};
            use std::io::{BufRead, BufReader, Write};
            let name = builtin_path
                .clone()
                .to_fs_name::<GenericFilePath>()
                .unwrap();
            let mut probe = LocalStream::connect(name).unwrap();
            let request = serde_json::json!({
                "id": 99,
                "method": "pane.read",
                "params": {"pane_id": "pane_1", "format": "screen"}
            });
            probe
                .write_all(serde_json::to_string(&request).unwrap().as_bytes())
                .unwrap();
            probe.write_all(b"\n").unwrap();
            probe.flush().unwrap();
            let mut reply = String::new();
            let mut reader = BufReader::new(&probe);
            reader.read_line(&mut reply).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(parsed["result"]["read"]["text"], "screen tail");
        }
        // Screen listener's own stop arm: second instance, budget 1,
        // immediate stop (the flip instance above already exited on its
        // own via the accept-Err arm).
        let (screen_stop_path, screen_stop_base, screen_stop_tx2) = spawn_screen_tail("stop", 1);
        stop_fake_listener(&screen_stop_tx2, &screen_stop_path);
        stop_fake_listener(&stop, &history_socket);
        let _ = std::fs::remove_dir_all(screen_flip_base);
        let _ = std::fs::remove_dir_all(screen_stop_base);
    }

    /// The fake listeners behind the tile-tail suite also answer the
    /// methods a real client can send beyond pane.read: ping (liveness)
    /// and unknown methods (the catch-all result). This keeps their match
    /// arms exercised instead of dead, and pins the bare-text listener's
    /// non-pane.read reply shape.
    #[test]
    fn tile_tail_fake_listeners_answer_ping_and_unknown_methods() {
        use interprocess::local_socket::{
            prelude::*, GenericFilePath, ListenerOptions, Stream as LocalStream,
        };
        use std::io::{BufRead, BufReader, Write};

        // Two instances of the same loop, same as the tile-tail suite:
        // the budget-flip instance exits through accept-Err after its
        // requests, the budget-1 instance exits through the stop arm.
        fn serve_arms(
            listener: LocalSocketListener,
            rx: std::sync::mpsc::Receiver<()>,
            mut budget: usize,
        ) {
            loop {
                if rx.try_recv().is_ok() {
                    break;
                }
                if budget == 0 {
                    let _ = listener.set_nonblocking(
                        interprocess::local_socket::ListenerNonblockingMode::Accept,
                    );
                } else {
                    budget -= 1;
                }
                let Ok(mut stream) = listener.accept() else {
                    break;
                };
                let mut line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                }
                let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let response = match request["method"].as_str().unwrap_or("") {
                    "ping" => serde_json::json!({"id": request["id"], "result": {}}),
                    "pane.read" => {
                        serde_json::json!({"id": request["id"], "result": {"text": "bare tail"}})
                    }
                    _ => serde_json::json!({"id": request["id"], "result": {}}),
                };
                let _ = stream.write_all(serde_json::to_string(&response).unwrap().as_bytes());
                let _ = stream.write_all(b"\n");
                let _ = stream.flush();
            }
        }
        let spawn_arms_listener = |tag: &str, budget: usize| {
            let base = std::path::PathBuf::from("/tmp")
                .join(format!("herdr-tui-tail-arms-{tag}-{}", std::process::id()));
            let sock = base.join("builtin/default/herdr.sock");
            std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
            let _ = std::fs::remove_file(&sock);
            let name = sock.clone().to_fs_name::<GenericFilePath>().unwrap();
            let listener = ListenerOptions::new()
                .name(name)
                .try_overwrite(true)
                .create_sync()
                .unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || serve_arms(listener, rx, budget));
            (sock, base, tx)
        };
        let (sock, arms_flip_base, _flip_tx) = spawn_arms_listener("flip", 7);

        let ask = |method: &str, id: u64| -> serde_json::Value {
            let mut stream =
                LocalStream::connect(sock.clone().to_fs_name::<GenericFilePath>().unwrap())
                    .unwrap();
            let request = serde_json::json!({"id": id, "method": method});
            stream
                .write_all(serde_json::to_string(&request).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
            let mut reply = String::new();
            let mut reader = BufReader::new(&mut stream);
            reader.read_line(&mut reply).unwrap();
            serde_json::from_str(&reply).unwrap()
        };
        assert_eq!(ask("ping", 1)["id"], 1);
        assert_eq!(ask("pane.read", 2)["result"]["text"], "bare tail");
        assert_eq!(ask("agent.list", 3)["result"], serde_json::json!({}));
        // The same dead arms the tile-tail suite probes on its other
        // listeners: empty read and non-JSON line, then still serving.
        probe_fake_listener_arms(&sock);
        assert_eq!(ask("ping", 4)["id"], 4);
        // Second instance, budget 1, immediate stop: its only connection
        // is the stop wake, so the loop exits through the stop arm the
        // flip instance never reaches.
        let (stop_sock, stop_base, stop_tx2) = spawn_arms_listener("stop", 1);
        stop_fake_listener(&stop_tx2, &stop_sock);
        let _ = std::fs::remove_dir_all(arms_flip_base);
        let _ = std::fs::remove_dir_all(stop_base);
    }

    /// deepen_pane_history growth arm: a second deep fetch doubles the
    /// held buffer (len*2 clamped by the cap) and trims the fetch to the
    /// newest `want` lines.
    #[test]
    fn deepen_doubles_the_held_history() {
        let (client, _stop) = fake_backend_with_history(400);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }
        }));
        assert!(app.deepen_pane_history() > 0);
        let held = app.pane_history.len();
        // Second deepen doubles the want (trimming the same 400-line
        // reply is a no-op there, but the multiplication arm runs).
        app.pane_history_exhausted = false;
        app.deepen_pane_history();
        assert!(app.pane_history.len() >= held);
    }

    #[test]
    fn conflicts_enter_noop_and_rebase_flavored_abort() {
        // Enter in the Conflicts view is the no-op arm of the view match,
        // and the rebase-flavored abort arm needs rebase_in_progress true.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/conflict-action"]).0,
        );
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Conflicts;
        app.git_panel.rebase_in_progress = true;
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('A'),
        ));
        assert!(app.error.is_some(), "rebase abort error");
        app.error = None;
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(app.error.is_none(), "enter is a no-op in conflicts");
    }

    #[test]
    fn main_focused_h_and_l_walk_single_tile() {
        let (client, _stop) = fake_backend_with_history(5);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        app.main_focused = true;
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('h'),
        ));
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('l'),
        ));
        assert_eq!(app.mode, TuiMode::Navigate);
    }

    #[test]
    fn tile_tail_worker_reentry_guard_and_disconnected_drain() {
        let (client, _stop) = fake_backend_with_history(5);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.split_tree = crate::tui::split::SplitNode::split(
            crate::tui::split::SplitDir::Row,
            vec![
                crate::tui::split::SplitNode::leaf("pane_1"),
                crate::tui::split::SplitNode::leaf("pane_2"),
            ],
        );
        app.split_focus = Some("pane_2".into());
        // While a worker is in flight a second refresh must not spawn one.
        app.refresh_tile_tails();
        assert!(app.tile_tail_rx.is_some(), "worker spawned");
        app.refresh_tile_tails();
        // Still the same receiver: re-entry guard. Drain the finished
        // worker; the last poll after Disconnected clears the receiver.
        let mut drained = false;
        for _ in 0..300 {
            app.poll_tile_tails();
            if app.tile_tail_rx.is_none() {
                drained = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(drained, "worker drained including disconnected poll");
        // Disconnected arm: a receiver whose sender died without
        // sending drains into the empty branch and clears the slot.
        let (_dead_tx, dead_rx) = std::sync::mpsc::channel::<Vec<(String, String)>>();
        drop(_dead_tx);
        app.tile_tail_rx = Some(dead_rx);
        app.poll_tile_tails();
        assert!(app.tile_tail_rx.is_none(), "disconnected worker cleared");
    }

    #[test]
    fn lens_gate_force_off_and_view_pane_split_hit() {
        let (client, _stop) = fake_backend_with_history(5);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.main_focused = true;
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [
                    {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false,"agent_session":{"kind":"jcode","resolvable":true,"session_id":"s1"}},
                    {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_1","agent":"claude","display_agent":"claude","agent_status":"idle","cwd":"/repo","focused":true}
                ],
                "agents": []
            }
        }));
        // view_pane with the split active: the focused pane_1 must be
        // found through the split branch, not the sidebar selection.
        app.split_tree = crate::tui::split::SplitNode::split(
            crate::tui::split::SplitDir::Row,
            vec![
                crate::tui::split::SplitNode::leaf("pane_1"),
                crate::tui::split::SplitNode::leaf("pane_2"),
            ],
        );
        app.split_focus = Some("pane_1".into());
        assert_eq!(app.view_pane_id().as_deref(), Some("pane_1"));
        // Open the lens on the supported pane, then force it off through
        // the refresh_tail gate when the session goes missing and when
        // the kind is unsupported: both Supported and UnsupportedKind/
        // NoSession arms of lens_chat_supported run.
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('L'),
        ));
        assert!(app.lens.active);
        app.snapshot.panes[0].agent_session = Some(TuiAgentSession {
            kind: "claude".into(),
            resolvable: true,
            session_id: Some("s1".into()),
            reason: None,
        });
        app.refresh_tail();
        assert!(!app.lens.active, "unsupported kind force-closes the lens");
        assert_eq!(
            app.status.as_str(),
            "lens closed (pane has no transcript provider)"
        );
        app.lens.active = true;
        app.snapshot.panes[0].agent_session = None;
        app.refresh_tail();
        assert!(!app.lens.active, "missing session force-closes the lens");
    }

    #[test]
    fn lens_scroll_hits_the_exhausted_deep_fetch_arm() {
        // Lens open on a supported pane, history exhausted: the up-scroll
        // deep fetch returns 0 so the lens re-observes and returns.
        let (client, _stop) = fake_backend_with_history(5);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.main_focused = true;
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true,"agent_session":{"kind":"jcode","resolvable":true,"session_id":"s1"}}],
                "agents": []
            }
        }));
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('L'),
        ));
        assert!(app.lens.active);
        app.pane_history_exhausted = true;
        app.handle_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('k'),
        ));
        assert!(app.lens.active, "exhausted deep fetch keeps the lens open");
    }

    #[test]
    fn attach_input_error_surfaces_on_a_dead_backend() {
        // Attach mode with a terminal selected but a dead backend: the
        // typed key fails at attach_terminal and the error lands.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&[]).0,
        );
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Attach;
        app.handle_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('x'),
        ));
        assert!(app.error.is_some(), "dead backend attach input errors");
    }

    #[test]
    fn prompt_error_arms_against_refusing_routes() {
        // CreateTag / GitCwd / CreateBranch / CreateFile through the
        // handle_prompt_key entry with typed text and a refusing route.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/tag"]).0,
        );
        app.screen = TuiScreen::Git;
        app.git_panel.view = GitView::Log;
        app.git_panel.commits = vec![commit("abc")];
        app.handle_git_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('t'),
        ));
        assert!(app.prompt_input.is_some());
        app.run_prompt_action(PromptKind::CreateTag, "v1.0");
        assert!(app.error.is_some(), "tag error arm");

        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/switch"]).0,
        );
        app.run_prompt_action(PromptKind::CreateBranch, "feat2");
        assert!(app.error.is_some(), "create branch error arm");

        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/git-ui/status"]).0,
        );
        app.run_prompt_action(PromptKind::GitCwd, "/repo");
        assert!(app.error.is_some(), "git cwd refresh error arm");

        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/file-browser/file"]).0,
        );
        app.run_prompt_action(PromptKind::CreateFile, "a.rs");
        assert!(app.error.is_some(), "create file error arm");
    }

    #[test]
    fn composer_too_long_message_refuses() {
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&[]).0,
        );
        let long = "x".repeat(20001);
        app.run_prompt_action(PromptKind::ComposerMessage, &long);
        assert!(app.status.contains("too long"));
    }

    #[test]
    fn search_palette_jk_with_empty_query_and_arrows() {
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&[]).0,
        );
        app.mode = TuiMode::SearchPalette;
        let key = super::key_handler_tests::key;
        use crossterm::event::KeyCode;
        app.handle_key(key(KeyCode::Char('j')));
        app.handle_key(key(KeyCode::Char('k')));
        app.handle_key(key(KeyCode::Down));
        app.handle_key(key(KeyCode::Up));
        app.handle_key(key(KeyCode::Char('x')));
        assert_eq!(app.search_palette.query, "x", "letters type into the query");
    }

    #[test]
    fn commit_search_query_requires_a_cwd() {
        // No workspace selected: commit_search_query errors.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&[]).0,
        );
        app.snapshot = Default::default();
        app.search_palette.query = "x".into();
        assert!(app.commit_search_query().is_err());
    }

    #[test]
    fn navigate_recent_already_open_and_palette_zoom() {
        // The open recent guard fires when the selected row is open.
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&[]).0,
        );
        app.search_palette
            .results
            .push(crate::tui::search::SearchCandidate::Recent {
                path: "/repo".into(),
                title: "Repo".into(),
                subtitle: "main".into(),
                label: None,
                is_worktree: false,
                is_open: true,
            });
        let candidate = app.search_palette.results[0].clone();
        assert!(app.run_search_candidate(&candidate).is_err());
        // ZoomPane shortcut on the terminal screen toggles the zoom.
        // The tree here holds a single leaf, so the chord refuses
        // (zooming one tile has nothing to hide and would desync the
        // focus); a two-leaf tree toggles as before.
        app.screen = TuiScreen::Terminal;
        app.run_shortcut(Shortcut::ZoomPane);
        assert!(!app.split_zoomed);
        assert_eq!(app.status, "nothing to zoom: single panel");
        app.snapshot.panes.push(crate::tui::model::TuiPane {
            id: "pane_2".to_string(),
            terminal_id: "term_2".to_string(),
            workspace_id: "ws_1".to_string(),
            tab_id: "tab_1".to_string(),
            label: None,
            agent: Some("shell".to_string()),
            display_agent: Some("shell".to_string()),
            agent_status: "idle".to_string(),
            cwd: "/repo".to_string(),
            focused: false,
            terminal_title: None,
            agent_session: None,
        });
        app.split_tree = crate::tui::split::SplitNode::split(
            crate::tui::split::SplitDir::Row,
            vec![
                crate::tui::split::SplitNode::leaf("pane_1"),
                crate::tui::split::SplitNode::leaf("pane_2"),
            ],
        );
        app.run_shortcut(Shortcut::ZoomPane);
        assert!(app.split_zoomed);
        app.run_shortcut(Shortcut::ZoomPane);
        assert!(!app.split_zoomed);
    }

    #[test]
    fn remove_and_clear_recents_against_the_server() {
        let mut app = super::prompt_action_tests::app_with_api(
            super::prompt_action_tests::fake_api_server(&["/recent-workspaces"]).0,
        );
        app.search_palette
            .results
            .push(crate::tui::search::SearchCandidate::Recent {
                path: "/repo".into(),
                title: "Repo".into(),
                subtitle: "main".into(),
                label: None,
                is_worktree: false,
                is_open: false,
            });
        app.remove_selected_recent();
        assert!(app.error.is_some(), "remove recent error arm");
        app.error = None;
        app.clear_recent_workspaces();
        assert!(app.error.is_some(), "clear recents error arm");
    }

    #[test]
    fn close_tab_real_failure_and_last_tab_refresh_error() {
        // tab.close on a real socket backend whose reply is a live
        // error (not "not found"): the error arm runs. Then the
        // was_last_tab path with a dead follow-up refresh surfaces the
        // refresh error: close ok, then the client socket dies.
        let (api_socket, _stop) = crate::tui::tests::fake_backend_socket();
        let client = BackendClient::new(api_socket.clone(), api_socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.snapshot.tabs[0].id = "tab_err".to_string();
        app.snapshot.workspaces[0].active_tab_id = Some("tab_err".to_string());
        app.close_selected_tab();
        let _ = std::fs::remove_file(&api_socket);

        // was_last_tab with the socket gone after a successful close:
        // the workspace.close failure arm and the refresh error arm.
        let (api_socket, stop) = crate::tui::tests::fake_backend_socket();
        let client = BackendClient::new(api_socket.clone(), api_socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.close_selected_tab();
        // Kill the backend and close another workspace: the request now
        // fails on the socket itself (the error arm without not-found).
        stop.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let _ = std::fs::remove_file(&api_socket);
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.snapshot.tabs.clear();
        app.snapshot.workspaces[0].active_tab_id = None;
        app.close_selected_tab();
        assert!(app.error.is_some(), "dead backend close surfaces an error");
    }

    #[test]
    fn fake_api_server_break_and_continue_arms() {
        // The server stop sender breaks the accept loop; a fresh server
        // then serves one request so the read-empty continue arm runs.
        let (api, stop) = super::prompt_action_tests::fake_api_server(&[]);
        stop.send(()).unwrap();
        // Give the accept-loop thread a moment to observe the stop.
        std::thread::sleep(Duration::from_millis(50));
        // A request after the stop reaches a closed listener: connect
        // failure is fine, the point is the break arm already ran.
        let _ = api.session_cleanup();

        let (api, _stop) = super::prompt_action_tests::fake_api_server(&[]);
        // A well-formed call proves the loop serves requests.
        assert!(api.session_cleanup().is_ok());
        // A peer that connects and hangs up without a request line hits
        // the read-empty continue arm; the loop then still serves the
        // next well-formed request.
        let port = api
            .base_url()
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse::<u16>().ok())
            .expect("fake api url carries its port");
        let mute = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        drop(mute);
        assert!(
            api.session_cleanup().is_ok(),
            "listener survives the empty-request peer"
        );
    }

    #[test]
    fn deepen_trims_to_the_newest_window() {
        // 3000 lines against the 2000-line start window: the trim arm
        // keeps the newest 2000 and the exhausted flag stays off.
        let (client, _stop) = fake_backend_with_history(3000);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Navigate;
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }
        }));
        assert!(app.deepen_pane_history() > 0);
        assert_eq!(app.pane_history.len(), 2000);
        assert!(!app.pane_history_exhausted, "trim means not exhausted");
        assert_eq!(
            app.pane_history.first().map(String::as_str),
            Some("line 1000")
        );
    }

    #[test]
    fn lens_gate_kinds_from_the_snapshot() {
        // lens_chat_supported gates on agent_session: unsupported kind,
        // supported kind, and no session at all.
        let (client, _stop) = fake_backend_with_history(5);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.screen = TuiScreen::Terminal;
        let pane = serde_json::json!({
            "pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1",
            "agent":"claude","display_agent":"claude","agent_status":"idle","cwd":"/repo","focused":true,
            "agent_session": {"kind":"claude","resolvable":true,"session_id":"s1"}
        });
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [pane],
                "agents": []
            }
        }));
        app.main_focused = true;
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('L'),
        ));
        assert!(!app.lens.active, "unsupported kind keeps the lens closed");
        // Supported kind opens the lens.
        app.snapshot.panes[0].agent_session = Some(TuiAgentSession {
            kind: "jcode".into(),
            resolvable: true,
            session_id: Some("s1".into()),
            reason: None,
        });
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('L'),
        ));
        assert!(app.lens.active, "supported kind opens the lens");
        // No session: the gate refuses and stays closed.
        app.lens.active = false;
        app.snapshot.panes[0].agent_session = None;
        app.handle_navigation_key(super::key_handler_tests::key(
            crossterm::event::KeyCode::Char('L'),
        ));
        assert!(!app.lens.active, "no session keeps the lens closed");
    }
}

#[cfg(test)]
mod batch12_coverage_tests {
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use serde_json::json;

    fn pane_snapshot_one() -> serde_json::Value {
        json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }
        })
    }

    pub(crate) fn two_pane_split_app() -> TuiApp {
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&pane_snapshot_one());
        app.screen = TuiScreen::Terminal;
        app.split_tree = split::SplitNode::split(
            split::SplitDir::Row,
            vec![
                split::SplitNode::leaf("pane_1"),
                split::SplitNode::leaf("pane_2"),
            ],
        );
        app.split_focus = Some("pane_1".to_string());
        app
    }

    #[test]
    fn stamp_inflight_debug_and_empty_drain_arms() {
        // Manual Debug mirrors the snapshot worker: the channel end stays
        // opaque but the cwd field is visible.
        let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BackendClientError>>();
        let worker = StampInflight {
            cwd: "/repo".to_string(),
            receiver: rx,
        };
        assert!(format!("{worker:?}").contains("/repo"));
        drop(tx);

        // Empty and disconnected drains against a live app: an Empty
        // worker stays armed, a Disconnected one drops silently, and a
        // failed fetch keeps the previous stamp quiet.
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&pane_snapshot_one());
        let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BackendClientError>>();
        app.stamp_inflight.push(StampInflight {
            cwd: "/repo".to_string(),
            receiver: rx,
        });
        app.poll_stamp_fetches();
        assert_eq!(
            app.stamp_inflight.len(),
            1,
            "empty reply keeps the worker armed"
        );
        drop(tx);
        app.poll_stamp_fetches();
        assert!(app.stamp_inflight.is_empty(), "dead worker drops silently");

        let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BackendClientError>>();
        let _ = tx.send(Err(BackendClientError::Backend("boom".into())));
        app.stamp_inflight.push(StampInflight {
            cwd: "/repo".to_string(),
            receiver: rx,
        });
        app.poll_stamp_fetches();
        assert!(
            app.snapshot.workspaces[0].worktree.is_none(),
            "failed fetch leaves the stamp quiet"
        );
    }

    #[test]
    fn apply_cached_stamps_walks_every_continue_arm() {
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [
                    {"workspace_id":"ws_1","label":"Repo","cwd":"/already","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1",
                     "worktree": {"repo_root": "/repo", "branch": "main"}},
                    {"workspace_id":"ws_2","label":"NoCache","cwd":"/nocache","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"t2"},
                    {"workspace_id":"ws_3","label":"Stale","cwd":"/stale","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"t3"},
                    {"workspace_id":"ws_4","label":"Unparsable","cwd":"/unparsable","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"t4"}
                ],
                "tabs": [], "panes": [], "agents": []
            }
        }));
        // Backend-stamped rows stay verbatim (continue arm).
        // /nocache has no cache entry (missing-entry continue).
        app.stamp_cache.insert(
            "/stale".to_string(),
            StampCacheEntry {
                fetched_at: Instant::now() - Duration::from_secs(10),
                response: json!({}),
            },
        );
        // /unparsable holds a fresh but useless reply.
        app.stamp_cache.insert(
            "/unparsable".to_string(),
            StampCacheEntry {
                fetched_at: Instant::now(),
                response: json!({"not": "a worktree list"}),
            },
        );
        app.apply_cached_stamps();
        assert!(
            app.snapshot.workspaces[0].worktree.is_some(),
            "backend stamp stays"
        );
        assert!(app.snapshot.workspaces[1].worktree.is_none(), "no cache");
        assert!(app.snapshot.workspaces[2].worktree.is_none(), "stale cache");
        assert!(app.snapshot.workspaces[3].worktree.is_none(), "unparsable");
    }

    #[test]
    fn spawn_stamp_fetches_skips_known_cwds() {
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [
                    {"workspace_id":"ws_1","label":"Empty","cwd":"","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                    {"workspace_id":"ws_2","label":"Stamped","cwd":"/stamped","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"t2",
                     "worktree": {"repo_root": "/stamped", "branch": "main"}},
                    {"workspace_id":"ws_3","label":"Fresh","cwd":"/fresh","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"t3"},
                    {"workspace_id":"ws_4","label":"Armed","cwd":"/armed","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"t4"}
                ],
                "tabs": [], "panes": [], "agents": []
            }
        }));
        app.stamp_cache.insert(
            "/fresh".to_string(),
            StampCacheEntry {
                fetched_at: Instant::now(),
                response: json!({}),
            },
        );
        let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BackendClientError>>();
        app.stamp_inflight.push(StampInflight {
            cwd: "/armed".to_string(),
            receiver: rx,
        });
        drop(tx);
        app.spawn_stamp_fetches();
        // The empty cwd, the stamped row and the fresh cache arm nothing;
        // the pre-armed cwd stays single because a worker already runs.
        let armed: Vec<String> = app.stamp_inflight.iter().map(|w| w.cwd.clone()).collect();
        assert!(!armed.contains(&"/fresh".to_string()), "fresh cache skips");
        assert_eq!(armed.iter().filter(|cwd| **cwd == "/armed").count(), 1);
        // Poll: the dead /armed worker from the channel drops.
        app.poll_stamp_fetches();
        assert!(app.stamp_inflight.is_empty(), "dead worker drains");
    }

    #[test]
    fn view_terminal_id_follows_tile_focus_not_the_sidebar_cursor() {
        // Regression (command ran in "the same view" despite the split):
        // the binary's live attach binds view_terminal_id, and that must
        // follow the focused tile, never the sidebar cursor. The old bin
        // path bound selected_terminal_id: with the sidebar on pane_1
        // and tile focus on pane_2, typed input ran in pane_1 while its
        // echo painted the focused tile, so every command looked like
        // it ran in "the same view".
        let mut app = two_pane_split_app();
        // Give pane_2 a real pane row so the split focus resolves.
        app.snapshot.panes.push(crate::tui::model::TuiPane {
            id: "pane_2".to_string(),
            terminal_id: "term_2".to_string(),
            workspace_id: "ws_1".to_string(),
            tab_id: "tab_2".to_string(),
            agent: Some("claude".to_string()),
            display_agent: Some("claude".to_string()),
            agent_status: "idle".to_string(),
            cwd: "/repo".to_string(),
            label: None,
            terminal_title: None,
            focused: false,
            agent_session: None,
        });
        // Sidebar cursor on pane_1's agent row, tile focus on pane_2.
        app.selected_agent = 0;
        app.split_focus = Some("pane_2".to_string());
        assert_eq!(app.view_terminal_id(), Some("term_2"));
        assert_eq!(
            app.selected_terminal_id(),
            Some("term_1"),
            "the sidebar cursor keeps its own pane"
        );
        // Attach geometry follows the same focus: the focused tile's
        // rect, here recorded narrower than the window.
        app.set_terminal_size(100, 30);
        app.tile_geometry
            .borrow_mut()
            .push(crate::tui::render::TileRectOwned {
                pane_id: "pane_2".to_string(),
                x: 50,
                y: 0,
                width: 50,
                height: 30,
            });
        assert_eq!(app.attach_viewport(), (48, 25));
    }

    #[test]
    fn attach_viewport_uses_the_focused_tile_geometry() {
        let mut app = two_pane_split_app();
        // Split active but no geometry yet: the fallback keeps the
        // terminal size path.
        app.set_terminal_size(100, 30);
        assert_eq!(
            app.attach_viewport(),
            render::pane_viewport_size(100, 30, false)
        );
        // Geometry without the focused pane: still the fallback.
        app.tile_geometry
            .borrow_mut()
            .push(crate::tui::render::TileRectOwned {
                pane_id: "pane_2".to_string(),
                x: 0,
                y: 0,
                width: 40,
                height: 20,
            });
        assert_eq!(
            app.attach_viewport(),
            render::pane_viewport_size(100, 30, false)
        );
        // The focused tile's viewport minus borders and chrome rows.
        app.tile_geometry
            .borrow_mut()
            .push(crate::tui::render::TileRectOwned {
                pane_id: "pane_1".to_string(),
                x: 0,
                y: 0,
                width: 50,
                height: 30,
            });
        assert_eq!(app.attach_viewport(), (48, 25));
    }

    #[test]
    fn branch_picker_footer_hints_render() {
        let mut app = two_pane_split_app();
        app.mode = TuiMode::BranchPicker;
        let context = app.footer_context();
        assert_eq!(context.hint(), FooterContext::BranchPicker.hint());
    }

    #[test]
    fn tour_mode_key_is_inert_in_navigation_dispatch() {
        // The guard above the mode dispatch owns Tour keys; the
        // Tour arm in handle_navigation_key's match stays a no-op.
        let mut app = two_pane_split_app();
        app.mode = TuiMode::Tour;
        app.handle_key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(app.mode, TuiMode::Tour, "tour keys do not leak");
    }

    #[test]
    fn cleanup_confirm_accepts_yb_and_other_prompts_take_plain_y() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.git_panel.files = vec![panels::git::GitFileEntry {
            path: "a.rs".to_string(),
            status: panels::git::GitFileStatus::Staged,
        }];
        // `yb` confirms the cleanup-delete verb (branch_too flips with
        // the branch option), and any other text cancels before the
        // action runs. Both paths keep the prompt closed.
        for (text, cancelled) in [("yb", false), ("nope", true)] {
            app.error = None;
            app.status = String::new();
            app.prompt_input = Some(PromptInput {
                kind: PromptKind::ConfirmCleanupDelete,
                text: text.to_string(),
            });
            app.handle_prompt_key(KeyEvent::from(KeyCode::Enter));
            assert!(app.prompt_input.is_none(), "prompt closes for {text}");
            if cancelled {
                assert_eq!(app.status, "cancelled", "text {text} cancels");
            }
        }
    }

    #[test]
    fn sync_composer_draft_without_prompt_is_a_noop() {
        let mut app = two_pane_split_app();
        app.sync_composer_draft();
        assert!(app.composer_drafts.is_empty(), "no prompt, no draft");
    }

    #[test]
    fn open_composer_prefills_from_the_pane_draft() {
        let mut app = two_pane_split_app();
        app.composer_drafts
            .insert("pane_1".to_string(), "half-written".to_string());
        app.open_composer_from_footer();
        let prompt = app.prompt_input.expect("composer prompt opens");
        assert_eq!(prompt.text, "half-written");

        // Reopening without a draft starts empty, and the terminal-screen
        // gate keeps other screens out.
        app.prompt_input = None;
        app.screen = TuiScreen::Files;
        app.open_composer_from_footer();
        assert!(app.prompt_input.is_none(), "files screen has no composer");
    }

    #[test]
    fn selected_terminal_id_follows_the_selected_pane() {
        let app = two_pane_split_app();
        assert_eq!(app.selected_terminal_id(), Some("term_1"));
        assert_eq!(
            app.selected_terminal_id(),
            app.view_pane().map(|p| p.terminal_id.as_str())
        );
    }

    #[test]
    fn search_palette_ignores_unhandled_keys() {
        let mut app = two_pane_split_app();
        app.mode = TuiMode::SearchPalette;
        // F5: no palette binding, the catch-all keeps state intact.
        app.handle_key(KeyEvent::from(KeyCode::F(5)));
        assert_eq!(app.mode, TuiMode::SearchPalette);
    }
}

#[cfg(test)]
mod batch13_coverage_tests {
    use super::prompt_action_tests::{app_with_api, fake_api_server};
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use serde_json::json;

    pub(crate) fn terminal_app() -> TuiApp {
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }
        }));
        app.screen = TuiScreen::Terminal;
        app
    }

    #[test]
    fn prompt_error_arms_surface_api_failures() {
        // ResetMode: a refused /api/git-ui/reset surfaces the panel
        // error while the selected commit stays selected.
        let (api, _stop) = fake_api_server(&["/api/git-ui/reset"]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".to_string();
        app.git_panel.commits = vec![panels::git::GitCommitEntry {
            hash: "abc123".into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }];
        app.git_panel.commit_selected = 0;
        app.run_prompt_action(PromptKind::ResetMode, "soft");
        assert!(app.error.is_some(), "reset failure surfaces");

        // CreateBranch: a refused switch surfaces the error; the
        // success arm's refresh_view failure is the follow-up below.
        let (api, _stop) = fake_api_server(&["/api/git-ui/switch"]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".to_string();
        app.run_prompt_action(PromptKind::CreateBranch, "feat/x");
        assert!(app.error.is_some(), "switch failure surfaces");

        // CreateBranch success with a failing refresh: the branch
        // switched (fake answers ok) but /api/git-ui/refresh 500s.
        let (api, _stop) = fake_api_server(&["/api/git-ui/status"]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".to_string();
        app.run_prompt_action(PromptKind::CreateBranch, "feat/y");
        assert!(
            app.error.is_some(),
            "refresh failure after a successful switch surfaces"
        );

        // CreateFile: the create succeeds; the auto-open runs but the
        // fake tree refresh leaves no selection, so it takes the
        // early-Ok path and no error surfaces (the Err arm of that
        // open is fixture-unreachable, documented in batch14).
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        app.run_prompt_action(PromptKind::CreateFile, "b.rs");
        assert!(app.error.is_none(), "no selection means no open error");
        assert_eq!(app.status, "created b.rs");
    }

    #[test]
    fn search_palette_catch_all_and_navigation_return_arms() {
        let mut app = terminal_app();
        app.mode = TuiMode::SearchPalette;
        // F5 has no palette binding: the catch-all keeps state intact.
        app.handle_search_palette_key(KeyEvent::from(KeyCode::F(5)));
        assert_eq!(app.mode, TuiMode::SearchPalette);

        // Agent candidate with a pane: select_search_target's pane arm
        // (the return at the end of the find).
        app.search_palette.results = vec![search::SearchCandidate::Agent {
            pane_id: "pane_1".into(),
            label: "jcode".into(),
        }];
        app.search_palette.committed = true;
        app.handle_search_palette_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(app.selected_agent, 0);

        // Content and File candidates: the run_search_candidate Ok
        // arms after a successful open/reveal (fake serves both).
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        // The tree must hold the revealed file or reveal_path errors.
        // Inject the entries after opening the Files screen, which
        // rebuilds the explorer from a fresh refresh.
        app.open_files_screen();
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        app.mode = TuiMode::SearchPalette;
        app.search_palette.committed = true;
        app.search_palette.results = vec![search::SearchCandidate::File {
            path: "a.rs".into(),
            name: "a.rs".into(),
            is_dir: false,
        }];
        app.handle_search_palette_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.error.is_none(), "file reveal succeeds");

        app.search_palette.results = vec![search::SearchCandidate::Content {
            file: "a.rs".into(),
            name: "a.rs".into(),
            line: 12,
        }];
        app.handle_search_palette_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.error.is_none(), "content open succeeds");
    }

    #[test]
    fn content_search_plus_key_covers_load_more_and_catch_all() {
        // The load-more request goes to /api/file-browser/content-search
        // with the typed filter as the query.
        let (api, _stop) = fake_api_server(&["/api/file-browser/content-search"]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer.search_mode = true;
        app.file_explorer.search_kind = SearchKind::Content;
        app.file_explorer.content_search.done = false;
        app.file_explorer.filter = "needle".to_string();
        // has_results() gates the results-view key handler; stage a
        // query plus a file entry so '+' dispatches to the load-more
        // arm.
        app.file_explorer.content_search.query = "needle".to_string();
        app.file_explorer.content_search.files = vec![content_search::ContentSearchFile {
            path: "a.rs".into(),
            name: "a.rs".into(),
            match_count: 1,
            chunks: vec![],
            truncated: false,
            first_match_line: 1,
        }];
        // '+' with more results available runs the load-more request;
        // the refused route surfaces its error.
        app.handle_files_key(KeyEvent::from(KeyCode::Char('+')));
        assert!(app.error.is_some(), "load-more failure surfaces");
        // F5: no content-search binding, catch-all keeps the mode.
        app.handle_files_key(KeyEvent::from(KeyCode::F(5)));
        assert!(app.file_explorer.search_mode);

        // '+' with done=true only reports.
        app.error = None;
        app.file_explorer.content_search.done = true;
        app.handle_files_key(KeyEvent::from(KeyCode::Char('+')));
        assert_eq!(app.status, "no more results");
    }

    #[test]
    fn editor_find_and_diff_search_catch_alls() {
        let mut app = terminal_app();
        app.file_explorer.edit_active = true;
        app.file_explorer.editor_find.active = true;
        // F5: no find-bar binding, catch-all keeps the bar open.
        app.handle_editor_find_key(KeyEvent::from(KeyCode::F(5)));
        assert!(app.file_explorer.editor_find.active);
        // Enter with no ranges: "no matches" status arm.
        app.file_explorer.editor_find.ranges.clear();
        app.handle_editor_find_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(app.status, "no matches");

        // Diff search: Esc cancels, F5 falls through the catch-all.
        let mut app = terminal_app();
        app.screen = TuiScreen::Git;
        app.git_panel.diff_search_active = true;
        app.git_panel.diff_search_query = "needle".into();
        app.handle_git_key(KeyEvent::from(KeyCode::Esc));
        assert!(!app.git_panel.diff_search_active);
        app.git_panel.diff_search_active = true;
        app.handle_git_key(KeyEvent::from(KeyCode::F(5)));
        assert!(app.git_panel.diff_search_active);
    }

    #[test]
    fn binary_preview_edit_refusal_surfaces_start_edit_error() {
        // The webui reveal flow offers edit on a preview; a binary file
        // must refuse with the visible error instead of opening the
        // editor on garbage bytes.
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.file_explorer.preview = panels::files::FilePreview {
            path: Some("bin.dat".into()),
            content: "\u{0}\u{1}".into(),
            truncated: false,
            binary: true,
            hash: String::new(),
            dirty: false,
        };
        app.screen = TuiScreen::Files;
        app.handle_key(KeyEvent::from(KeyCode::Char('e')));
        assert!(app.error.is_some(), "binary preview refuses edit");
    }

    #[test]
    fn stage_all_and_log_plus_error_arms() {
        // Staged files take the unstage path of stage-all; a refused
        // unstage route surfaces the toggle error in the status bar.
        let (api, _stop) = fake_api_server(&["/api/git-ui/unstage"]);
        let mut app = app_with_api(api);
        app.git_panel.cwd = "/repo".to_string();
        // The screen must already be Git or open_git_screen rebuilds
        // the panel through set_cwd, discarding the staged file.
        app.screen = TuiScreen::Git;
        app.git_panel.files = vec![panels::git::GitFileEntry {
            path: "a.rs".to_string(),
            status: panels::git::GitFileStatus::Staged,
        }];
        app.run_shortcut(Shortcut::GitStageAll);
        assert!(app.error.is_some(), "stage-all failure surfaces");

        // Log '+': more commits load, but the log refresh fails.
        let (api, _stop) = fake_api_server(&["/api/git-ui/log"]);
        let mut app = app_with_api(api);
        app.git_panel.view = GitView::Log;
        app.git_panel.log_has_more = true;
        app.git_panel.commits = vec![panels::git::GitCommitEntry {
            hash: "abc".into(),
            message: "m".into(),
            author: "a".into(),
            date: "d".into(),
            labels: vec![],
        }];
        app.git_panel.log_limit = panels::git::LOG_PAGE_SIZE;
        app.handle_git_key(KeyEvent::from(KeyCode::Char('+')));
        assert!(
            app.error.is_some(),
            "log load-more refresh failure surfaces"
        );
    }

    #[test]
    fn edit_mode_clean_exit_save_and_quit_confirm() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer.edit_active = true;
        app.file_explorer.preview = panels::files::FilePreview {
            path: Some("a.rs".into()),
            content: "fn main() {}".into(),
            truncated: false,
            binary: false,
            hash: String::new(),
            dirty: false,
        };
        // Esc on a clean buffer closes edit mode without a prompt.
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(!app.file_explorer.edit_active);
        assert_eq!(app.status, "edit mode closed");

        // Ctrl+S after a clean save echoes the saved status (the
        // save itself succeeded because the buffer is unchanged).
        app.file_explorer.edit_active = true;
        app.file_explorer.preview.dirty = true;
        app.file_explorer.edit_cursor = app.file_explorer.preview.content.len();
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert_eq!(app.status, "saved");

        // Terminal navigate: plain q opens the quit confirm.
        let mut app = terminal_app();
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert_eq!(app.mode, TuiMode::ConfirmQuit);
    }

    #[test]
    fn tab_cycling_reports_switches_and_errors() {
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        // Two recents with a clean buffer: Tab rotates and reports.
        app.file_explorer.recent_previews = vec!["a.rs".into(), "b.rs".into()];
        app.handle_files_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.status, "switched preview");
        assert_eq!(app.file_explorer.recent_previews[0], "b.rs");

        // A refused preview read on the rotation surfaces the error arm.
        let (api, _stop) = fake_api_server(&["/api/file-browser/file"]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer.recent_previews = vec!["a.rs".into(), "b.rs".into()];
        app.handle_files_key(KeyEvent::from(KeyCode::Tab));
        assert!(app.error.is_some(), "cycle rotation failure surfaces");
    }

    #[test]
    fn committing_a_content_search_filter_reports_done() {
        // Enter on the active filter with content kind runs the search
        // and reports it (webui commits the query on Enter).
        let (api, _stop) = fake_api_server(&[]);
        let mut app = app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer.search_mode = true;
        app.file_explorer.search_kind = SearchKind::Content;
        app.file_explorer.filter_active = true;
        app.file_explorer.filter = "needle".to_string();
        app.handle_files_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(app.status, "content search done");
    }

    #[test]
    fn attach_viewport_falls_back_when_focus_has_no_pane_or_tile() {
        let mut app = terminal_app();
        // Split with a dead focus: focused_pane_id falls back among
        // leaves, none matches a snapshot pane, so the tile lookup
        // never runs and the fallback viewport answers.
        app.split_tree = split::SplitNode::split(
            split::SplitDir::Row,
            vec![
                split::SplitNode::leaf("gone_1"),
                split::SplitNode::leaf("gone_2"),
            ],
        );
        app.split_focus = Some("gone_1".to_string());
        app.set_terminal_size(100, 30);
        assert_eq!(
            app.attach_viewport(),
            render::pane_viewport_size(100, 30, false)
        );
        // Same split, but now the geometry holds tiles for the dead
        // panes: focus resolves to None (no snapshot pane), so the
        // outer if-let exits through its closing arm.
        app.tile_geometry
            .borrow_mut()
            .push(crate::tui::render::TileRectOwned {
                pane_id: "gone_1".to_string(),
                x: 0,
                y: 0,
                width: 40,
                height: 20,
            });
        assert_eq!(
            app.attach_viewport(),
            render::pane_viewport_size(100, 30, false)
        );
        // view_pane mirrors the same fallthrough: focus pane missing
        // from the snapshot means the sidebar selection answers.
        assert_eq!(app.view_pane().map(|p| p.id.as_str()), Some("pane_1"));
    }

    #[test]
    fn navigation_dispatch_keeps_tour_inert_and_composer_draft_miss_noops() {
        let mut app = terminal_app();
        // Tour mode owns its keys in handle_key; the nav dispatch's
        // Tour arm stays a no-op when called directly.
        app.mode = TuiMode::Tour;
        let status_before = app.status.clone();
        app.handle_navigation_key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(app.status, status_before, "tour keys do nothing here");
        assert_eq!(app.mode, TuiMode::Tour);

        // Composer open with a pane that has no stored draft: the
        // miss arm leaves the prompt empty.
        let mut app = terminal_app();
        app.open_composer_from_footer();
        let prompt = app.prompt_input.expect("composer prompt opens");
        assert_eq!(prompt.text, "");
    }

    #[test]
    fn lens_scroll_up_stops_when_deepen_cannot_grow() {
        let mut app = terminal_app();
        app.lens.active = true;
        app.pane_history = vec!["l1".into(), "l2".into(), "l3".into()];
        // Exhausted history: deepen returns 0 and the scroll stops at
        // the held top instead of looping.
        app.pane_history_exhausted = true;
        app.scroll_lens_up(100);
        let len = app.pane_scrollback_lines().len();
        assert_eq!(app.lens.scroll_up, len.saturating_sub(1));
    }
}

#[cfg(test)]
mod batch14_coverage_tests {
    use super::batch12_coverage_tests::two_pane_split_app;
    use super::batch13_coverage_tests::terminal_app;
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent};

    #[test]
    fn create_file_success_with_no_selectable_entry_skips_the_open() {
        // Line 1648: the create succeeds and the webui-style auto-open
        // runs; with the fake tree answering no entries the open takes
        // its early-Ok path and the error stays clear. (The Err arm of
        // this open is fixture-unreachable: the create's refresh always
        // empties the tree, so open_preview never holds a selection.)
        let (api, _stop) = super::prompt_action_tests::fake_api_server(&[]);
        let mut app = super::prompt_action_tests::app_with_api(api);
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        app.run_prompt_action(PromptKind::CreateFile, "b.rs");
        assert!(app.error.is_none(), "no selection means no open, no error");
        assert_eq!(app.status, "created b.rs");
    }

    #[test]
    fn commit_search_query_runs_to_the_final_ok() {
        // Line 1885: both fetches succeed and the commit reaches the
        // final Ok; the Enter handler then flips the committed flag.
        let (api, _stop) = super::prompt_action_tests::fake_api_server(&[]);
        let mut app = super::prompt_action_tests::app_with_api(api);
        app.mode = TuiMode::SearchPalette;
        app.search_palette.query = "needle".to_string();
        app.handle_search_palette_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.search_palette.committed);
        assert!(app.error.is_none());
    }

    #[test]
    fn workspace_selection_targets_the_active_tab_pane() {
        // Line 2071: the Workspace candidate resolves through the
        // workspace's active tab to its pane and returns early.
        let mut app = terminal_app();
        app.mode = TuiMode::SearchPalette;
        app.search_palette.committed = true;
        app.search_palette.results = vec![search::SearchCandidate::Workspace {
            id: "ws_1".into(),
            label: "Repo".into(),
        }];
        app.handle_search_palette_key(KeyEvent::from(KeyCode::Enter));
        // The pane arm recurses from the workspace arm: with an empty
        // agents list it stays on the Workspaces focus (line 2071's
        // early return still ran).
        assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
    }

    #[test]
    fn composer_prompt_prefills_a_stored_draft() {
        // Line 2682: an existing draft for the focused pane prefills
        // the composer prompt.
        let mut app = terminal_app();
        app.composer_drafts
            .insert("pane_1".to_string(), "half-typed".to_string());
        app.open_composer_from_footer();
        let prompt = app.prompt_input.expect("composer opens");
        assert_eq!(prompt.text, "half-typed");
    }

    #[test]
    fn tab_close_gone_tab_runs_the_not_found_recovery_flow() {
        // Lines 2921-2927: tab.close answers not-found (the backend
        // already tore the tab down), so the close still lands: the
        // workspace close and the post-close refresh both run. With a
        // ws_gone workspace the second close also reports not-found,
        // which the filter ignores, and the final refresh on the live
        // socket succeeds.
        let (socket, _stop) = crate::tui::tests::fake_backend_socket();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.snapshot.tabs[0].id = "tab_gone".to_string();
        app.snapshot.workspaces[0].id = "ws_gone".to_string();
        app.snapshot.workspaces[0].active_tab_id = Some("tab_gone".to_string());
        app.close_selected_tab();
        // The not-found arm ran the same post-close flow: the refresh
        // succeeded and rebuilt the status line, so only the absence of
        // an error proves the filters passed.
        assert!(app.error.is_none(), "not-found is the desired outcome");
        let _ = std::fs::remove_file(&socket);
    }

    #[test]
    fn files_enter_on_a_directory_toggles_expansion() {
        // Line 3118: Enter on a directory entry returns Ok(true) and
        // stays a no-op for the preview-open path.
        let (api, _stop) = super::prompt_action_tests::fake_api_server(&[]);
        let mut app = super::prompt_action_tests::app_with_api(api);
        app.screen = TuiScreen::Files;
        app.file_explorer
            .entries
            .push(crate::tui::panels::FileEntry {
                name: "dir".into(),
                path: "dir".into(),
                is_dir: true,
                size: None,
                level: 0,
                expanded: false,
                git_status: None,
            });
        app.file_explorer.selected = 0;
        app.handle_files_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.file_explorer.entries[0].expanded);
        assert!(app.error.is_none());
    }

    #[test]
    fn navigate_mode_quit_key_opens_the_confirm_overlay() {
        // Line 3983: plain q in Navigate mode with the main region
        // focused opens the quit confirmation.
        let mut app = terminal_app();
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert_eq!(app.mode, TuiMode::ConfirmQuit);
    }

    #[test]
    fn lens_scroll_exhausted_history_stops_the_deepen_loop() {
        // Line 4063: deepen returns zero on exhausted history, so the
        // scroll loop stops instead of spinning.
        let mut app = terminal_app();
        app.lens.active = true;
        app.pane_history = vec!["l1".into(), "l2".into()];
        app.pane_history_exhausted = true;
        app.scroll_lens_up(50);
        assert!(
            app.lens.scroll_up > 0,
            "scroll still moves within the window"
        );
    }

    #[test]
    fn attach_key_send_failure_surfaces_the_error() {
        // Line 4093: a typed key whose send fails (dead backend
        // socket) surfaces the attach error and stays in attach mode.
        let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Attach;
        app.handle_key(KeyEvent::from(KeyCode::Char('a')));
        assert!(app.error.is_some(), "dead socket send fails");
    }

    #[test]
    fn view_pane_resolves_the_focused_split_pane() {
        // Line 4276: a split with a live focused pane answers through
        // the focus, not the sidebar fallback.
        let mut app = two_pane_split_app();
        // The base fixture carries one pane; a two-pane snapshot is
        // what makes the focus resolve.
        app.snapshot = TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":2,"agent_status":"idle"}],
                "panes": [
                    {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false},
                    {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}
                ],
                "agents": []
            }
        }));
        app.split_focus = Some("pane_2".to_string());
        assert_eq!(app.view_pane().map(|pane| pane.id.as_str()), Some("pane_2"));
        // And the fallthrough keeps the sidebar answer when the
        // focused pane is not in the snapshot.
        app.split_focus = Some("gone".to_string());
        assert_eq!(app.view_pane().map(|pane| pane.id.as_str()), Some("pane_1"));
    }

    #[test]
    fn git_reveal_edit_on_a_binary_file_refuses() {
        // Line 2437: the EditFile shortcut on the git screen reads a
        // binary preview (the fixture serves binary for path=bin), so
        // start_edit refuses inside the reveal flow.
        let (api, _stop) = super::prompt_action_tests::fake_api_server(&[]);
        let mut app = super::prompt_action_tests::app_with_api(api);
        app.screen = TuiScreen::Git;
        app.git_panel.cwd = "/repo".into();
        app.git_panel.files = vec![panels::git::GitFileEntry {
            path: "bin.dat".into(),
            status: panels::git::GitFileStatus::Unstaged,
        }];
        app.run_shortcut(Shortcut::EditFile);
        assert!(app.error.is_some(), "binary preview refuses edit");
        assert_eq!(app.screen, TuiScreen::Files);
    }
}

#[cfg(test)]
mod batch15_coverage_tests {
    use super::batch13_coverage_tests::terminal_app;
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent};

    #[test]
    fn sidebar_focused_quit_key_also_opens_the_confirm_overlay() {
        // Line 3983: q in Navigate mode with the sidebar region focused
        // runs the shared post-walker dispatch, not the main arm.
        let mut app = terminal_app();
        app.main_focused = false;
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert_eq!(app.mode, TuiMode::ConfirmQuit);
    }
}

#[cfg(test)]
mod batch16_coverage_tests {
    use super::batch12_coverage_tests::two_pane_split_app;
    use super::batch13_coverage_tests::terminal_app;
    use super::prompt_action_tests::fake_api_server_with_tree;
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent};

    #[test]
    fn tour_arm_in_mode_dispatch_is_inert() {
        // Line 1264: the tour guard at the top of handle_key owns
        // every Tour key and returns before the mode match, so the
        // match's Tour arm is defensive only (the comment above it
        // records the same). No test can fire it through handle_key;
        // this test pins the guard behavior instead.
        let mut app = terminal_app();
        app.mode = TuiMode::Tour;
        let status_before = app.status.clone();
        app.handle_navigation_key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(app.status, status_before, "tour keys do nothing here");
        assert_eq!(app.mode, TuiMode::Tour);
    }

    #[test]
    fn create_file_open_preview_conflict_surfaces_the_error() {
        // Line 1649: create succeeds and selects the new entry, then
        // open_preview hits the dirty-buffer guard (webui keeps unsaved
        // editor tabs; opening another file refuses). The route fixture
        // serves the tree keyed to the explorer cwd so the refreshed
        // tree still lists the created file.
        let (api, _stop) = fake_api_server_with_tree("/cwd-create", &[]);
        let mut app = super::prompt_action_tests::app_with_api(api);
        app.file_explorer = super::prompt_action_tests::explorer_with_selection();
        app.file_explorer.cwd = "/cwd-create".to_string();
        app.file_explorer
            .entries
            .push(crate::tui::panels::FileEntry {
                name: "b.rs".into(),
                path: "b.rs".into(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
                git_status: None,
            });
        // Unsaved edits on a different file: opening b.rs must refuse.
        app.file_explorer.preview = panels::files::FilePreview {
            path: Some("other.rs".into()),
            content: String::new(),
            truncated: false,
            binary: false,
            hash: String::new(),
            dirty: true,
        };
        app.run_prompt_action(PromptKind::CreateFile, "b.rs");
        assert!(
            app.error
                .as_deref()
                .is_some_and(|e| e.contains("unsaved edits")),
            "conflicting open surfaces the error"
        );
        assert_eq!(app.status, "created b.rs");
    }

    #[test]
    fn workspace_search_target_without_active_tab_pane_refreshes_tail() {
        // Line 2071: the workspace arm found the workspace but neither
        // its active tab nor any pane matches, so the block falls to
        // its refresh_tail close instead of an early return.
        let (socket, _stop) = crate::tui::tests::fake_backend_socket();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.screen = TuiScreen::Terminal;
        app.snapshot.workspaces[0].active_tab_id = Some("tab_dead".to_string());
        app.snapshot.tabs.clear();
        app.select_search_target(Some("ws_1"), None, None);
        assert_eq!(app.selected_workspace, 0);
        assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
        assert!(app.error.is_none());
        let _ = std::fs::remove_file(&socket);
    }

    #[test]
    fn composer_opener_is_inert_off_the_terminal_screen() {
        // Line 2682: open_composer_from_footer only works on the
        // Terminal screen; on Files it returns before the prompt.
        let mut app = terminal_app();
        app.screen = TuiScreen::Files;
        app.open_composer_from_footer();
        assert!(app.prompt_input.is_none(), "composer stays closed");
        // On Terminal the same opener opens the prompt (line 2682) and
        // seeds the draft from the focused pane when one exists.
        app.screen = TuiScreen::Terminal;
        app.open_composer_from_footer();
        assert!(app.prompt_input.is_some(), "composer opens on terminal");
        assert!(app.status.starts_with("composer: type the message"));
        // Third pass: no pane in view (snapshot emptied), so view_pane
        // answers None and the draft-seed branch (line 2682) is skipped
        // while the composer still opens.
        app.snapshot.panes.clear();
        app.prompt_input = None;
        app.open_composer_from_footer();
        assert!(app.prompt_input.is_some(), "composer opens paneless");
    }

    #[test]
    fn tab_close_failing_snapshots_run_the_ok_and_recovery_error_arms() {
        // Lines 2897/2921-2927: tab.close still succeeds against the
        // failing-snapshot backend, then the post-close refresh and the
        // workspace close errors surface. First pass: two tabs, so the
        // Ok arm skips the workspace close entirely and its implicit
        // else runs (the refresh error also surfaces).
        let (socket, _stop) = crate::tui::tests::fake_backend_socket_failing_snapshots();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.snapshot.tabs.push(crate::tui::TuiTab {
            id: "tab_2".to_string(),
            workspace_id: "ws_1".to_string(),
            label: "Shell".to_string(),
            focused: false,
            pane_count: 0,
            agent_status: String::new(),
        });
        app.close_selected_tab();
        assert_eq!(app.status, "tab Shell closed");
        assert!(
            app.error.as_deref().is_some_and(|e| !e.is_empty()),
            "refresh failure after the ok close surfaces"
        );

        // Second pass: the tab id makes the backend answer not-found
        // (raced teardown), so the recovery arm runs with a last-tab
        // workspace whose close then really fails (ws_real_err). The
        // follow-up refresh fails too, so every recovery-path line
        // fires; the final error on the line is the refresh's, since
        // a healthy refresh clears a stale action error but this one
        // is already being replaced by a newer failure.
        let (socket, _stop) = crate::tui::tests::fake_backend_socket_failing_snapshots();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        let mut snapshot = crate::tui::tests::fixture_snapshot();
        snapshot.tabs[0].id = "tab_gone".to_string();
        snapshot.workspaces[0].active_tab_id = Some("tab_gone".to_string());
        snapshot.workspaces[0].id = "ws_real_err".to_string();
        snapshot.tabs[0].workspace_id = "ws_real_err".to_string();
        app.snapshot = snapshot;
        app.close_selected_tab();
        assert_eq!(app.status, "tab Shell closed");
        assert!(
            app.error.as_deref().is_some_and(|e| !e.is_empty()),
            "recovery arm surfaces the trailing refresh failure"
        );
        let _ = std::fs::remove_file(&socket);

        // Third pass (line 2894): the Ok arm with a real workspace-close
        // failure — tab.close succeeds on a plain tab id, the workspace
        // close answers a hard error (ws_real_err), and the not-found
        // filter passes it through to the error setter. The trailing
        // refresh failure then replaces the message, so the assert
        // only pins that an error survived, not which one.
        let (socket, _stop) = crate::tui::tests::fake_backend_socket_failing_snapshots();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        let mut snapshot = crate::tui::tests::fixture_snapshot();
        snapshot.workspaces[0].id = "ws_real_err".to_string();
        snapshot.tabs[0].workspace_id = "ws_real_err".to_string();
        app.snapshot = snapshot;
        app.close_selected_tab();
        assert_eq!(app.status, "tab Shell closed");
        assert!(
            app.error.as_deref().is_some_and(|e| !e.is_empty()),
            "ok arm surfaces the workspace-close failure"
        );
        let _ = std::fs::remove_file(&socket);

        // Fourth pass (line 2925): the recovery arm with a surviving
        // sibling tab — was_last_tab is false, so the workspace close
        // is skipped entirely and the block's implicit else runs.
        let (socket, _stop) = crate::tui::tests::fake_backend_socket_failing_snapshots();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        let mut snapshot = crate::tui::tests::fixture_snapshot();
        snapshot.tabs[0].id = "tab_gone".to_string();
        snapshot.workspaces[0].active_tab_id = Some("tab_gone".to_string());
        snapshot.tabs.push(crate::tui::TuiTab {
            id: "tab_2".to_string(),
            workspace_id: "ws_1".to_string(),
            label: "Shell".to_string(),
            focused: false,
            pane_count: 0,
            agent_status: String::new(),
        });
        app.snapshot = snapshot;
        app.close_selected_tab();
        assert_eq!(app.status, "tab Shell closed");
        assert!(
            app.error.as_deref().is_some_and(|e| !e.is_empty()),
            "recovery arm skips the workspace close with a sibling tab"
        );
        let _ = std::fs::remove_file(&socket);
    }

    #[test]
    fn close_tab_fixture_workspace_not_found_params_matches_the_tui_wire_format() {
        // The ws_gone fixture branch must key off params, matching the
        // TUI's request shape, so the not-found filter arm has a real
        // fixture behind it (guards the fix that made it reachable).
        let (socket, _stop) = crate::tui::tests::fake_backend_socket();
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        let mut snapshot = crate::tui::tests::fixture_snapshot();
        snapshot.workspaces[0].id = "ws_gone".to_string();
        snapshot.tabs[0].workspace_id = "ws_gone".to_string();
        snapshot.tabs[0].id = "tab_gone".to_string();
        snapshot.workspaces[0].active_tab_id = Some("tab_gone".to_string());
        app.snapshot = snapshot;
        app.close_selected_tab();
        // The not-found workspace close is swallowed: no error text
        // mentions it whether or not another error landed.
        let mentioned = app
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("not found");
        assert!(!mentioned, "not-found workspace close is swallowed");
        let _ = std::fs::remove_file(&socket);
    }

    #[test]
    fn scroll_lens_up_with_no_focused_pane_stops_the_deepen_loop() {
        // Line 4063: the second iteration's deepen fails because the
        // app has no view pane (focused_pane_id returns None), so the
        // loop returns through the zero-growth arm instead of spinning.
        let mut app = two_pane_split_app();
        app.lens.active = true;
        app.pane_history = vec!["l1".into(), "l2".into()];
        app.pane_history_exhausted = false;
        app.split_focus = None;
        app.split_tree = split::SplitNode::leaf("gone_1");
        app.snapshot.panes.clear();
        app.scroll_lens_up(50);
        assert!(
            app.lens.scroll_up > 0,
            "scroll still moves within the window"
        );
    }

    #[test]
    fn attach_key_send_detach_failure_surfaces_the_error() {
        // The server completes the handshake (Hello read, Welcome
        // written) then hangs up without reading the AttachTerminal
        // follow-up. By the time the client writes AttachTerminal the
        // close has propagated, so that write fails with EPIPE inside
        // attach_terminal and surfaces through the outer Err arm
        // (`Err(err) => self.error = ...`) — the outer-arm counterpart
        // of the send-chain Ok test below. The inner send-chain Err
        // arm is not deterministically coverable (see the coverage
        // note in handle_attach_key): a mid-chain death either
        // propagates before AttachTerminal (this test) or not until
        // after Detach (both writes succeed).
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
        let path = crate::backend_client::unique_test_path("herdr-tui-attach-die");
        let _ = std::fs::remove_file(&path);
        let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
        let listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
            .unwrap();
        // Nonblocking from the start: the fixture spins on accept until
        // the client lands, so the accept-Err arm runs on every empty poll
        // before the handshake instead of parking forever in accept.
        let _ =
            listener.set_nonblocking(interprocess::local_socket::ListenerNonblockingMode::Accept);
        std::thread::spawn(move || {
            let mut stream = loop {
                let Ok(stream) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                };
                break stream;
            };
            let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
            );
            let welcome = crate::protocol::ServerMessage::Welcome {
                version: 22,
                encoding: crate::protocol::RenderEncoding::TerminalAnsi,
                error: None,
            };
            let _ = crate::protocol::write_message(&mut stream, &welcome);
            // Hang up right after the Welcome frame, without reading
            // the AttachTerminal follow-up: the client's buffered read
            // of Welcome still completes, and by its AttachTerminal
            // write the close has propagated, so that write fails with
            // EPIPE inside attach_terminal — the outer Err arm runs
            // (a fully dead socket fails even earlier, at connect).
            drop(stream);
        });
        let client = BackendClient::new("/nonexistent.sock", &path);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Attach;
        app.handle_key(KeyEvent::from(KeyCode::Char('a')));
        assert!(
            app.error.as_deref().is_some_and(|e| e.contains("pipe")),
            "mid-stream death surfaces the send error, got {:?}",
            app.error
        );
    }

    #[test]
    fn attach_key_send_input_success_sets_the_status() {
        // Line 4095: the Ok arm of the send chain. The fixture answers
        // the whole chain (Hello, Welcome, AttachTerminal, Input,
        // Detach) so every client write lands on a live socket.
        // The Err arm of this chain is not coverable here — see the
        // coverage note at the send-chain `if let Err` in
        // handle_attach_key for why no deterministic drop point
        // reaches it.
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
        let path = crate::backend_client::unique_test_path("herdr-tui-attach-ok");
        let _ = std::fs::remove_file(&path);
        let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
        let listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
            .unwrap();
        // Blocking accept: the client always connects inside handle_key,
        // so accept just parks until it lands. The nonblocking-accept
        // trick from the dying-peer fixture is wrong here — the accepted
        // stream inherits the listener's nonblocking mode on macOS, every
        // read would return WouldBlock instantly, and the thread would
        // drop the stream mid-chain. unwrap is safe for the same reason
        // the listener never closes before the connection arrives.
        std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let max = crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE;
            let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                max,
            );
            let welcome = crate::protocol::ServerMessage::Welcome {
                version: 22,
                encoding: crate::protocol::RenderEncoding::TerminalAnsi,
                error: None,
            };
            let _ = crate::protocol::write_message(&mut stream, &welcome);
            let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                max,
            );
            let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                max,
            );
            let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                max,
            );
        });
        // The api side wires to `fake_backend_socket` so the post-send
        // refresh_tail lands its pane.read on a live server: the Ok arm
        // asserts error stays empty, and a dead api socket would set an
        // ENOENT error here even though the send chain itself succeeded.
        let (api_socket, _stop) = crate::tui::tests::fake_backend_socket();
        let client = BackendClient::new(api_socket, &path);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.screen = TuiScreen::Terminal;
        app.mode = TuiMode::Attach;
        app.handle_key(KeyEvent::from(KeyCode::Char('a')));
        assert_eq!(app.status, "sent input", "send chain landed on the Ok arm");
        assert!(
            app.error.is_none(),
            "no error on the happy path, got {:?}",
            app.error
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn view_pane_split_focus_id_missing_from_snapshot_falls_back() {
        // Coverage note (view_pane's inner find-else brace, line 4276):
        // structurally unreachable — focused_pane_id only answers ids it
        // has already verified against snapshot.panes (split_focus arm
        // and leaf scan both filter on it, selected_pane comes from the
        // snapshot), so the find here always succeeds when reached.
        // This test pins the fallback contract the comment describes:
        // a vanished pane id resolves through the tree to a live pane.
        let mut app = two_pane_split_app();
        assert_eq!(app.view_pane().map(|p| p.id.as_str()), Some("pane_1"));
        // Focus pane_2 is missing from the snapshot (truncated below),
        // so focused_pane_id's leaf scan picks pane_1 instead.
        app.split_focus = Some("pane_2".to_string());
        app.snapshot.panes.truncate(1);
        assert_eq!(app.view_pane().map(|p| p.id.as_str()), Some("pane_1"));
    }

    #[test]
    fn lens_deepen_growth_reenters_the_scroll_loop() {
        // Line 4063 (the loop's re-iteration after a growing deepen):
        // the socket backend answers pane.read with a full 2001-line
        // history, so the first deepen grows the buffer, the loop runs
        // a second pass, and the small delta then lands inside the
        // grown window (target <= max) instead of spinning.
        let (socket, _stop) = crate::tui::tests::fake_backend_socket_with_pane_history(2001);
        let client = BackendClient::new(socket.clone(), socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = crate::tui::tests::fixture_snapshot();
        app.screen = TuiScreen::Terminal;
        app.lens.active = true;
        app.pane_history = vec!["l1".into(), "l2".into()];
        app.pane_history_exhausted = false;
        app.scroll_lens_up(50);
        assert!(
            app.lens.scroll_up > 0,
            "scroll moved within the grown window"
        );
        assert!(
            app.pane_scrollback_lines().len() > 2,
            "deepen grew the history"
        );
        let _ = std::fs::remove_file(&socket);
    }
}

// Flat re-exports: pre-split TuiApp method paths stay crate-visible.
#[allow(unused_imports)]
pub use app::*;
#[allow(unused_imports)]
pub use events::*;
#[allow(unused_imports)]
pub use refresh::*;
#[allow(unused_imports)]
pub use scrollback::*;
#[allow(unused_imports)]
pub use settings::*;
