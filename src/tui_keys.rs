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
        }
    }
}

/// Resolve a key pressed while the prefix is armed. Shift-sensitivity mirrors
/// the WebUI map (for example `Shift+X` vs `X`).
pub fn shortcut_for_key(key: KeyEvent) -> Option<Shortcut> {
    let shifted = key.modifiers.contains(KeyModifiers::SHIFT);
    let code = key.code;
    match (code, shifted) {
        (KeyCode::Char('?'), _) => Some(Shortcut::Help),
        (KeyCode::Char('/'), _) => Some(Shortcut::Search),
        (KeyCode::Char('f') | KeyCode::Char('F'), _) => Some(Shortcut::Files),
        (KeyCode::Char('g'), false) => Some(Shortcut::Git),
        (KeyCode::Char('G'), true) => Some(Shortcut::GitStageAll),
        (KeyCode::Char('t'), false) => Some(Shortcut::Terminal),
        (KeyCode::Char('r') | KeyCode::Char('R'), false) => Some(Shortcut::Refresh),
        (KeyCode::Char('j'), false) => Some(Shortcut::NextWorkspace),
        (KeyCode::Char('k'), false) => Some(Shortcut::PrevWorkspace),
        (KeyCode::Char('a'), false) => Some(Shortcut::NextAgent),
        (KeyCode::Char('A'), true) => Some(Shortcut::PrevAgent),
        (KeyCode::Char('p'), false) => Some(Shortcut::Git),
        (KeyCode::Char('P'), true) => Some(Shortcut::GitPush),
        (KeyCode::Char('n'), false) => Some(Shortcut::NewTab),
        (KeyCode::Char('x'), false) => Some(Shortcut::CloseTab),
        (KeyCode::Char('q'), false) => Some(Shortcut::Quit),
        (KeyCode::Char('1'), false) => Some(Shortcut::GitChanges),
        (KeyCode::Char('2'), false) => Some(Shortcut::GitCommit),
        (KeyCode::Char('3'), false) => Some(Shortcut::GitLog),
        (KeyCode::Char('4'), false) => Some(Shortcut::GitStash),
        // Webui `help: Digit0` shows the git shortcut help.
        (KeyCode::Char('0'), false) => Some(Shortcut::Help),
        (KeyCode::Char('b'), false) => Some(Shortcut::GitBranch),
        (KeyCode::Char('c'), false) => Some(Shortcut::GitCommit),
        (KeyCode::Char('l') | KeyCode::Char('L'), false) => Some(Shortcut::GitLog),
        (KeyCode::Char('s'), false) => Some(Shortcut::GitStash),
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
        ("r", "refresh"),
        ("Tab", "toggle workspace/agent list"),
        ("", ""),
        ("Ctrl+B f", "files explorer"),
        ("Ctrl+B g", "git panel"),
        ("Ctrl+B t", "terminal view"),
        ("Ctrl+B /", "search/filter in panel"),
        ("Ctrl+B ?", "help"),
        ("Ctrl+B j/k", "next/prev workspace"),
        ("Ctrl+B a/A", "next/prev agent"),
        ("Ctrl+B n/x", "new/close tab"),
        ("Ctrl+B q", "quit"),
        ("", ""),
        ("Ctrl+B 1", "git: changes"),
        ("Ctrl+B 2/c", "git: commit"),
        ("Ctrl+B 3/l", "git: log"),
        ("Ctrl+B 4/s", "git: stash"),
        ("Ctrl+B b/v", "git: branches / switch"),
        (
            "Ctrl+B h/o",
            "git: file history (Enter: commit diff) / back to changes",
        ),
        ("Ctrl+B m", "git: toggle blame in the diff"),
        ("Ctrl+B 0", "git: shortcut help"),
        ("Ctrl+B G", "git: toggle stage all"),
        ("Ctrl+B y/u/d/z", "git: stage/unstage/discard/stash file"),
        ("Ctrl+B P", "git: push"),
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
        ("git: D", "delete branch (branches) / drop stash (stash)"),
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
        assert_eq!(prefix.feed(shift_key('p')), Some(Shortcut::GitPush));
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
    }
}
