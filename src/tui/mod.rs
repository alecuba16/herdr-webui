pub mod keys;
pub mod lens;
pub mod model;
pub mod panels;
pub mod prompt_cards;
pub mod render;
pub mod search;
pub mod terminal;
pub mod theme;
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
pub use keys::{PrefixState, Shortcut};
use lens::{refusal_reason_copy, LensGate, LensState};
pub use model::{
    snapshot_summary, SidebarFocus, TuiAgent, TuiMode, TuiPane, TuiSnapshot, TuiTab, TuiWorkspace,
};
use model::{value_str, value_u64};
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
            Self::ConfirmCloseWorkspace => workspace::WorkspacePrompt::ConfirmCloseWorkspace,
            // File/git kinds have no workspace counterpart; map to the
            // harmless no-op closest to their intent.
            _ => workspace::WorkspacePrompt::ConfirmCloseWorkspace,
        }
    }
}

const TAIL_LINES: usize = 240;
const TERMINAL_RAW_BUFFER_BYTES: usize = 512 * 1024;
/// Tail poll cadence while the terminal screen is NOT attached: 1/5th
/// of the default snapshot interval. The preview keeps flowing at a
/// readable rate without hammering the backend with pane.read per event
/// loop tick (the event loop polls keys every 50ms).
pub(crate) const TAIL_REFRESH_INTERVAL: Duration = Duration::from_millis(200);

/// Max lines the Help overlay can scroll down: total rows minus whatever
/// fits in the 50-line centered box (title + border included).
fn help_max_scroll() -> usize {
    let rows = crate::tui::keys::help_rows().len();
    rows.saturating_sub(50usize.saturating_sub(4).saturating_sub(1))
}

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
    SettingsOverlay,
    /// Worktree browser overlay: j/k or arrows move, Enter opens, Esc closes.
    WorktreeList,
    /// Search palette overlay (prefix `/`): type to filter, Enter
    /// commits/navigates, Esc closes.
    SearchPalette,
    /// Chat lens overlay (prefix `L`): transcript reading view over the
    /// terminal pane; j/k scroll, follow re-arms at the bottom.
    Lens,
    /// Prompt card over a blocked pane (webui prompt cards): j/k
    /// cursor, Enter answers, digits jump, Esc dismisses.
    PromptCard,
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
            Self::HelpOverlay => " ? closes help · type filters · j/k scrolls ",
            Self::SettingsOverlay => " t theme · Esc closes ",
            Self::WorktreeList => " Enter opens/enters · o opens folder · h parent · j/k moves · type filters · Esc closes ",
            Self::SearchPalette => {
                " Enter commits/navigates · j/k moves · Esc closes · Ctrl+B ? help "
            }
            Self::Lens => {
                " j/k scroll · G bottom resumes follow · Esc closes · Ctrl+B ? help "
            }
            Self::PromptCard => {
                " j/k option · Enter answers · 1-9 jump · Esc hides · Ctrl+B ? help "
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
                " Enter attach · Shift+L chat lens · Shift+C compose · . / , focus sidebar · r refresh · q quit · Ctrl+B ]/[ panel · Ctrl+B ? help "
            }
            Self::Terminal(TuiMode::Attach) => {
                " Ctrl-G detach · type sends input · Ctrl+B ? help "
            }
            Self::Terminal(_) => {
                " ↑/↓ j/k select · Enter attach · Tab lists · q quit · Ctrl+B ? help "
            }
            Self::Files(_) => {
                " j/k move · Enter open · e edit · a/A new file/dir · R rename · x delete · / search · L file log · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Changes) => {
                " Tab view · s stage · d discard · J/K hunk · H apply · / search · c commit · P push · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Log) => {
                " Tab view · Space mark · c compare · t tag · R reset · b rebase · s scope · + more · Ctrl+B ? help "
            }
            Self::Git(_, GitView::Branches) => {
                " Tab view · j/k branches · c create · D delete · Enter refresh · Ctrl+B ? help "
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
                " j/k rows · x delete · B prune · Ctrl+B ? help "
            }
        }
    }

    /// Compact hint for narrow terminals: same discovery tail, fewer
    /// actions. `fit_hint` trims whole segments if even this is too wide.
    pub(crate) fn compact_hint(self) -> &'static str {
        match self {
            Self::ConfirmQuit => " y quit · n/Esc cancel ",
            Self::HelpOverlay => " ? closes help · type filters · j/k scrolls ",
            Self::SettingsOverlay => " t theme · Esc closes ",
            Self::WorktreeList => " Enter opens/enters · o opens folder · h parent · j/k moves · type filters · Esc closes ",
            Self::SearchPalette => " Enter commits/navigates · j/k moves · Esc closes · Ctrl+B ? help ",
            Self::CommitInput => " Enter commit · Esc cancel · Ctrl+B ? help ",
            Self::PromptInput(PromptKind::ReplaceInFile) => {
                " Enter replace · ! all · Esc cancel · Ctrl+B ? help "
            }
            Self::PromptInput(PromptKind::ComposerMessage) => {
                " Enter send · Ctrl+U clear · Esc cancel · Ctrl+B ? help "
            }
            Self::PromptInput(_) => " Enter accept · Esc cancel · Ctrl+B ? help ",
            Self::DiffSearch => " n/N cycle · Esc close · Ctrl+B ? help ",
            Self::EditorFind => " Enter next · Esc close · Ctrl+B ? help ",
            Self::FileEdit => " Ctrl-S save · Esc stop · Ctrl+B ? help ",
            Self::FilterBar => " type · Enter keep · Esc close · Ctrl+B ? help ",
            Self::ContentSearch => " j/k · Enter jump · Esc exit · Ctrl+B ? help ",
            Self::TerminalMain => " Enter attach · . , focus · Ctrl+B ? help ",
            Self::Terminal(TuiMode::Attach) => " Ctrl+B ? help · Ctrl-G detach ",
            Self::Lens => " j/k scroll · G bottom · Esc close · Ctrl+B ? help ",
            Self::PromptCard => " j/k · Enter · 1-9 · Esc · Ctrl+B ? help ",
            Self::Terminal(_) => " j/k select · Enter attach · q quit · Ctrl+B ? help ",
            Self::Files(_) => " j/k · Enter · e edit · Ctrl+B ? help ",
            Self::Git(_, GitView::Changes) => " s stage · d discard · c commit · Ctrl+B ? help ",
            Self::Git(_, GitView::Log) => " Space mark · c compare · Ctrl+B ? help ",
            Self::Git(_, GitView::Branches) => " c create · D delete · Ctrl+B ? help ",
            Self::Git(_, GitView::Stash) => " Enter diff · a apply · Ctrl+B ? help ",
            Self::Git(_, GitView::History) => " Enter commit diff · Ctrl+B ? help ",
            Self::Git(_, GitView::Conflicts) => " o/e/t resolve · R continue · Ctrl+B ? help ",
            Self::Git(_, GitView::Cleanup) => " x delete · B prune · Ctrl+B ? help ",
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
    pub file_explorer: FileExplorer,
    pub git_panel: GitPanel,
    pub commit_input: Option<CommitInput>,
    pub prompt_input: Option<PromptInput>,
    pub pane_tail: Vec<String>,
    pub(crate) pane_tail_styles: Vec<Vec<TuiTextSpan>>,
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
    /// Per-pane composer drafts (webui composer box keeps its content
    /// per pane, not per view). Keyed by pane id.
    pub composer_drafts: std::collections::HashMap<String, String>,
    /// Prompt-card state (webui prompt cards): the parsed question
    /// dialog of the selected blocked pane, its dismissal, and the
    /// option cursor. Derived state only — re-evaluated on every tail
    /// refresh and status change.
    pub prompt_card: prompt_cards::PromptCardState,
    /// Option cursor for the visible prompt card (webui highlights the
    /// hovered button; the TUI cursor is j/k moved).
    pub prompt_card_cursor: usize,
    /// Mode the user was in when the quit overlay opened; restored on cancel.
    pub(crate) quit_prev_mode: TuiMode,
    /// Modes the user was in before each overlay (help/settings/worktree)
    /// opened, oldest opener at the bottom, so closing returns to the
    /// immediately previous context. The WebUI modals return to the
    /// underlying view; the TUI must keep the attach context, and a
    /// help overlay opened from inside the worktree overlay must close
    /// back into that overlay, not out of the whole stack.
    pub(crate) overlay_stack: Vec<TuiMode>,
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
    /// Temporary Files overlay (prefix Shift+F): type a folder path,
    /// Enter opens the files explorer on it. No workspace is created,
    /// matching the webui temporary Files overlay.
    TempFilesFolder,
    /// Temporary Git overlay (prefix Shift+G): type a repository path,
    /// Enter opens the git panel on it. No workspace is created,
    /// matching the webui temporary Git overlay.
    TempGitFolder,
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
    /// Free-text answer to the prompt card of a blocked pane (webui
    /// prompt cards): routed through the hybrid transport — composer
    /// submit when the pane is unblocked, raw keystrokes into the
    /// dialog when blocked. Not a composer draft: the answer targets
    /// the dialog, so the draft must not be touched.
    CardAnswer,
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
            Self::ConfirmCloseWorkspace => "Close workspace (y)",
            Self::ConfirmCleanupDelete => "Delete cleanup item (y)",
            Self::CreateTag => "Tag commit",
            Self::ResetMode => "Reset to commit",
            Self::ConfirmResetHard => "Hard reset (y)",
            Self::RebaseUpstream => "Rebase: upstream ref",
            Self::ConfirmRebase => "Rebase (y)",
            Self::GitCwd => "Git directory",
            Self::TempFilesFolder => "Temporary Files: folder",
            Self::TempGitFolder => "Temporary Git: repository",
            Self::CreateBranch => "Create branch",
            Self::CreateFile => "New file",
            Self::CreateDirectory => "New directory",
            Self::ReplaceInFile => "Replace in file",
            Self::ComposerMessage => "Send a message",
            Self::CardAnswer => "Answer the question",
        }
    }

    /// Hint shown under the input line.
    pub fn hint(self) -> &'static str {
        match self {
            Self::RenameFile => "type the new name, Enter renames",
            Self::NewWorkspace => "type a directory path (~ works), Enter continues to the name",
            Self::NewWorkspaceName => "type the workspace name, Enter creates it",
            Self::RenameWorkspace | Self::RenamePanel => "type the new name, Enter renames",
            Self::CreateWorktreeBranch => "type the branch name, Enter continues",
            Self::CreateWorktreePath => "type the checkout path, Enter creates",
            Self::CreateTag => "type the tag name, Enter tags the selected commit",
            Self::ResetMode => "type soft, mixed or hard, Enter resets",
            Self::RebaseUpstream => "type the upstream ref, then y + Enter to rebase",
            Self::GitCwd => "type a repository path, Enter switches the git panel",
            Self::TempFilesFolder => {
                "type a folder path (~ works), Enter opens temporary Files on it"
            }
            Self::TempGitFolder => {
                "type a repository path (~ works), Enter opens temporary Git on it"
            }
            Self::CreateBranch => "type the branch name, Enter creates and switches",
            Self::CreateFile => "type the file name, Enter creates an empty file",
            Self::CreateDirectory => "type the directory name, Enter creates it",
            Self::ReplaceInFile => {
                "type the replacement, Enter replaces the current match (! = all)"
            }
            Self::ComposerMessage => "type the message, Enter sends it to the selected panel",
            Self::CardAnswer => "type the answer, Enter answers the question (Esc cancels)",
            _ => "type y then Enter to confirm, Esc cancels",
        }
    }
}

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
            file_explorer: FileExplorer::new(cwd),
            git_panel: GitPanel::new(cwd),
            commit_input: None,
            prompt_input: None,
            pane_tail: Vec::new(),
            pane_tail_styles: Vec::new(),
            terminal_raw_output: String::new(),
            terminal_raw_terminal_id: None,
            terminal_size: (0, 0),
            status: "connecting".to_string(),
            error: None,
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
            rebase_pending_upstream: None,
            help_scroll: 0,
            help_filter: String::new(),
            search_palette: search::SearchPalette::default(),
            lens: LensState::default(),
            composer_drafts: std::collections::HashMap::new(),
            prompt_card: prompt_cards::PromptCardState::default(),
            prompt_card_cursor: 0,
            quit_prev_mode: TuiMode::Navigate,
            overlay_stack: Vec::new(),
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
    pub fn attach_viewport(&self) -> (u16, u16) {
        let (width, height) = self.terminal_size;
        if width > 0 && height > 0 {
            render::pane_viewport_size(width, height, self.sidebar_collapsed)
        } else {
            (120, 32)
        }
    }

    pub fn refresh(&mut self) -> Result<(), BackendClientError> {
        let first_refresh = self.last_refresh.is_none();
        let ping = self.client.ping()?;
        let snapshot = self.client.snapshot()?;
        self.snapshot = TuiSnapshot::from_backend_response(&snapshot);
        if first_refresh {
            self.select_focused_items();
        }
        self.clamp_selection();
        if self.mode != TuiMode::Attach {
            self.refresh_tail();
            self.last_tail_refresh = Some(Instant::now());
        }
        self.status = format!(
            "backend {} · protocol {} · {} workspaces · {} agents",
            value_str(&ping, &["version"]).unwrap_or("built-in"),
            value_u64(&ping, &["protocol"]).unwrap_or_default(),
            self.snapshot.workspaces.len(),
            self.snapshot.agents.len(),
        );
        self.error = None;
        self.last_refresh = Some(Instant::now());
        self.mark_dirty();
        Ok(())
    }

    pub fn refresh_if_due(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        let due = self
            .last_refresh
            .map(|loaded| loaded.elapsed() >= self.refresh_interval)
            .unwrap_or(true);
        if due {
            if let Err(err) = self.refresh() {
                self.error = Some(err.to_string());
                self.mark_dirty();
            }
        } else {
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
                self.last_tail_refresh = Some(Instant::now());
            }
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
            TuiMode::Settings => return FooterContext::SettingsOverlay,
            TuiMode::WorktreeList => return FooterContext::WorktreeList,
            TuiMode::SearchPalette => return FooterContext::SearchPalette,
            _ => {}
        }
        // The lens overlays the terminal screen (both Navigate and
        // Attach); it owns the scrolling keys while open.
        if self.lens.active && self.screen == TuiScreen::Terminal {
            return FooterContext::Lens;
        }
        // The prompt card floats over the terminal pane in Navigate
        // mode; its answer keys win while it is visible.
        if self.prompt_card.visible
            && self.screen == TuiScreen::Terminal
            && self.mode == TuiMode::Navigate
        {
            return FooterContext::PromptCard;
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
                    FooterContext::TerminalMain
                } else {
                    FooterContext::Terminal(self.mode)
                }
            }
            TuiScreen::Files => FooterContext::Files(self.mode),
            TuiScreen::Git => FooterContext::Git(self.mode, self.git_panel.view),
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        // The Ctrl+B prefix wins everywhere, including attach mode, exactly
        // like the WebUI shortcut overlay wins over terminal input.
        if let Some(shortcut) = self.prefix.feed(key) {
            self.run_shortcut(shortcut);
            self.mark_dirty();
            return false;
        }
        if self.prefix.is_armed() {
            self.mark_dirty();
            return false;
        }
        if self.commit_input.is_some() {
            self.handle_commit_key(key);
            self.mark_dirty();
            return false;
        }
        if self.prompt_input.is_some() {
            self.handle_prompt_key(key);
            self.mark_dirty();
            return false;
        }
        // The lens overlays the terminal screen (Navigate or Attach):
        // while open it owns the scrolling keys like the webui scroller
        // owns focus. The Ctrl+B prefix already fired above, so help and
        // every other shortcut stay reachable.
        if self.lens.active && self.screen == TuiScreen::Terminal {
            self.handle_lens_key(key);
            self.mark_dirty();
            return false;
        }
        // The prompt card floats over the terminal pane (webui prompt
        // cards): while visible it owns the answer keys. It sits below
        // the modal inputs above (the webui card renders under the
        // modals too) and only arms on the Terminal screen. Keys the
        // card does not consume fall through to navigation so
        // pane/list movement still works while the card is visible.
        if self.prompt_card.visible
            && self.screen == TuiScreen::Terminal
            && self.mode == TuiMode::Navigate
            && self.handle_prompt_card_key(key)
        {
            self.mark_dirty();
            return false;
        }
        match self.mode {
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
                // Theme cycle (webui settings theme select).
                KeyCode::Char('t') | KeyCode::Tab => {
                    self.theme = self.theme.next();
                    // The palette is precomputed at startup; recompute it or
                    // the cycle has no visible effect (webui applies the
                    // theme immediately on selection).
                    self.palette = Palette::for_theme(self.theme);
                    self.status = format!("theme: {}", self.theme.label());
                }
                _ => {}
            },
            TuiMode::WorktreeList => self.handle_worktree_list_key(key),
            TuiMode::SearchPalette => self.handle_search_palette_key(key),
            TuiMode::Navigate => self.handle_navigation_key(key),
            TuiMode::Attach => {
                if self.screen == TuiScreen::Terminal {
                    self.handle_attach_key(key);
                } else {
                    self.handle_panel_key(key);
                }
            }
        }
        self.mark_dirty();
        false
    }

    fn handle_prompt_key(&mut self, key: KeyEvent) {
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
                if kind.needs_confirm() && text != "y" {
                    self.status = "cancelled".to_string();
                    return;
                }
                self.run_prompt_action(kind, &text);
            }
            KeyCode::Backspace => {
                if let Some(prompt) = self.prompt_input.as_mut() {
                    prompt.text.pop();
                }
                self.sync_composer_draft();
            }
            KeyCode::Char(ch) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && ch.eq_ignore_ascii_case(&'u') {
                    if let Some(prompt) = self.prompt_input.as_mut() {
                        prompt.text.clear();
                    }
                } else if let Some(prompt) = self.prompt_input.as_mut() {
                    prompt.text.push(ch);
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
    fn sync_composer_draft(&mut self) {
        let Some(prompt) = self.prompt_input.as_ref() else {
            return;
        };
        if prompt.kind != PromptKind::ComposerMessage {
            return;
        }
        let text = prompt.text.clone();
        if let Some(pane) = self.selected_pane() {
            let pane_id = pane.id.clone();
            self.composer_drafts.insert(pane_id, text);
        }
    }

    fn run_prompt_action(&mut self, kind: PromptKind, text: &str) {
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
            | PromptKind::ConfirmCloseWorkspace => {
                let kind = kind.into_workspace_prompt();
                workspace::run_prompt(self, &kind, text);
            }
            PromptKind::ConfirmCleanupDelete => match self.git_panel.selected_cleanup_item() {
                Some(item) => match self.git_panel.cleanup_delete(&self.web_api, &item) {
                    Ok(()) => self.status = format!("deleted {} {}", item.kind.label(), item.name),
                    Err(err) => self.error = Some(err.to_string()),
                },
                None => self.error = Some("no cleanup item selected".to_string()),
            },
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
            PromptKind::TempFilesFolder => {
                // Webui temporary Files overlay: open the explorer on the
                // typed folder, no workspace created. Same validation as
                // the workspace-create flow so typos surface fast.
                match crate::tui::workspace::validate_workspace_folder(text) {
                    Ok(folder) => match self.open_files_screen_at(&folder) {
                        Ok(()) => self.status = format!("temporary files: {folder}"),
                        Err(err) => self.error = Some(err.to_string()),
                    },
                    Err(err) => self.error = Some(err),
                }
            }
            PromptKind::TempGitFolder => {
                // Webui temporary Git overlay: open the git panel on the
                // typed repository, no workspace created.
                match crate::tui::workspace::validate_workspace_folder(text) {
                    Ok(folder) => match self.open_git_screen_at(&folder) {
                        Ok(()) => self.status = format!("temporary git: {folder}"),
                        Err(err) => self.error = Some(err.to_string()),
                    },
                    Err(err) => self.error = Some(err),
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
                let count = self.file_explorer.editor_find.ranges.len();
                match self.file_explorer.editor_replace(&replacement, all) {
                    Ok(()) => {
                        self.status = if all {
                            format!("replaced {count} matches")
                        } else {
                            format!("replaced 1 of {count} matches")
                        };
                        // Stay in edit mode with the find bar alive so
                        // Ctrl+S persists and Enter keeps cycling.
                        self.file_explorer.edit_active = true;
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ComposerMessage => {
                self.submit_composer_message(text);
            }
            PromptKind::CardAnswer => {
                // Hybrid transport (user decision on the port): the
                // answer path re-checks the pane status and the dialog
                // freshness itself.
                self.answer_prompt_card_text(text);
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
    fn submit_composer_message(&mut self, text: &str) {
        const MAX_COMPOSER_CHARS: usize = 20_000;
        let Some(pane_id) = self.selected_pane().map(|pane| pane.id.clone()) else {
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
    fn handle_search_palette_key(&mut self, key: KeyEvent) {
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
    fn commit_search_query(&mut self) -> Result<(), String> {
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
            .map_err(|err| err.to_string());
        let content_result = self
            .search_palette
            .commit_content_search(&self.web_api, &cwd, &root)
            .map(|_| ())
            .map_err(|err| err.to_string());
        file_result?;
        content_result?;
        Ok(())
    }

    /// Navigate the selected palette row (desktop `chooseSearchResult`):
    /// workspaces/panels/agents select their workspace and pane so the
    /// next Enter attaches; files reveal in the Files tree; content
    /// opens the preview at the match line.
    fn run_search_candidate(&mut self, candidate: &search::SearchCandidate) -> Result<(), String> {
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
                        .map_err(|err| err.to_string())?;
                }
                Ok(())
            }
            search::SearchCandidate::Content { file, line, .. } => {
                self.open_files_screen();
                self.file_explorer
                    .open_preview_at_line(&self.web_api, file, *line)
                    .map_err(|err| err.to_string())?;
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
                    .map_err(|err| err.to_string())?;
                // Desktop invalidates the recents cache after an open
                // (`invalidateRecent`), so the next palette open refetches
                // instead of serving the stale order.
                self.search_palette.invalidate_recents();
                self.refresh().map_err(|err| err.to_string())?;
                // Land on the reopened workspace like the desktop go()
                // navigation: the response carries the workspace plus its
                // focused tab and root pane (desktop `openRecentWorkspace`
                // passes all three; the tab/pane ids resolve the concrete
                // terminal, the workspace id alone falls back to the
                // active tab's first pane).
                let result = result.get("result");
                let workspace = result.and_then(|result| result.get("workspace"));
                let workspace_id = Self::recent_open_field(workspace, "workspace_id")
                    .or_else(|| Self::recent_open_field(result, "workspace_id"))
                    .unwrap_or_default()
                    .to_string();
                let tab_id =
                    Self::recent_open_field(result.and_then(|result| result.get("tab")), "tab_id");
                let pane_id = Self::recent_open_field(
                    result.and_then(|result| result.get("root_pane")),
                    "pane_id",
                );
                self.select_search_target(Some(workspace_id.as_str()), tab_id, pane_id);
                self.status = format!("opened {path}");
                Ok(())
            }
        }
    }

    /// Read a non-empty string field from a `worktree.open`-shaped
    /// result object (the recent-open response nests workspace, tab,
    /// and root_pane objects; missing or empty fields stay None).
    fn recent_open_field<'a>(parent: Option<&'a Value>, key: &str) -> Option<&'a str> {
        let value = parent?.get(key)?;
        match value.as_str() {
            Some(text) if !text.is_empty() => Some(text),
            _ => None,
        }
    }

    /// Desktop `isDefaultPanelTitle`: empty, shell, terminal, or
    /// "tab N" labels are generated defaults, not user renames.
    fn is_default_panel_title(label: &str) -> bool {
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
    fn select_search_target(
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
    fn handle_content_search_key(&mut self, key: KeyEvent) {
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
    fn rerun_content_search(&mut self) {
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
    fn handle_editor_find_key(&mut self, key: KeyEvent) {
        let shift = key
            .modifiers
            .contains(crossterm::event::KeyModifiers::SHIFT);
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

    fn handle_commit_key(&mut self, key: KeyEvent) {
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

    fn run_shortcut(&mut self, shortcut: Shortcut) {
        match shortcut {
            Shortcut::Help => self.open_help_overlay(),
            Shortcut::Files => self.open_files_screen(),
            Shortcut::Git => self.open_git_screen(),
            Shortcut::TempFiles => {
                // Webui temporary Files overlay: prompt for any folder,
                // open the explorer on it, create nothing.
                self.screen = TuiScreen::Files;
                self.prompt_input = Some(PromptInput::new(PromptKind::TempFilesFolder));
                self.status = PromptKind::TempFilesFolder.title().to_string();
            }
            Shortcut::TempGit => {
                // Webui temporary Git overlay: prompt for any repository
                // path, open the git panel on it, create nothing.
                self.screen = TuiScreen::Git;
                self.prompt_input = Some(PromptInput::new(PromptKind::TempGitFolder));
                self.status = PromptKind::TempGitFolder.title().to_string();
            }
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
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreeBranch));
                self.status = PromptKind::CreateWorktreeBranch.title().to_string();
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
                // "tab N" stay empty, `panelRenameInitialLabel`).
                let mut input = PromptInput::new(PromptKind::RenamePanel);
                input.text = self
                    .active_panel_label()
                    .filter(|label| !Self::is_default_panel_title(label))
                    .unwrap_or_default();
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
            Shortcut::Settings => {
                // Prefix s: settings overlay (webui settings modal).
                self.open_overlay(TuiMode::Settings);
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
            Shortcut::TempTerminalToggle => {
                let result = self.temp_terminal_toggle();
                self.workspace_status(result);
            }
            Shortcut::TempTerminalPromote => {
                let result = self.temp_terminal_promote();
                self.workspace_status(result);
            }
            Shortcut::Lens => {
                // Chat lens toggle (webui Chat/Terminal switch): only
                // meaningful over the terminal screen, and only for
                // panes with a transcript provider (design section 6).
                // Unsupported panes show positive evidence instead of
                // silently ignoring the key.
                if self.screen == TuiScreen::Terminal {
                    // Read the session snapshot up front: the borrow ends
                    // before the mutable lens toggle.
                    let session = self
                        .selected_pane()
                        .and_then(|pane| pane.agent_session.as_ref());
                    match session.map(|s| s.chat_supported()) {
                        Some(true) => {
                            // Refusal shape (resolvable: false): the lens
                            // opens but the hint carries the refusal
                            // reason (design section 6: "reason drives
                            // the lens hint text"). Only the open shows
                            // the copy; closing says "lens closed".
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
            Shortcut::Composer => {
                // Chat composer (webui composer box): message prompt for
                // the selected pane, prefilled with the pane's draft.
                if self.screen == TuiScreen::Terminal {
                    let mut input = PromptInput::new(PromptKind::ComposerMessage);
                    if let Some(pane) = self.selected_pane() {
                        if let Some(draft) = self.composer_drafts.get(&pane.id) {
                            input.text = draft.clone();
                        }
                    }
                    self.prompt_input = Some(input);
                    self.status = "composer: type the message, Enter sends".to_string();
                }
            }
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
                // diff lines of the selected file.
                self.open_git_screen();
                if self.git_panel.view != GitView::Changes {
                    self.git_panel.view = GitView::Changes;
                    self.refresh_active_screen();
                }
                match self.git_panel.toggle_blame(&self.web_api) {
                    Ok(()) => {
                        self.status = if self.git_panel.show_blame {
                            "blame on".to_string()
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
                self.open_git_screen();
                self.git_panel.view = GitView::Branches;
                self.refresh_active_screen();
                let selected = self.git_panel.branch_selected;
                let Some(branch) = self
                    .git_panel
                    .branches
                    .get(selected)
                    .filter(|entry| !entry.current)
                    .map(|entry| entry.name.clone())
                else {
                    return;
                };
                match self.git_panel.switch_branch(&self.web_api, &branch) {
                    Ok(()) => self.status = format!("switched to {branch}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
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
            Shortcut::GitStashFile => self.run_git_action(|panel, api| panel.stash_changes(api)),
            Shortcut::GitPush => self.run_git_action(|panel, api| panel.push(api)),
        }
    }

    /// Open the quit confirmation overlay. Remembers the mode to restore
    /// when the user cancels.
    fn request_quit(&mut self) {
        self.quit_prev_mode = self.mode;
        self.mode = TuiMode::ConfirmQuit;
        self.status = "quit? y confirms · Esc cancels".to_string();
    }

    /// Open a modal overlay (help/settings/worktree), remembering the
    /// mode it was opened from so closing returns there. Without this,
    /// overlays opened while attached drop back to Navigate and lose
    /// the attach context; the WebUI modals always return to whatever
    /// the user was doing underneath.
    fn open_overlay(&mut self, overlay: TuiMode) {
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
    fn open_search_palette(&mut self) {
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
    fn close_search_palette(&mut self) {
        self.close_overlay();
    }

    /// Remove the selected recent-workspace entry from the server list
    /// (desktop per-row trash button). Keeps the palette open and the
    /// cursor valid, mirroring the desktop staying in the palette after
    /// a remove.
    fn remove_selected_recent(&mut self) {
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
    fn clear_recent_workspaces(&mut self) {
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
    fn open_help_overlay(&mut self) {
        self.open_overlay(TuiMode::Help);
        self.reset_help_state();
    }

    /// Close the help overlay and reset its filter/scroll for the next
    /// open (both the `?` toggle and the Esc closer go through here).
    fn close_help_overlay(&mut self) {
        self.close_overlay();
        self.reset_help_state();
    }

    /// Clear the help filter and scroll so the overlay always opens or
    /// closes from a clean state.
    fn reset_help_state(&mut self) {
        self.help_scroll = 0;
        self.help_filter.clear();
    }

    /// Cancel the quit overlay and return to the mode the user was in.
    fn cancel_quit(&mut self) {
        self.mode = self.quit_prev_mode;
        self.status = "quit cancelled".to_string();
    }

    fn run_git_action(
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

    fn create_tab(&mut self) {
        let Some(workspace) = self
            .selected_workspace()
            .map(|workspace| workspace.id.clone())
        else {
            self.error = Some("no workspace selected".to_string());
            return;
        };
        match self.client.create_tab(Some(&workspace), None) {
            Ok(_) => {
                self.status = "tab created".to_string();
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    fn close_selected_tab(&mut self) {
        let Some(workspace) = self.selected_workspace() else {
            self.error = Some("no workspace selected".to_string());
            return;
        };
        let workspace_id = workspace.id.clone();
        let tab_id = workspace.active_tab_id.clone().or_else(|| {
            self.snapshot
                .workspace_tabs(&workspace.id)
                .first()
                .map(|tab| tab.id.clone())
        });
        let Some(tab_id) = tab_id else {
            self.error = Some("no tab to close".to_string());
            return;
        };
        // Webui closeTab guard (gap 7): closing the last tab in a
        // workspace also closes the workspace. The built-in backend
        // auto-closes emptied workspaces, but external backends may
        // keep them, so the TUI mirrors the webui and closes it
        // explicitly after the tab is gone.
        let was_last_tab = self.snapshot.workspace_tabs(&workspace_id).len().max(1) == 1;
        match self
            .client
            .request("tab.close", serde_json::json!({ "tab_id": tab_id }))
        {
            Ok(_) => {
                self.status = "tab closed".to_string();
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
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    fn open_files_screen(&mut self) {
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

    /// Temporary Files overlay (webui Shift+F): open the explorer on an
    /// explicit folder, bypassing the selected workspace entirely. No
    /// workspace or session is created; the explorer keeps its own state
    /// until another open replaces it (webui forgetWorkspace parity).
    fn open_files_screen_at(
        &mut self,
        folder: &str,
    ) -> Result<(), crate::tui::web_api::WebApiError> {
        self.screen = TuiScreen::Files;
        self.file_explorer = FileExplorer::new(folder);
        self.file_explorer.refresh(&self.web_api)
    }

    fn open_git_screen(&mut self) {
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

    /// Temporary Git overlay (webui Shift+G): open the git panel on an
    /// explicit repository path, bypassing the selected workspace. No
    /// workspace or session is created (webui temporary Git parity).
    fn open_git_screen_at(&mut self, folder: &str) -> Result<(), crate::tui::web_api::WebApiError> {
        self.screen = TuiScreen::Git;
        self.git_panel.set_cwd(folder);
        self.git_panel.refresh_view(&self.web_api)
    }

    fn refresh_active_screen(&mut self) {
        match self.screen {
            TuiScreen::Terminal => {
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
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

    /// Handle in-panel keys (files/git screens) while in attach mode.
    fn handle_panel_key(&mut self, key: KeyEvent) {
        match self.screen {
            TuiScreen::Files => self.handle_files_key(key),
            TuiScreen::Git => self.handle_git_key(key),
            TuiScreen::Terminal => {}
        }
    }

    fn handle_files_key(&mut self, key: KeyEvent) {
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

    fn handle_git_key(&mut self, key: KeyEvent) {
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
            KeyCode::Char('c')
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
            // Webui "worktree from branch": reuse the two-step worktree
            // creation prompt chain (branch, then checkout path).
            KeyCode::Char('w') if self.git_panel.view == GitView::Log => {
                self.worktree_create_stage = None;
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreeBranch));
                self.status = PromptKind::CreateWorktreeBranch.title().to_string();
            }
            KeyCode::Char('s') => {
                if let Err(err) = self.git_panel.stage_selected(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            // Webui git-panel `stageAll: KeyG`: toggle stage all from
            // the Changes view without the prefix (the old prefix
            // Shift+G now opens the temporary Git overlay).
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
            // Webui branch creation: in the Branches view `c` prompts
            // for a new branch name (git_switch create: true). Elsewhere
            // `c` keeps opening the commit modal.
            KeyCode::Char('c') if self.git_panel.view == GitView::Branches => {
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
                        self.status = format!(
                            "switched to {}",
                            self.git_panel
                                .branches
                                .get(self.git_panel.branch_selected)
                                .map(|entry| entry.name.clone())
                                .unwrap_or_default()
                        );
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
            // Cleanup view actions (webui cleanup tab: delete + prune).
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
                    Ok(()) => self.status = "worktrees pruned".to_string(),
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

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn take_dirty(&mut self) -> bool {
        let dirty = self.dirty;
        self.dirty = false;
        dirty
    }

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
        if let Some(pane) = self.selected_pane() {
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
        let selected_terminal_id = self.selected_terminal_id().map(str::to_string);
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

    fn handle_navigation_key(&mut self, key: KeyEvent) {
        // The Files and Git screens own their keys in Navigate mode too;
        // only the Terminal screen keeps the workspace/agent list keys.
        if self.screen != TuiScreen::Terminal {
            self.handle_panel_key(key);
            return;
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
                KeyCode::Tab | KeyCode::BackTab => self.toggle_sidebar_focus(),
                KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
                KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
                KeyCode::Enter => self.attach_selected(),
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
            KeyCode::Tab | KeyCode::BackTab => self.toggle_sidebar_focus(),
            KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
            KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
            KeyCode::Enter => self.attach_selected(),
            _ => {}
        }
    }

    /// Lens overlay keys (webui scroller focus): j/k or arrows
    /// scroll, G jumps back to the tail, Esc closes. Anything else is
    /// swallowed so no navigation or attach input fires under the
    /// reading view.
    fn handle_lens_key(&mut self, key: KeyEvent) {
        let len = self.pane_tail.len();
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('i') => {
                self.lens.close();
                self.status = "lens closed".to_string();
            }
            KeyCode::Char('j') | KeyCode::Down => self.lens.scroll_up(1, len),
            KeyCode::Char('k') | KeyCode::Up => self.lens.scroll_down(1, len),
            KeyCode::PageDown => self.lens.scroll_up(10, len),
            KeyCode::PageUp => self.lens.scroll_down(10, len),
            KeyCode::Char('G') | KeyCode::End => self.lens.scroll_down(usize::MAX, len),
            _ => {}
        }
    }

    /// Answer the selected option of the prompt card (webui `answer`):
    /// raw keystrokes into the dialog (option key + Enter). The stale
    /// guard re-parses the CURRENT tail so a moved-on dialog is never
    /// answered (webui stale-send guard).
    fn answer_prompt_card_option(&mut self) {
        let tail: Vec<String> = self.pane_tail.clone();
        let Some(card) = self.prompt_card.stale_guard(&tail) else {
            self.status = "question changed, not sent".to_string();
            return;
        };
        // Defensive: the card was Options when the key was pressed, but
        // a tail refresh between press and answer could have swapped the
        // kind; a Text card has no option payload to send (its Enter
        // opens the answer modal instead of calling here).
        if card.kind != crate::tui::prompt_cards::PromptCardKind::Options {
            return;
        }
        // Defensive: evaluate_prompt_card keeps the cursor inside the
        // option list on every card update, so an out-of-range cursor
        // needs a mid-press tail swap; refuse rather than panic.
        let Some(option) = card.options.get(self.prompt_card_cursor) else {
            return;
        };
        let payload = format!("{}\r", option.key);
        self.send_pane_input(&payload);
        self.prompt_card.mark_answered();
        self.status = format!("answered: {}", option.label);
        self.refresh_tail();
    }

    /// Send a free-text answer to the prompt card through the hybrid
    /// transport (user decision on the port): the composer submit
    /// route (`submit_pane`, agent.prompt semantics) when the pane is
    /// UNBLOCKED at answer time, raw typed text + Enter into the
    /// dialog (`send_input`, webui sendInputData parity) when it is
    /// still blocked. Status is re-read at answer time, not cached
    /// from the card render, and never crosses transports: a blocked
    /// answer never goes through the composer (the server refuses it
    /// by design) and an unblocked pane never gets dialog keystrokes.
    fn answer_prompt_card_text(&mut self, text: &str) {
        let blocked =
            self.selected_pane().map(|pane| pane.agent_status.as_str()) == Some("blocked");
        let tail: Vec<String> = self.pane_tail.clone();
        if blocked {
            // Raw path: the dialog must still be the one the card
            // rendered (webui stale-send guard, tail freshness only).
            if self.prompt_card.stale_guard(&tail).is_none() {
                self.status = "question changed, not sent".to_string();
                return;
            }
        }
        if text.trim().is_empty() {
            self.status = "answer empty, nothing sent".to_string();
            return;
        }
        if crate::tui::prompt_cards::free_text_via_composer(blocked) {
            // Unblocked: the composer route (a plain message to the
            // agent); the server owns validation and refusal copy.
            self.submit_composer_message(text);
        } else {
            // Blocked: raw typed text + Enter into the dialog, like the
            // webui's sendInputData path.
            let payload = format!("{}\r", text);
            self.send_pane_input(&payload);
            self.status = "answer sent".to_string();
        }
        self.prompt_card.mark_answered();
        self.refresh_tail();
    }

    /// Write raw input bytes into the selected pane's terminal (the
    /// webui sendInputData counterpart): attach, send, detach.
    fn send_pane_input(&mut self, payload: &str) {
        // Defensive: no pane selected (empty workspace) cannot coexist
        // with a visible card (every selection move refreshes the
        // tail, which collapses the card), so the guard below is
        // unreachable from the card route; it protects attach-mode
        // and future callers the same way.
        let Some(terminal_id) = self.selected_terminal_id().map(str::to_string) else {
            self.error = Some("selected pane has no terminal".to_string());
            return;
        };
        let (attach_cols, attach_rows) = self.attach_viewport();
        match self
            .client
            .attach_terminal(&terminal_id, attach_cols, attach_rows)
        {
            Ok(mut terminal) => {
                // Production-reachable error arm (the backend dies
                // between the input and detach writes) but not
                // deterministically injectable from tests: the two
                // writes are adjacent with no blocking point between
                // them, so no fake server can land its close inside
                // that window on demand. The attach-failure arm
                // below is the tested deterministic surrogate.
                let send = terminal
                    .send_input(payload.as_bytes())
                    .and_then(|_| terminal.detach());
                if let Err(err) = send {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    /// Keys while the prompt card is visible (webui prompt cards):
    /// j/k (and arrows) move the option cursor — the TUI counterpart of
    /// hovering the option buttons — Enter answers the highlighted
    /// option, digits jump straight to option N, Esc dismisses the
    /// card until the question changes. Free-text cards open the
    /// CardAnswer prompt (a separate modal kind; its Enter runs the
    /// hybrid transport). Returns true when the key was consumed.
    fn handle_prompt_card_key(&mut self, key: KeyEvent) -> bool {
        // Defensive: handle_key only routes here while the card is
        // visible, and evaluate keeps `current` populated whenever it
        // is; a visible card without a parsed card is a state bug, and
        // falling through (returning false) degrades to navigation
        // instead of a panic.
        let Some(card) = self.prompt_card.current_card().cloned() else {
            return false;
        };
        match key.code {
            // Esc dismisses the card until the question changes (webui
            // × button). q is NOT consumed: plain q is the TUI-wide
            // quit key and stays available even while the card floats
            // (the webui quit control lives outside the card too).
            KeyCode::Esc => {
                self.prompt_card.dismiss();
                self.status = "card dismissed".to_string();
                true
            }
            KeyCode::Char('j') | KeyCode::Down
                if card.kind == crate::tui::prompt_cards::PromptCardKind::Options =>
            {
                let len = card.options.len();
                self.prompt_card_cursor = (self.prompt_card_cursor + 1).min(len.saturating_sub(1));
                true
            }
            KeyCode::Char('k') | KeyCode::Up
                if card.kind == crate::tui::prompt_cards::PromptCardKind::Options =>
            {
                self.prompt_card_cursor = self.prompt_card_cursor.saturating_sub(1);
                true
            }
            KeyCode::Enter => {
                match card.kind {
                    crate::tui::prompt_cards::PromptCardKind::Options => {
                        self.answer_prompt_card_option();
                    }
                    crate::tui::prompt_cards::PromptCardKind::Text => {
                        // Free-text card: open the answer prompt; its
                        // Enter runs the hybrid transport (composer when
                        // unblocked, raw input into the dialog when
                        // blocked).
                        self.prompt_input = Some(PromptInput::new(PromptKind::CardAnswer));
                        self.status = "type your answer".to_string();
                    }
                }
                true
            }
            KeyCode::Char(digit)
                if digit.is_ascii_digit()
                    && card.kind == crate::tui::prompt_cards::PromptCardKind::Options =>
            {
                // Direct option jump: the digit keys mirror the webui's
                // clickable buttons for users who know the number.
                let index = digit as usize - '0' as usize;
                if index >= 1 && index <= card.options.len() {
                    self.prompt_card_cursor = index - 1;
                    self.answer_prompt_card_option();
                }
                true
            }
            _ => false,
        }
    }

    fn handle_attach_key(&mut self, key: KeyEvent) {
        // Note: menu keys (Ctrl+B) never reach this handler; the prefix
        // feed in `handle_key` consumes them first to arm the overlay.
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('g') {
            self.mode = TuiMode::Navigate;
            self.status = "detached".to_string();
            return;
        }
        let Some(terminal_id) = self.selected_terminal_id().map(str::to_string) else {
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
                    if let Err(err) = send {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "sent input".to_string();
                    }
                    self.refresh_tail();
                }
                Err(err) => self.error = Some(err.to_string()),
            }
        }
    }

    fn attach_selected(&mut self) {
        if self.selected_terminal_id().is_some() {
            self.mode = TuiMode::Attach;
            self.status = "attach mode: Ctrl-G detach".to_string();
            self.refresh_tail();
            let (cols, rows) = self.attach_viewport();
            self.load_selected_terminal_history(cols, rows);
        } else {
            self.error = Some("no terminal selected".to_string());
        }
    }

    pub fn load_selected_terminal_history(&mut self, cols: u16, rows: u16) {
        let Some(terminal_id) = self.selected_terminal_id().map(str::to_string) else {
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

    fn toggle_sidebar_focus(&mut self) {
        self.sidebar_focus = match self.sidebar_focus {
            SidebarFocus::Workspaces => SidebarFocus::Agents,
            SidebarFocus::Agents => SidebarFocus::Workspaces,
        };
    }

    fn move_selection(&mut self, delta: isize) {
        match self.sidebar_focus {
            SidebarFocus::Workspaces => {
                self.selected_workspace = move_index(
                    self.selected_workspace,
                    self.snapshot.workspaces.len(),
                    delta,
                );
                self.refresh_tail();
            }
            SidebarFocus::Agents => {
                self.selected_agent =
                    move_index(self.selected_agent, self.snapshot.agents.len(), delta);
                self.refresh_tail();
            }
        }
    }

    fn clamp_selection(&mut self) {
        self.selected_workspace = self
            .selected_workspace
            .min(self.snapshot.workspaces.len().saturating_sub(1));
        self.selected_agent = self
            .selected_agent
            .min(self.snapshot.agents.len().saturating_sub(1));
    }

    fn select_focused_items(&mut self) {
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
    fn lens_chat_supported(&self) -> LensGate {
        match self
            .selected_pane()
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
        let workspace_id = &self.selected_workspace()?.id;
        let active_tab_id = self.selected_workspace()?.active_tab_id.as_deref();
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
        let Some(pane_id) = self.selected_pane().map(|pane| pane.id.clone()) else {
            self.pane_tail.clear();
            self.pane_tail_styles.clear();
            self.reset_terminal_output_buffer();
            // No pane selected: the card is derived state and must
            // collapse too (evaluate on the empty tail hides it).
            self.evaluate_prompt_card();
            return;
        };
        match self.client.read_pane(&pane_id) {
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
                // The tail read failed but the STATUS in the snapshot
                // may have changed (blocked -> idle): re-evaluate the
                // card against the kept tail so it never lingers a
                // tick longer than the status says.
                self.evaluate_prompt_card();
                self.mark_dirty();
            }
        }
    }

    fn reset_terminal_output_buffer(&mut self) {
        self.terminal_raw_output.clear();
        self.terminal_raw_terminal_id = None;
    }

    fn set_pane_tail_from_text(&mut self, text: &str) {
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
        self.evaluate_prompt_card();
    }

    fn set_pane_tail_from_styled_lines(&mut self, lines: Vec<Vec<TuiTextSpan>>) {
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
        self.lens.observe_len(self.pane_tail.len());
        // The prompt card reads the same tail: keep its derived state
        // fresh on every tail update (webui evaluate() on frame/status).
        self.evaluate_prompt_card();
    }

    /// Re-evaluate the prompt card against the selected pane's status
    /// and the current tail (webui `HerdrPromptCards.evaluate`). The
    /// card is derived state: parse failures hide it, a fresh blocked
    /// episode re-arms a dismissed question, and the option cursor
    /// clamps to the new option count.
    fn evaluate_prompt_card(&mut self) {
        let blocked =
            self.selected_pane().map(|pane| pane.agent_status.as_str()) == Some("blocked");
        let tail: Vec<String> = self.pane_tail.clone();
        let was_visible = self.prompt_card.visible;
        if self.prompt_card.evaluate(blocked, &tail).is_some() {
            let options = self
                .prompt_card
                .current_card()
                .map(|card| card.options.len())
                .unwrap_or(0);
            if self.prompt_card_cursor >= options {
                self.prompt_card_cursor = 0;
            }
            if !was_visible {
                // Fresh card: start the cursor on the first option.
                self.prompt_card_cursor = 0;
            }
        } else {
            self.prompt_card_cursor = 0;
        }
    }

    pub fn should_quit(&self) -> bool {
        self.status == "quit"
    }
}

pub fn build_client(options: &TuiOptions) -> BackendClient {
    match (&options.api_socket, &options.terminal_socket) {
        (Some(api), Some(terminal)) => BackendClient::new(api, terminal),
        _ => BackendClient::builtin_session(options.session.as_deref()),
    }
}

pub use terminal::input::{is_menu_key, key_to_terminal_bytes};

fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}

fn strip_ansi_lossy(value: &str) -> String {
    terminal_text::strip_ansi_lossy(value, StripCarriageReturn::Drop)
}

fn trim_terminal_raw_output(value: &mut String) {
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
