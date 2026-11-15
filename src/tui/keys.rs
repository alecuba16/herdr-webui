use crate::tui::{TuiMode, TuiScreen};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::time::{Duration, Instant};

/// How long the prefix stays armed before it disarms itself. Mirrors
/// the WebUI prefix overlay, which hides after 5s (`shortcutPrefixUntil
/// = Date.now() + 5000`).
const PREFIX_ARM_WINDOW: Duration = Duration::from_secs(5);

/// Herdr-style prefix state machine for the TUI.
///
/// `Ctrl+B` is the main switch key (same default as the WebUI). Pressing it
/// arms the prefix for a short window; the next key dispatches a shortcut
/// instead of reaching the terminal or panel. `Esc` cancels the prefix.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrefixState {
    armed: bool,
    armed_at: Option<Instant>,
}

impl PrefixState {
    pub fn new() -> Self {
        Self::default()
    }

    /// True while the prefix is armed and inside the arm window. The
    /// deadline is checked here too so probes never report a stale
    /// armed state; expiry itself still lands on the next feed.
    pub fn is_armed(&self) -> bool {
        self.armed
            && self
                .armed_at
                .is_some_and(|at| at.elapsed() < PREFIX_ARM_WINDOW)
    }

    pub fn arm(&mut self) {
        self.armed = true;
        self.armed_at = Some(Instant::now());
    }

    pub fn cancel(&mut self) {
        self.armed = false;
        self.armed_at = None;
    }

    /// Disarm when the arm window elapsed. Key events carry no clock,
    /// so the deadline is checked lazily on every feed and is_armed
    /// probe, exactly like the WebUI comparing `shortcutPrefixUntil`
    /// against `Date.now()` before dispatching.
    fn expire(&mut self) -> bool {
        if self.armed
            && self
                .armed_at
                .is_some_and(|at| at.elapsed() >= PREFIX_ARM_WINDOW)
        {
            self.cancel();
            return true;
        }
        false
    }

    /// Feed a key event. Returns the shortcut that should run, if any.
    pub fn feed(&mut self, key: KeyEvent) -> Option<Shortcut> {
        self.expire();
        if is_prefix_key(key) {
            if self.armed {
                // Ctrl+B twice: keep armed but treat as toggle-off like the
                // WebUI prefix overlay (second press closes the overlay).
                self.cancel();
                return None;
            }
            self.arm();
            return None;
        }
        if !self.armed {
            return None;
        }
        self.cancel();
        if key.code == KeyCode::Esc {
            return None;
        }
        shortcut_for_key(key)
    }
}

pub fn is_prefix_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b')
}

/// Shortcut actions available after the `Ctrl+B` prefix. Mirrors the WebUI
/// prefix overlay defaults plus the Git shortcut set, so muscle memory
/// transfers between the browser UI and the TUI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shortcut {
    Help,
    Files,
    Git,
    Terminal,
    Search,
    Refresh,
    NextWorkspace,
    PrevWorkspace,
    NextAgent,
    PrevAgent,
    NewTab,
    CloseTab,
    Quit,
    // Git view shortcuts (also usable inside the Git screen without prefix)
    GitChanges,
    GitCommit,
    GitLog,
    GitStash,
    GitBranch,
    GitStageFile,
    GitUnstageFile,
    GitDiscardFile,
    GitStashFile,
    GitPush,
    GitSwitchBranch,
    EditFile,
    GitFileHistory,
    GitChangesBack,
    GitBlame,
    // Workspace/panel management (WebUI DEFAULT_WEBUI_SHORTCUTS parity).
    NextPanel,
    PrevPanel,
    NewWorkspace,
    OpenWorktrees,
    CreateWorktree,
    CloseWorkspace,
    RemoveWorktree,
    RenamePanel,
    RenameWorkspace,
    // Git cwd picker (plan: prefix I; the webui has no default binding,
    // its location bar is mouse-driven).
    GitCwdPicker,
    // Settings overlay (webui settings: KeyS).
    Settings,
    // Settings overlay via the dedicated `Ctrl+B Shift+E` chord
    // (review F4): unlike `Settings` this one works on the Terminal
    // screen too, where prefix `s` belongs to split mode.
    SettingsOverlay,
    // Sidebar visibility (webui sidebar: KeyB is plain B, so the TUI
    // uses Shift+B; plain b stays the git branches shortcut).
    Sidebar,
    // Focus walker (webui focusNext/focusPrev: Period/Comma). Cycles
    // sidebar workspaces -> agents -> main screen, the keyboard-only
    // equivalent of the webui DOM focus walker.
    FocusNext,
    FocusPrev,
    // Chat lens toggle (webui Chat/Terminal segmented switch on the
    // terminal screen; ux overhaul 2/3). Prefix L; plain l stays git
    // log from the git shortcut table.
    Lens,
    // Chat composer (webui composer box under the lens; ux overhaul
    // server-side submit). Opens the message prompt for the selected
    // pane; the server owns validation and refusal copy.
    Composer,
    // Webui git `stageAll: KeyG`: toggle stage all from anywhere via
    // the prefix, not only the in-screen Changes `G`.
    GitStageAll,
    // Webui git `focusFile: KeyI`: focus the git file list.
    GitFocusFile,
    // Session manager overlay. Webui reaches it from the footer
    // button (no prefix default); the TUI needs a chord, so Shift+P
    // takes it (plain p stays new tab).
    SessionManager,
    // Split-panel mode entry points (design: docs/ux/
    // tui-split-panels-design.md). Terminal screen only: the prefix
    // dispatch scopes them, so the git screen keeps its s/m/z keys.
    SplitPane,
    MovePane,
    ZoomPane,
    ResizePane,
}

impl Shortcut {
    /// Short label used in the footer and help overlay.
    pub fn label(self) -> &'static str {
        match self {
            Self::Help => "help",
            Self::Files => "files",
            Self::Git => "git",
            Self::Terminal => "terminal",
            Self::Search => "search",
            Self::Refresh => "refresh",
            Self::NextWorkspace => "next workspace",
            Self::PrevWorkspace => "prev workspace",
            Self::NextAgent => "next agent",
            Self::PrevAgent => "prev agent",
            Self::NewTab => "new tab",
            Self::CloseTab => "close tab",
            Self::Quit => "quit",
            Self::GitChanges => "git changes",
            Self::GitCommit => "git commit",
            Self::GitLog => "git log",
            Self::GitStash => "git stash",
            Self::GitBranch => "git branches",
            Self::GitStageFile => "stage file",
            Self::GitUnstageFile => "unstage file",
            Self::GitDiscardFile => "discard file",
            Self::GitStashFile => "stash file",
            Self::GitPush => "push",
            Self::GitSwitchBranch => "branch picker",
            Self::EditFile => "edit file",
            Self::GitFileHistory => "file history",
            Self::GitChangesBack => "back to changes",
            Self::GitBlame => "toggle blame",
            Self::NextPanel => "next panel",
            Self::PrevPanel => "previous panel",
            Self::NewWorkspace => "new workspace",
            Self::OpenWorktrees => "worktree list",
            Self::CreateWorktree => "create worktree",
            Self::CloseWorkspace => "close workspace",
            Self::RemoveWorktree => "remove worktree",
            Self::RenamePanel => "rename panel",
            Self::RenameWorkspace => "rename workspace",
            Self::GitCwdPicker => "git cwd",
            Self::Settings => "settings",
            Self::SettingsOverlay => "settings",
            Self::Sidebar => "toggle sidebar",
            Self::FocusNext => "focus next",
            Self::FocusPrev => "focus previous",
            Self::Lens => "chat lens",
            Self::Composer => "composer",
            Self::GitStageAll => "toggle stage all",
            Self::GitFocusFile => "focus file list",
            Self::SessionManager => "session manager",
            Self::SplitPane => "split mode",
            Self::MovePane => "move tile",
            Self::ZoomPane => "zoom tile",
            Self::ResizePane => "resize tile",
        }
    }
}

/// Resolve a key pressed while the prefix is armed. Shift-sensitivity mirrors
/// the WebUI map (for example `Shift+X` vs `X`).
pub fn shortcut_for_key(key: KeyEvent) -> Option<Shortcut> {
    let code = key.code;
    // Terminals send Shift+letter as an uppercase Char with the SHIFT
    // modifier, but synthetic events may carry the uppercase Char alone;
    // treat both as shifted so the map stays case-driven.
    let shifted = key.modifiers.contains(KeyModifiers::SHIFT)
        || matches!(code, KeyCode::Char(ch) if ch.is_ascii_uppercase());
    match (code, shifted) {
        (KeyCode::Char('?'), _) => Some(Shortcut::Help),
        (KeyCode::Char('/'), _) => Some(Shortcut::Search),
        // Webui `focusTerminal: KeyF` focuses the xterm DOM surface; the
        // TUI terminal always owns the keyboard (no DOM), so `F` needs
        // no parity key. The old TUI-only prefix-`f` Files screen stays
        // (the webui has no files-explorer shortcut at all).
        (KeyCode::Char('f') | KeyCode::Char('F'), _) => Some(Shortcut::Files),
        (KeyCode::Char('g'), false) => Some(Shortcut::Git),
        (KeyCode::Char('t'), false) => Some(Shortcut::Terminal),
        (KeyCode::Char('r') | KeyCode::Char('R'), false) => Some(Shortcut::Refresh),
        // Rename panel: no webui prefix default (the webui renames from
        // the panel menu), so Shift+R takes it while plain r stays the
        // webui refresh key.
        (KeyCode::Char('R'), true) => Some(Shortcut::RenamePanel),
        (KeyCode::Char('j'), false) => Some(Shortcut::NextWorkspace),
        (KeyCode::Char('k'), false) => Some(Shortcut::PrevWorkspace),
        (KeyCode::Char('a'), false) => Some(Shortcut::NextAgent),
        (KeyCode::Char('A'), true) => Some(Shortcut::PrevAgent),
        // Webui newPanel: KeyP. The old `p` => Git was redundant with `g`.
        (KeyCode::Char('p'), false) => Some(Shortcut::NewTab),
        // Webui newWorkspace: KeyN.
        (KeyCode::Char('n') | KeyCode::Char('N'), false) => Some(Shortcut::NewWorkspace),
        (KeyCode::Char('x'), false) => Some(Shortcut::CloseTab),
        (KeyCode::Char('X'), true) => Some(Shortcut::CloseWorkspace),
        (KeyCode::Char('q'), false) => Some(Shortcut::Quit),
        // Git chord reduction: the old digits 1-4, the b/h/o view jumps
        // and the y/d file verbs duplicated the git screen's in-screen
        // keys (Tab cycle, c/l, s/d); blame m, stash z and unstage u
        // stay because they are the only keyboard path. The reduction
        // keeps every unique modal and window trigger; view switching
        // rides Ctrl+B g then Tab.
        // Stash used to live on plain `s` (a TUI addition); the webui
        // default binds plain `S` to settings, so `s` now matches the
        // webui and stash lives in-screen in the Stash view.
        (KeyCode::Char('s'), false) => Some(Shortcut::Settings),
        // Sidebar visibility: webui `sidebar: KeyB` is plain B, but plain
        // b is the git branches shortcut (git `branch: KeyV` would be the
        // webui key, TUI keeps b from its own table), so the toggle
        // lands on Shift+B.
        (KeyCode::Char('B'), true) => Some(Shortcut::Sidebar),
        // Webui focusNext/focusPrev: Period/Comma. Walks the TUI focus
        // regions instead of DOM controls.
        (KeyCode::Char('.'), _) => Some(Shortcut::FocusNext),
        (KeyCode::Char(','), _) => Some(Shortcut::FocusPrev),
        // Chat composer (ux overhaul): the webui box rides under the
        // lens; the TUI opens it as a prompt from any terminal-screen
        // state. Shift+C for compose while plain c stays git commit.
        (KeyCode::Char('C'), true) => Some(Shortcut::Composer),
        // Chat lens (ux overhaul): webui has no prefix binding (the
        // Chat/Terminal switch is a segmented control over the shell),
        // so Shift+L takes it; plain l is unused after the git chord
        // reduction.
        (KeyCode::Char('L'), true) => Some(Shortcut::Lens),
        // Unstage (u) has no in-screen key, so the chord stays the only
        // keyboard path; z/m below are the same.
        (KeyCode::Char('u'), false) => Some(Shortcut::GitUnstageFile),
        (KeyCode::Char('z'), false) => Some(Shortcut::GitStashFile),
        // Split resize (Shift+Z pairs with z zoom on the same
        // mnemonic): h/l move the tile's horizontal divider, j/k the
        // vertical one, Enter/Esc closes.
        (KeyCode::Char('Z'), true) => Some(Shortcut::ResizePane),
        (KeyCode::Char('v'), false) => Some(Shortcut::GitSwitchBranch),
        // Webui `edit: KeyE` is the plain `e` key, so muscle memory maps plain
        // `e` to EditFile. Amend has no webui prefix shortcut (it is a checkbox
        // in the commit modal); the TUI keeps it on the in-screen `a` key.
        // Shift+E stays settings (review F4): `Ctrl+B s` belongs to split
        // mode on the Terminal screen, so the settings overlay needs a
        // keyboard path that works from every screen.
        (KeyCode::Char('e'), false) => Some(Shortcut::EditFile),
        (KeyCode::Char('E'), true) => Some(Shortcut::SettingsOverlay),
        // Blame stays as the only keyboard path to the blame toggle;
        // history (old h) and back-to-changes (old o) are in-screen
        // (Tab cycle) after the chord reduction.
        (KeyCode::Char('m') | KeyCode::Char('M'), false) => Some(Shortcut::GitBlame),
        // Webui DEFAULT_WEBUI_SHORTCUTS parity: BracketRight/BracketLeft
        // walk panels, W opens the worktree list, Shift+T creates a
        // worktree (plain `t` stays the terminal screen), Shift+X closes
        // the workspace, Delete/Backspace removes a linked worktree, and
        // Shift+S renames the workspace (no webui default; panels rename
        // via their visible menu, mirrored later).
        (KeyCode::Char(']'), _) => Some(Shortcut::NextPanel),
        (KeyCode::Char('['), _) => Some(Shortcut::PrevPanel),
        (KeyCode::Char('w') | KeyCode::Char('W'), false) => Some(Shortcut::OpenWorktrees),
        (KeyCode::Char('T'), true) => Some(Shortcut::CreateWorktree),
        (KeyCode::Delete | KeyCode::Backspace, _) => Some(Shortcut::RemoveWorktree),
        (KeyCode::Char('S'), true) => Some(Shortcut::RenameWorkspace),
        // Settings overlay: webui `settings: KeyS` is plain S. Only the
        // webui desktop map (core.js) still binds Digit4 to stash; the
        // TUI chord map lost its digit chords in the reduction, so
        // stash lives in-screen in the Stash view and on Ctrl+B z
        // (per-file). The old TUI-only prefix-`s` stash binding moved
        // aside for parity.
        // Webui git `stageAll: KeyG`: prefix G toggles stage all
        // from anywhere (the in-screen Changes `G` stays).
        (KeyCode::Char('G'), true) => Some(Shortcut::GitStageAll),
        // Webui git `focusFile: KeyI` dropped with the git verb
        // reduction: the file list is the in-screen default focus; the
        // TUI-only cwd picker stays on Shift+I.
        (KeyCode::Char('I'), true) => Some(Shortcut::GitCwdPicker),
        // Session manager: webui opens it from the footer button (no
        // prefix default there); Shift+P fills the chord here because
        // plain p is already new tab.
        (KeyCode::Char('P'), true) => Some(Shortcut::SessionManager),
        _ => None,
    }
}

/// Display name of the chord that fires a shortcut, used by the
/// status-line chord echo (desktop showShortcutHintToast parity):
/// the user reads `Ctrl+B w -> worktree list` and learns the chord by
/// use, the same loop the browser toast closes. Every prefix chord in
/// `shortcut_for_key` must have a row here; `run_shortcut` echoes it
/// right before dispatch.
pub fn chord_label(shortcut: Shortcut) -> &'static str {
    match shortcut {
        Shortcut::Help => "Ctrl+B ?",
        Shortcut::Search => "Ctrl+B /",
        Shortcut::Files => "Ctrl+B f",
        Shortcut::Git => "Ctrl+B g",
        Shortcut::Terminal => "Ctrl+B t",
        Shortcut::Refresh => "Ctrl+B r",
        Shortcut::RenamePanel => "Ctrl+B Shift+R",
        Shortcut::NextWorkspace => "Ctrl+B j",
        Shortcut::PrevWorkspace => "Ctrl+B k",
        Shortcut::NextAgent => "Ctrl+B a",
        Shortcut::PrevAgent => "Ctrl+B A",
        Shortcut::NewTab => "Ctrl+B p",
        Shortcut::CloseTab => "Ctrl+B x",
        Shortcut::Quit => "Ctrl+B q",
        Shortcut::Settings => "Ctrl+B s",
        Shortcut::Sidebar => "Ctrl+B Shift+B",
        Shortcut::FocusNext => "Ctrl+B .",
        Shortcut::FocusPrev => "Ctrl+B ,",
        Shortcut::Composer => "Ctrl+B Shift+C",
        Shortcut::Lens => "Ctrl+B Shift+L",
        Shortcut::GitSwitchBranch => "Ctrl+B v",
        Shortcut::EditFile => "Ctrl+B e",
        Shortcut::SettingsOverlay => "Ctrl+B Shift+E",
        Shortcut::GitBlame => "Ctrl+B m (git blame · terminal: move tile)",
        Shortcut::GitUnstageFile => "Ctrl+B u",
        Shortcut::GitStashFile => "Ctrl+B z (stash file · terminal: zoom tile)",
        Shortcut::ResizePane => "Ctrl+B Shift+Z",
        Shortcut::NextPanel => "Ctrl+B ]",
        Shortcut::PrevPanel => "Ctrl+B [",
        Shortcut::OpenWorktrees => "Ctrl+B w",
        Shortcut::CreateWorktree => "Ctrl+B Shift+T",
        Shortcut::RemoveWorktree => "Ctrl+B Del",
        Shortcut::CloseWorkspace => "Ctrl+B Shift+X",
        Shortcut::RenameWorkspace => "Ctrl+B Shift+S",
        Shortcut::NewWorkspace => "Ctrl+B n",
        Shortcut::GitStageAll => "Ctrl+B G",
        Shortcut::GitCwdPicker => "Ctrl+B Shift+I",
        Shortcut::SessionManager => "Ctrl+B Shift+P",
        // No prefix chord fires these variants: they exist for exhaustive
        // matches and future direct bindings; GitPush is in-screen `P`.
        Shortcut::GitPush => "git P (in-screen)",
        Shortcut::GitChanges
        | Shortcut::GitCommit
        | Shortcut::GitLog
        | Shortcut::GitStash
        | Shortcut::GitBranch
        | Shortcut::GitStageFile
        | Shortcut::GitDiscardFile
        | Shortcut::GitFileHistory
        | Shortcut::GitChangesBack
        | Shortcut::GitFocusFile => "in-screen git key",
        Shortcut::SplitPane => "Ctrl+B s (split · other screens: settings)",
        Shortcut::MovePane => "Ctrl+B m (move tile · git: blame)",
        Shortcut::ZoomPane => "Ctrl+B z (zoom tile · git: stash file)",
    }
}

/// Legend for the footer while the Ctrl+B prefix is armed (zellij
/// mode-bar style: the hint line swaps to the keys live in the current
/// mode). Priority order: screens and lifecycle first (g/f/t/w/n plus
/// the dual-dispatch s, review F1: split mode on the Terminal screen in
/// Navigate mode, settings everywhere else), then navigation, panel
/// management, and the git chords last. `fit_hint` drops segments from
/// the END on narrow terminals, so the keys the user reaches for first
/// survive the longest and the `? help` discovery tail is always the
/// last survivor. Every chord here is documented in the help overlay
/// (Ctrl+B ?), the complete reference.
pub fn prefix_legend(screen: TuiScreen, mode: TuiMode) -> &'static str {
    let split_s = screen == TuiScreen::Terminal && mode == TuiMode::Navigate;
    // Same context split chord_label applies to m/z: on the Git and
    // Files screens Ctrl+B m toggles blame and Ctrl+B z stashes, so
    // the armed legend (what the user reads while the prefix is live)
    // must name those meanings there; only the Terminal screen keeps
    // the split move/zoom wording.
    let git_like = screen == TuiScreen::Git || screen == TuiScreen::Files;
    // Every chord shortcut_for_key can dispatch is named here (the
    // drift-guard test pins that), so no "+N more" tail is needed:
    // the list is exhaustive, `? help` closes it.
    if git_like {
        "g git · f files · t terminal · w worktrees · n new · s settings · / search · j/k workspace · a/A agent · ]/[ panel · p tab · x close tab · q quit · B sidebar · C compose · L lens · r refresh · m blame · Z resize · S rename · R rename panel · X close · Del rm wt · T wt · e edit · E settings · I cwd · G stage all · P sessions · , . focus · v branch pick · z stash · u unstage · ? help"
    } else if split_s {
        "g git · f files · t terminal · w worktrees · n new · s split · / search · j/k workspace · a/A agent · ]/[ panel · p tab · x close tab · q quit · B sidebar · C compose · L lens · r refresh · m move · Z resize · z zoom · u unstage · S rename · R rename panel · X close · Del rm wt · T wt · e edit · E settings · I cwd · G stage all · P sessions · , . focus · v branch pick · ? help"
    } else {
        "g git · f files · t terminal · w worktrees · n new · s settings · / search · j/k workspace · a/A agent · ]/[ panel · p tab · x close tab · q quit · B sidebar · C compose · L lens · r refresh · m move · Z resize · S rename · R rename panel · X close · Del rm wt · T wt · e edit · E settings · I cwd · G stage all · P sessions · , . focus · v branch pick · z stash · u unstage · ? help"
    }
}

/// Help rows for the overlay. Each row is (keys, description).
pub fn help_rows() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Ctrl+B", "prefix for shortcuts below"),
        ("j/k or arrows", "move selection"),
        ("Enter", "attach terminal / open file / expand"),
        ("Ctrl+G", "detach terminal"),
        ("Tab", "toggle workspace/agent list"),
        ("", ""),
        ("Ctrl+B f", "files explorer"),
        ("Ctrl+B g", "git panel"),
        ("Ctrl+B t", "terminal view"),
        ("Ctrl+B /", "open search palette"),
        ("Ctrl+B ?", "help (T replays the onboarding tour)"),
        ("Ctrl+B r", "refresh"),
        ("Ctrl+B j/k", "next/prev workspace"),
        ("Ctrl+B a/A", "next/prev agent"),
        ("Ctrl+B p/x", "new/close tab"),
        ("Ctrl+B ]/[", "next/prev panel in workspace"),
        ("Ctrl+B n", "new workspace (browse folders, Enter picks)"),
        ("Ctrl+B Shift+S", "rename workspace"),
        ("Ctrl+B Shift+R", "rename panel"),
        ("Ctrl+B Shift+X", "close workspace (y confirms)"),
        ("Ctrl+B w", "browse worktrees/folders, Enter opens"),
        (
            "Ctrl+B Shift+T",
            "create worktree (base, branch, then path)",
        ),
        ("Ctrl+B Del", "remove linked worktree"),
        (
            "Ctrl+B /",
            "search palette: Enter opens, Ctrl+X removes a recent",
        ),
        ("Ctrl+B q", "quit (y confirms, Esc stays)"),
        ("Ctrl+B Shift+B", "collapse/expand the sidebar"),
        ("Ctrl+B . ,", "focus next/prev region (sidebar/main)"),
        (
            "Ctrl+B Shift+L",
            "chat lens: transcript view (j/k scroll, Esc close)",
        ),
        (
            "Ctrl+B Shift+C",
            "composer: send a message to the selected panel",
        ),
        ("", ""),
        (
            "git screen keys",
            "view switching and file verbs are in-screen keys",
        ),
        (
            "git: Tab",
            "cycle views (changes, log, branches, stash, ...)",
        ),
        ("git: c/l", "commit modal / log view (in-screen)"),
        (
            "git: s/d/G",
            "stage / discard / toggle stage all (in-screen)",
        ),
        ("git: u", "unstage file (also Ctrl+B u from anywhere)"),
        ("git: m", "toggle blame (also Ctrl+B m from anywhere)"),
        ("git: z", "stash changes (also Ctrl+B z from anywhere)"),
        ("git: P", "push (in-screen on the Git screen)"),
        ("", ""),
        (
            "Ctrl+B e",
            "edit current file (files preview or git changes)",
        ),
        ("", ""),
        (
            "files: e",
            "edit open preview (Ctrl-S save, Ctrl-R reload, Esc stop)",
        ),
        ("files: R/x", "rename / delete selected file"),
        (
            "git: f/p/P",
            "fetch / pull / push (s stage, d discard, r refresh)",
        ),
        (
            "git: J/K/H (changes)",
            "hunk cursor / apply (stage when unstaged, unstage when staged)",
        ),
        ("git: D", "delete branch (branches) / drop stash (stash)"),
        ("git: Enter", "log: compare commit with parent"),
        ("git: Space (log)", "mark commit for compare (keep last 2)"),
        (
            "git: Enter (log, 2 marked)",
            "compare the two marked commits",
        ),
        (
            "git: t/R/b (log)",
            "tag / reset (soft, mixed, hard) / rebase selected commit",
        ),
        (
            "git: s/+ (log)",
            "cycle scope (all/base+current/base) / load more",
        ),
        (
            "git: w (log)",
            "worktree from branch (base, branch, then path)",
        ),
        ("files: L", "git log of the selected file"),
        ("files: M", "markdown preview: outline view of the headers"),
        (
            "files: / + t",
            "search files/folders/content, t cycles the scope",
        ),
        (
            "files: content search",
            "Enter opens match (jump-to-line), + more, A/X toggles",
        ),
        ("files: a/A", "new file / new directory under the cursor"),
        ("files: Tab", "cycle recently opened previews"),
        ("files: w", "reveal the git-panel file in the tree"),
        (
            "edit: Ctrl+F/H",
            "find (A case, X regex, Enter next) / replace (! = all)",
        ),
        (
            "git: / (changes)",
            "diff search: n/N cycle, Enter keeps, Esc clears",
        ),
        ("git: c (branches)", "create and switch to a new branch"),
        (
            "git: B (branches)",
            "create and switch to a new branch (c is commit)",
        ),
        (
            "Ctrl+B s",
            "settings overlay (t cycles) · terminal: split tile mode",
        ),
        (
            "Ctrl+B Shift+E",
            "settings overlay from any screen (works where Ctrl+B s splits)",
        ),
        (
            "open/create workspace",
            "the new workspace appears as a split tile beside the focus",
        ),
        ("Ctrl+B m", "git blame toggle · terminal: move tile mode"),
        ("Ctrl+B z", "git stash changes · terminal: zoom tile"),
        (
            "Shift+Z (terminal)",
            "resize mode: h/l narrower/wider, j/k shorter/taller, Enter/Esc done",
        ),
        (
            "hjkl (split)",
            "walk tile focus · Ctrl+hjkl scrolls the focused pane",
        ),
        (
            "Shift+L / Shift+C",
            "chat lens / composer (plain keys on terminal, no prefix)",
        ),
        (
            "Ctrl+B Shift+P",
            "session manager (Enter targets, l launch, x close, c cleanup, n new)",
        ),
        ("Ctrl+B G", "git: toggle stage all"),
        ("Ctrl+B Shift+I", "git cwd: type a repo path"),
    ]
}

/// Rows kept for the Help overlay after applying the user's filter.
/// Mirrors the webui settings search: case-insensitive substring match
/// over both the key sequence and the description; empty separator rows
/// are dropped so filtered output stays compact.
pub fn filtered_help_rows(filter: &str) -> Vec<(&'static str, &'static str)> {
    let query = filter.trim().to_ascii_lowercase();
    if query.is_empty() {
        return help_rows();
    }
    help_rows()
        .into_iter()
        .filter(|(keys, description)| {
            !keys.is_empty()
                && (keys.to_ascii_lowercase().contains(&query)
                    || description.to_ascii_lowercase().contains(&query))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctrl(ch: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(ch), KeyModifiers::CONTROL)
    }

    fn key(ch: char) -> KeyEvent {
        KeyEvent::from(KeyCode::Char(ch))
    }

    fn shift_key(ch: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(ch.to_ascii_uppercase()), KeyModifiers::SHIFT)
    }

    #[test]
    fn prefix_arms_on_ctrl_b_and_cancels_on_escape() {
        let mut prefix = PrefixState::new();
        assert!(prefix.feed(ctrl('b')).is_none());
        assert!(prefix.is_armed());
        assert!(prefix.feed(key('g')).is_some());
        assert!(!prefix.is_armed());

        prefix.arm();
        assert!(prefix.feed(KeyEvent::from(KeyCode::Esc)).is_none());
        assert!(!prefix.is_armed());
    }

    #[test]
    fn double_prefix_toggles_off() {
        let mut prefix = PrefixState::new();
        prefix.feed(ctrl('b'));
        assert!(prefix.is_armed());
        prefix.feed(ctrl('b'));
        assert!(!prefix.is_armed());
    }

    #[test]
    fn prefix_maps_shortcuts_like_webui_defaults() {
        let mut prefix = PrefixState::new();
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('f')), Some(Shortcut::Files));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('g')), Some(Shortcut::Git));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('/')), Some(Shortcut::Search));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('j')), Some(Shortcut::NextWorkspace));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('a')), Some(Shortcut::NextAgent));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('a')), Some(Shortcut::PrevAgent));
    }

    #[test]
    fn prefix_git_shortcuts_match_webui_git_map() {
        let mut prefix = PrefixState::new();
        // Chord reduction: the duplicated git chords (1-4, b, h/o, y/d)
        // are gone; u/z/m stay as the only prefix path to their verbs.
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('1')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('b')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('y')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('u')), Some(Shortcut::GitUnstageFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('z')), Some(Shortcut::GitStashFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('h')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('o')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('m')), Some(Shortcut::GitBlame));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('0')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('e')), Some(Shortcut::EditFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('.')), Some(Shortcut::FocusNext));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key(',')), Some(Shortcut::FocusPrev));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('b')), Some(Shortcut::Sidebar));
    }

    #[test]
    fn non_armed_keys_do_not_dispatch_shortcuts() {
        let mut prefix = PrefixState::new();
        assert_eq!(prefix.feed(key('f')), None);
        assert_eq!(prefix.feed(key('1')), None);
        assert!(!prefix.is_armed());
    }

    #[test]
    fn prefix_expires_after_the_arm_window() {
        // Freshly armed: the deadline-aware is_armed keeps it armed.
        let mut prefix = PrefixState::new();
        prefix.feed(ctrl('b'));
        assert!(prefix.is_armed());
        // Push past the 5s window (desktop default): the chord key
        // after it must not dispatch a shortcut.
        prefix.armed_at = Some(Instant::now() - PREFIX_ARM_WINDOW - Duration::from_millis(50));
        assert!(!prefix.is_armed());
        assert_eq!(prefix.feed(key('f')), None);
    }

    #[test]
    fn session_and_git_chords_map_to_shortcuts() {
        let mut prefix = PrefixState::new();
        // Shift+P opens the session manager (webui surface has a footer
        // button; the chord is free in the desktop map).
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('p')), Some(Shortcut::SessionManager));
        // Plain G stages all (desktop stageAll: KeyG).
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('g')), Some(Shortcut::GitStageAll));
        // The old plain-i focusFile chord is gone with the git verb
        // reduction (the file list is the in-screen default focus);
        // Shift+I stays the cwd picker.
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('i')), None);
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('i')), Some(Shortcut::GitCwdPicker));
    }

    #[test]
    fn every_prefix_chord_has_a_chord_label() {
        // Drift guard: every Shortcut that shortcut_for_key can return
        // must have a chord_label row that is not the placeholder.
        let dispatchable: Vec<Shortcut> = [
            '?', '/', 'f', 'g', 't', 'r', 'R', 'j', 'k', 'a', 'A', 'p', 'n', 'x', 'X', 'q', 's',
            'B', '.', ',', 'C', 'L', 'z', 'Z', 'v', 'e', 'E', 'm', ']', '[', 'w', 'T', 'S', 'G',
            'I', 'P',
        ]
        .into_iter()
        .filter_map(|ch| shortcut_for_key(key(ch)))
        .collect();
        assert!(
            dispatchable.len() > 20,
            "the chord table must stay populated"
        );
        for shortcut in dispatchable {
            let label = chord_label(shortcut);
            assert_ne!(
                label, "in-screen git key",
                "dispatchable {shortcut:?} must document a real chord"
            );
        }
    }

    #[test]
    fn chord_labels_pin_terminal_and_in_screen_variants() {
        // Terminal-pane chords and the in-screen git P have no
        // prefix-chord echo test above, so their labels are pinned here
        // verbatim (terminal chords are context-swapped variants of the
        // same physical keys as settings/git chords).
        assert_eq!(chord_label(Shortcut::RemoveWorktree), "Ctrl+B Del");
        assert_eq!(chord_label(Shortcut::GitPush), "git P (in-screen)");
        // The exhaustive in-screen group shares one label.
        assert_eq!(
            chord_label(Shortcut::GitChanges),
            chord_label(Shortcut::GitFocusFile)
        );
        assert_eq!(chord_label(Shortcut::GitFocusFile), "in-screen git key");
        assert_eq!(
            chord_label(Shortcut::SplitPane),
            "Ctrl+B s (split · other screens: settings)"
        );
        assert_eq!(
            chord_label(Shortcut::MovePane),
            "Ctrl+B m (move tile · git: blame)"
        );
        assert_eq!(
            chord_label(Shortcut::ZoomPane),
            "Ctrl+B z (zoom tile · git: stash file)"
        );
    }

    #[test]
    fn every_prefix_chord_appears_in_both_legend_variants() {
        // Drift guard (b3): the chord_label test only pins the echo
        // labels; this one pins the armed legend instead. Every chord
        // shortcut_for_key can dispatch must be named by its key in
        // BOTH the Terminal (non-split) legend and the git-like
        // (Git/Files) legend, or the user reads a legend that hides a
        // live key.
        let dispatchable: Vec<(char, Shortcut)> = [
            '?', '/', 'f', 'g', 't', 'r', 'R', 'j', 'k', 'a', 'A', 'p', 'n', 'x', 'X', 'q', 's',
            'B', '.', ',', 'C', 'L', 'z', 'Z', 'v', 'e', 'E', 'm', ']', '[', 'w', 'T', 'S', 'G',
            'I', 'P',
        ]
        .into_iter()
        .filter_map(|ch| shortcut_for_key(key(ch)).map(|shortcut| (ch, shortcut)))
        .collect();
        assert!(
            dispatchable.len() > 20,
            "the chord table must stay populated"
        );
        let terminal_legend = prefix_legend(TuiScreen::Terminal, TuiMode::Navigate);
        let git_legend = prefix_legend(TuiScreen::Git, TuiMode::Navigate);
        for (ch, shortcut) in dispatchable {
            // Keys that share one legend segment (j/k, a/A, ]/[) are
            // named by the pair token, not a lone-char token.
            let key_token = match ch {
                'j' | 'k' => "j/k",
                'a' | 'A' => "a/A",
                ']' | '[' => "]/[",
                '/' => "/",
                '?' => "?",
                _ => {
                    // Segment-leading token (single key or Shift key):
                    // the char starts its own legend segment.
                    let token = format!("{ch} ");
                    assert!(
                        terminal_legend.contains(&token),
                        "terminal legend misses {ch} ({shortcut:?})"
                    );
                    assert!(
                        git_legend.contains(&token),
                        "git legend misses {ch} ({shortcut:?})"
                    );
                    continue;
                }
            };
            assert!(
                terminal_legend.contains(key_token),
                "terminal legend misses {ch} ({shortcut:?})"
            );
            assert!(
                git_legend.contains(key_token),
                "git legend misses {ch} ({shortcut:?})"
            );
        }
    }

    #[test]
    fn prefix_legend_names_blame_and_stash_on_git_like_screens() {
        // b2: on Git/Files screens Ctrl+B m toggles blame and Ctrl+B z
        // stashes, so the armed legend must say blame/stash there; the
        // Terminal legend keeps the split move/zoom wording.
        let git = prefix_legend(TuiScreen::Git, TuiMode::Navigate);
        let files = prefix_legend(TuiScreen::Files, TuiMode::Navigate);
        let terminal = prefix_legend(TuiScreen::Terminal, TuiMode::Navigate);
        for legend in [git, files] {
            assert!(legend.contains("m blame"), "git-like legend: {legend}");
            assert!(legend.contains("z stash"), "git-like legend: {legend}");
            assert!(!legend.contains("z zoom"), "git-like legend: {legend}");
            assert!(!legend.contains("m move"), "git-like legend: {legend}");
        }
        assert!(terminal.contains("m move"), "terminal legend: {terminal}");
        assert!(!terminal.contains("z stash"), "terminal legend: {terminal}");
        // The non-split Terminal variant keeps z for tile zoom only on
        // the split legend; the plain variant drops it (no split tree).
        let split = prefix_legend(TuiScreen::Terminal, TuiMode::Navigate);
        assert!(split.contains("z zoom"), "split legend: {split}");
    }

    #[test]
    fn help_rows_cover_prefix_and_panels() {
        let rows = help_rows();
        assert!(rows.iter().any(|(keys, _)| keys.contains("Ctrl+B f")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("git: Tab")));
        assert!(rows
            .iter()
            .any(|(_, description)| description.contains("files")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("git: J/K/H")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("Space (log)")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("files: M")));
    }

    #[test]
    fn shortcut_labels_cover_workspace_and_focus_actions() {
        for shortcut in [
            Shortcut::NextPanel,
            Shortcut::PrevPanel,
            Shortcut::NewWorkspace,
            Shortcut::OpenWorktrees,
            Shortcut::CreateWorktree,
            Shortcut::CloseWorkspace,
            Shortcut::RemoveWorktree,
            Shortcut::RenamePanel,
            Shortcut::RenameWorkspace,
            Shortcut::GitCwdPicker,
            Shortcut::Settings,
            Shortcut::SettingsOverlay,
            Shortcut::Sidebar,
            Shortcut::FocusNext,
            Shortcut::FocusPrev,
            Shortcut::Lens,
            Shortcut::Composer,
            Shortcut::GitStageAll,
            Shortcut::GitFocusFile,
            Shortcut::SessionManager,
            Shortcut::SplitPane,
            Shortcut::MovePane,
            Shortcut::ZoomPane,
            Shortcut::ResizePane,
        ] {
            assert!(!shortcut.label().is_empty());
        }
    }

    #[test]
    fn prefix_maps_workspace_worktree_and_cwd_shortcuts() {
        let cases = [
            (key('w'), Shortcut::OpenWorktrees),
            (KeyEvent::from(KeyCode::Delete), Shortcut::RemoveWorktree),
            (KeyEvent::from(KeyCode::Backspace), Shortcut::RemoveWorktree),
            (shift_key('s'), Shortcut::RenameWorkspace),
            (KeyEvent::from(KeyCode::Char('I')), Shortcut::GitCwdPicker),
        ];

        for (event, shortcut) in cases {
            let mut prefix = PrefixState::new();
            prefix.feed(ctrl('b'));
            assert_eq!(prefix.feed(event), Some(shortcut));
        }
    }

    #[test]
    fn shift_r_renames_panel_while_plain_r_refreshes() {
        let mut prefix = PrefixState::new();
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('r')), Some(Shortcut::Refresh));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('r')), Some(Shortcut::RenamePanel));
    }
}
