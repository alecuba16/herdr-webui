use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Herdr-style prefix state machine for the TUI.
///
/// `Ctrl+B` is the main switch key (same default as the WebUI). Pressing it
/// arms the prefix for a short window; the next key dispatches a shortcut
/// instead of reaching the terminal or panel. `Esc` cancels the prefix.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PrefixState {
    armed: bool,
}

impl PrefixState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    pub fn arm(&mut self) {
        self.armed = true;
    }

    pub fn cancel(&mut self) {
        self.armed = false;
    }

    /// Feed a key event. Returns the shortcut that should run, if any.
    pub fn feed(&mut self, key: KeyEvent) -> Option<Shortcut> {
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
    GitStageAll,
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
    // Sidebar visibility (webui sidebar: KeyB is plain B, so the TUI
    // uses Shift+B; plain b stays the git branches shortcut).
    Sidebar,
    // Focus walker (webui focusNext/focusPrev: Period/Comma). Cycles
    // sidebar workspaces -> agents -> main screen, the keyboard-only
    // equivalent of the webui DOM focus walker.
    FocusNext,
    FocusPrev,
    // Temporary terminal (webui tempTerminalToggle: Shift+KeyM). The
    // TUI approximates the overlay with a tab labeled "temp" living in
    // a dedicated "temp" workspace.
    TempTerminalToggle,
    // Promote the temporary terminal into a real workspace at the
    // shell's live cwd (webui tempTerminalPromote: Shift+KeyP). The
    // old TUI-only prefix-GitPush moved aside (git screen keeps the
    // in-screen P push).
    TempTerminalPromote,
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
            Self::GitStageAll => "stage all",
            Self::GitStageFile => "stage file",
            Self::GitUnstageFile => "unstage file",
            Self::GitDiscardFile => "discard file",
            Self::GitStashFile => "stash file",
            Self::GitPush => "push",
            Self::GitSwitchBranch => "switch branch",
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
            Self::Sidebar => "toggle sidebar",
            Self::FocusNext => "focus next",
            Self::FocusPrev => "focus previous",
            Self::TempTerminalToggle => "temporary terminal",
            Self::TempTerminalPromote => "promote temporary terminal",
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
        // Webui `stageAll: KeyG` is plain G, but the TUI prefix table
        // already maps plain `g` to the git screen (a TUI-era addition
        // predating the parity work), so stage-all lands on Shift+G.
        (KeyCode::Char('G'), true) => Some(Shortcut::GitStageAll),
        (KeyCode::Char('t'), false) => Some(Shortcut::Terminal),
        (KeyCode::Char('r') | KeyCode::Char('R'), false) => Some(Shortcut::Refresh),
        (KeyCode::Char('j'), false) => Some(Shortcut::NextWorkspace),
        (KeyCode::Char('k'), false) => Some(Shortcut::PrevWorkspace),
        (KeyCode::Char('a'), false) => Some(Shortcut::NextAgent),
        (KeyCode::Char('A'), true) => Some(Shortcut::PrevAgent),
        // Webui newPanel: KeyP. The old `p` => Git was redundant with `g`.
        // Shift+P is now tempTerminalPromote (webui parity); prefix push
        // moved aside, the git screen keeps the in-screen `P` push.
        (KeyCode::Char('p'), false) => Some(Shortcut::NewTab),
        // Webui newWorkspace: KeyN.
        (KeyCode::Char('n') | KeyCode::Char('N'), false) => Some(Shortcut::NewWorkspace),
        (KeyCode::Char('x'), false) => Some(Shortcut::CloseTab),
        (KeyCode::Char('X'), true) => Some(Shortcut::CloseWorkspace),
        (KeyCode::Char('q'), false) => Some(Shortcut::Quit),
        (KeyCode::Char('1'), false) => Some(Shortcut::GitChanges),
        (KeyCode::Char('2'), false) => Some(Shortcut::GitCommit),
        (KeyCode::Char('3'), false) => Some(Shortcut::GitLog),
        (KeyCode::Char('4'), false) => Some(Shortcut::GitStash),
        // Stash used to live on plain `s` (a TUI addition); the webui
        // default binds plain `S` to settings, so `s` now matches the
        // webui and stash stays on `4` (webui `stash: Digit4`).
        (KeyCode::Char('s'), false) => Some(Shortcut::Settings),
        // Webui `help: Digit0` shows the git shortcut help.
        (KeyCode::Char('0'), false) => Some(Shortcut::Help),
        // Sidebar visibility: webui `sidebar: KeyB` is plain B, but plain
        // b is the git branches shortcut (git `branch: KeyV` would be the
        // webui key, TUI keeps b from its own table), so the toggle
        // lands on Shift+B.
        (KeyCode::Char('B'), true) => Some(Shortcut::Sidebar),
        // Webui focusNext/focusPrev: Period/Comma. Walks the TUI focus
        // regions instead of DOM controls.
        (KeyCode::Char('.'), _) => Some(Shortcut::FocusNext),
        (KeyCode::Char(','), _) => Some(Shortcut::FocusPrev),
        // Webui tempTerminalToggle: Shift+KeyM (plain m stays git blame
        // from DEFAULT_GIT_SHORTCUTS).
        (KeyCode::Char('M'), true) => Some(Shortcut::TempTerminalToggle),
        // Webui tempTerminalPromote: Shift+KeyP. The old TUI-only prefix
        // GitPush moved aside for parity (the git screen keeps the
        // in-screen P push).
        (KeyCode::Char('P'), true) => Some(Shortcut::TempTerminalPromote),
        (KeyCode::Char('b'), false) => Some(Shortcut::GitBranch),
        (KeyCode::Char('c'), false) => Some(Shortcut::GitCommit),
        (KeyCode::Char('l') | KeyCode::Char('L'), false) => Some(Shortcut::GitLog),
        (KeyCode::Char('y'), false) => Some(Shortcut::GitStageFile),
        (KeyCode::Char('u'), false) => Some(Shortcut::GitUnstageFile),
        (KeyCode::Char('d'), false) => Some(Shortcut::GitDiscardFile),
        (KeyCode::Char('z'), false) => Some(Shortcut::GitStashFile),
        (KeyCode::Char('v'), false) => Some(Shortcut::GitSwitchBranch),
        // Webui `edit: KeyE` is the plain `e` key, so muscle memory maps plain
        // `e` to EditFile. Amend has no webui prefix shortcut (it is a checkbox
        // in the commit modal); the TUI keeps it on the in-screen `a` key.
        (KeyCode::Char('e') | KeyCode::Char('E'), _) => Some(Shortcut::EditFile),
        // Webui `history: KeyH` shows commits for the selected file;
        // `compare: KeyO` returns to the current changes view;
        // `blame: KeyM` toggles blame annotations in the diff.
        (KeyCode::Char('h') | KeyCode::Char('H'), false) => Some(Shortcut::GitFileHistory),
        (KeyCode::Char('o') | KeyCode::Char('O'), false) => Some(Shortcut::GitChangesBack),
        (KeyCode::Char('m') | KeyCode::Char('M'), false) => Some(Shortcut::GitBlame),
        (KeyCode::Enter, _) => Some(Shortcut::GitCommit),
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
        // Settings overlay: webui `settings: KeyS` is plain S. Stash
        // stays on `4` (webui `stash: Digit4`); the old TUI-only
        // prefix-`s` stash binding moved aside for parity.
        // Git cwd picker: prefix I (no webui default; its location bar is
        // mouse-driven). Uppercase so plain `i` stays free.
        (KeyCode::Char('I'), _) => Some(Shortcut::GitCwdPicker),
        _ => None,
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
        ("Ctrl+B /", "search/filter in panel"),
        ("Ctrl+B ?", "help"),
        ("Ctrl+B r", "refresh"),
        ("Ctrl+B j/k", "next/prev workspace"),
        ("Ctrl+B a/A", "next/prev agent"),
        ("Ctrl+B p/x", "new/close tab"),
        ("Ctrl+B ]/[", "next/prev panel in workspace"),
        ("Ctrl+B n", "new workspace (type a path)"),
        ("Ctrl+B Shift+S", "rename workspace"),
        ("Ctrl+B Shift+X", "close workspace (y confirms)"),
        ("Ctrl+B w", "list worktrees of workspace folder"),
        ("Ctrl+B Shift+T", "create worktree (branch, then path)"),
        ("Ctrl+B Del", "remove linked worktree"),
        ("Ctrl+B q", "quit"),
        ("Ctrl+B Shift+B", "collapse/expand the sidebar"),
        ("Ctrl+B . ,", "focus next/prev region (sidebar/main)"),
        ("Ctrl+B Shift+M", "temporary terminal (open or refocus)"),
        ("Ctrl+B Shift+P", "promote temporary terminal to workspace"),
        ("", ""),
        ("Ctrl+B 1", "git: changes"),
        ("Ctrl+B 2/c", "git: commit modal"),
        ("Ctrl+B 3/l", "git: log"),
        ("Ctrl+B 4", "git: stash"),
        ("Ctrl+B b/v", "git: branches / switch"),
        (
            "Ctrl+B h/o",
            "git: file history (Enter: commit diff) / back to changes",
        ),
        ("Ctrl+B m", "git: toggle blame in the diff"),
        ("Ctrl+B 0", "git: shortcut help"),
        ("Ctrl+B G", "git: toggle stage all"),
        ("Ctrl+B y/u/d/z", "git: stage/unstage/discard/stash file"),
        ("git: P", "git: push (in-screen on the Git screen)"),
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
        ("git: c (log, 2 marked)", "compare the two marked commits"),
        (
            "git: t/R/b (log)",
            "tag / reset (soft, mixed, hard) / rebase selected commit",
        ),
        (
            "git: s/+ (log)",
            "cycle scope (all/base+current/base) / load more",
        ),
        ("git: w (log)", "worktree from branch (branch, then path)"),
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
        ("Ctrl+B I", "git cwd: type a repo path"),
        ("Ctrl+B s", "settings overlay (t cycles the theme)"),
    ]
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
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('1')), Some(Shortcut::GitChanges));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('2')), Some(Shortcut::GitCommit));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('3')), Some(Shortcut::GitLog));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('4')), Some(Shortcut::GitStash));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('g')), Some(Shortcut::GitStageAll));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('y')), Some(Shortcut::GitStageFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('u')), Some(Shortcut::GitUnstageFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('d')), Some(Shortcut::GitDiscardFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('z')), Some(Shortcut::GitStashFile));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('h')), Some(Shortcut::GitFileHistory));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('o')), Some(Shortcut::GitChangesBack));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('m')), Some(Shortcut::GitBlame));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('0')), Some(Shortcut::Help));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('e')), Some(Shortcut::EditFile));
        prefix.feed(ctrl('b'));
        assert_eq!(
            prefix.feed(shift_key('p')),
            Some(Shortcut::TempTerminalPromote)
        );
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key('.')), Some(Shortcut::FocusNext));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(key(',')), Some(Shortcut::FocusPrev));
        prefix.feed(ctrl('b'));
        assert_eq!(prefix.feed(shift_key('b')), Some(Shortcut::Sidebar));
        prefix.feed(ctrl('b'));
        assert_eq!(
            prefix.feed(shift_key('m')),
            Some(Shortcut::TempTerminalToggle)
        );
    }

    #[test]
    fn non_armed_keys_do_not_dispatch_shortcuts() {
        let mut prefix = PrefixState::new();
        assert_eq!(prefix.feed(key('f')), None);
        assert_eq!(prefix.feed(key('1')), None);
        assert!(!prefix.is_armed());
    }

    #[test]
    fn help_rows_cover_prefix_and_panels() {
        let rows = help_rows();
        assert!(rows.iter().any(|(keys, _)| keys.contains("Ctrl+B f")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("Ctrl+B 1")));
        assert!(rows
            .iter()
            .any(|(_, description)| description.contains("files")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("git: J/K/H")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("Space (log)")));
        assert!(rows.iter().any(|(keys, _)| keys.contains("files: M")));
    }
}
