//! Onboarding tour overlay (webui parity, `docs/onboarding-tour.md`).
//!
//! Walks the main TUI areas one at a time: each step highlights a region
//! with an accent border, explains what it does, names the shortcut chord
//! that reaches it, and can run the real shortcut action so the UI moves
//! through its own states while the user watches.
//!
//! The tour owns every key (webui tour.js captures before
//! handleGlobalShortcut): `j`/`Right`/`Enter` next step, `k`/`Left`
//! previous, `Esc`/`q`/`?` quit. Everything else, including the Ctrl+B
//! prefix, is swallowed so a mid-tour keypress never leaks into the app
//! underneath.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::tui::keys::Shortcut;
use crate::tui::theme::Palette;
use crate::tui::{TuiApp, TuiMode, TuiScreen};

/// Where the spotlight border is drawn for a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TourRegion {
    /// Whole sidebar column (workspaces + agents).
    Sidebar,
    /// Agent list half of the sidebar.
    Agents,
    /// Main screen area (terminal/files/git).
    Main,
    /// Footer line with the hint bar.
    Footer,
}

#[cfg(test)]
pub(crate) mod tests;

/// One tour step. Kept as a static table: the step list mirrors the
/// webui tour order (search, workspaces, agents, panels, terminal,
/// sidebar views, help, prefix) so both surfaces teach the same story.
#[derive(Debug, Clone)]
pub(crate) struct TourStep {
    pub title: &'static str,
    pub body: &'static str,
    pub region: TourRegion,
    /// The shortcut this step teaches, shown as the chord; the demo runs
    /// the same shortcut through `run_shortcut` so the tour exercises
    /// the real dispatch path, never a parallel copy of the behavior.
    pub shortcut: Option<Shortcut>,
    /// Run the step's action when the step is entered. `None` = passive
    /// step (explain only).
    pub demo: bool,
    /// Optional screen the step needs; the demo switches to it first.
    pub screen: Option<TuiScreen>,
}

impl TourStep {
    /// Chord text for the footer of the card, e.g. `Ctrl+B /`.
    pub(crate) fn chord(&self) -> Option<String> {
        self.shortcut
            .map(|s| format!("Ctrl+B {}", shortcut_key_hint(s)))
    }

    /// Test-only: build a throwaway step to exercise `chord` for
    /// shortcuts the tour steps never teach.
    #[cfg(test)]
    pub(crate) fn chord_hint_for_test(shortcut: Shortcut) -> Option<String> {
        Self {
            title: "",
            body: "",
            region: TourRegion::Main,
            shortcut: Some(shortcut),
            demo: false,
            screen: None,
        }
        .chord()
    }
}

/// Bare key letter(s) for a shortcut as used behind the prefix, matching
/// `shortcut_for_key` (keys.rs) without duplicating its match table: the
/// mapping lives here because the tour is the only surface that renders
/// chords instead of running them.
pub(crate) fn shortcut_key_hint(shortcut: Shortcut) -> &'static str {
    match shortcut {
        Shortcut::Help => "?",
        Shortcut::Files => "f",
        Shortcut::Git => "g",
        Shortcut::Terminal => "t",
        Shortcut::Search => "/",
        Shortcut::Refresh => "r",
        Shortcut::NextWorkspace => "j",
        Shortcut::PrevWorkspace => "k",
        Shortcut::NextAgent => "a",
        Shortcut::PrevAgent => "Shift+A",
        Shortcut::NewTab => "p",
        Shortcut::CloseTab => "x",
        Shortcut::Quit => "q",
        // Terminal screen in Navigate mode takes prefix s for split mode;
        // settings is Shift+E everywhere, so say that instead of a wrong s.
        Shortcut::Settings | Shortcut::SettingsOverlay => "Shift+E",
        Shortcut::Sidebar => "Shift+B",
        Shortcut::FocusNext => ".",
        Shortcut::FocusPrev => ",",
        Shortcut::Lens => "L",
        Shortcut::Composer => "C",
        Shortcut::SessionManager => "Shift+P",
        // Split-panel chords (Terminal screen): the split tour steps
        // teach the tile language with these.
        Shortcut::SplitPane => "s",
        Shortcut::MovePane => "m",
        Shortcut::ZoomPane => "z",
        Shortcut::ResizePane => "Shift+Z",
        // Git chords removed in the chord reduction; the tour teaches the
        // in-screen git keys instead (Tab cycle + c/l).
        Shortcut::GitSwitchBranch => "v",
        Shortcut::NewWorkspace => "n",
        Shortcut::OpenWorktrees => "w",
        // Chords without a stable single key or that need screen context
        // are shown by their action name instead.
        _ => "see help",
    }
}

/// The tour step table. Order matches the webui tour so the story is the
/// same on both surfaces.
pub(crate) fn tour_steps() -> Vec<TourStep> {
    vec![
        TourStep {
            title: "Search palette",
            body: "One palette searches workspaces, panels, agents, files and content. Type a query, j/k moves, Enter opens, Esc closes.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::Search),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Workspaces",
            body: "The sidebar lists open roots and worktrees with pane and tab counts. Enter attaches, j/k moves the selection, Tab switches to the agent list.",
            region: TourRegion::Sidebar,
            shortcut: Some(Shortcut::NextWorkspace),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Agents",
            body: "Agents sit under the workspaces with status colors. Ctrl+B a/A jumps between them in status priority: blocked, done, idle, working.",
            region: TourRegion::Agents,
            shortcut: Some(Shortcut::NextAgent),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Main screen",
            body: "The main area renders the focused pane. The files explorer (Ctrl+B f) and the git panel (Ctrl+B g) live here as their own screens; the next two steps open each one.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::Files),
            demo: false,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Files screen",
            body: "Ctrl+B f opens the file tree of the focused workspace. j/k moves, l or Right enters a directory, h/u goes up, Enter previews (e edits, Ctrl+F finds, Ctrl+H replaces), L shows the file's git log.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::Files),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Git screen",
            body: "Ctrl+B g opens the git surface: Tab cycles changes, log, branches, stash, history, conflicts, cleanup. j/k moves, J/K walk hunks, H stages or unstages a hunk, / searches the diff, c commits.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::Git),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Terminal screen",
            body: "Back on the terminal view: the pane tail streams here, and splits turn the area into tiles (Ctrl+B s on this screen).",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::Terminal),
            demo: true,
            screen: Some(TuiScreen::Git),
        },
        TourStep {
            title: "Split tiles",
            body: "Ctrl+B s opens split mode: a ghost tile previews where the new pane lands. hjkl or arrows move it, Tab flips row/column, p cycles the candidate pane (a fresh shell when every pane is already shown), Enter commits, Esc cancels.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::SplitPane),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "The tile language",
            body: "With a split active and the main region focused, j/k walk tile to tile and Ctrl+j/k scroll the focused pane. Ctrl+B m moves a tile, Ctrl+B z zooms it fullscreen, Ctrl+B Shift+Z resizes it, Ctrl+B x closes the focused tile, and closing a pane hands focus to the nearest surviving tile.",
            region: TourRegion::Main,
            // Passive on purpose: the walk/move/zoom chords need a live
            // multi-tile session with keyboard focus, which the demo
            // runner cannot hand over mid-tour. Every demo step still
            // drives a real chord; this one teaches the map.
            shortcut: Some(Shortcut::ZoomPane),
            demo: false,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Sidebar collapse",
            body: "Ctrl+B Shift+B hides the sidebar column so the main screen takes the full width, same as the webui sidebar toggle.",
            region: TourRegion::Sidebar,
            shortcut: Some(Shortcut::Sidebar),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Chat lens and composer",
            body: "On a chat-capable agent pane (jcode here), Ctrl+B L toggles the transcript lens: j/k scroll, G jumps to the tail, Esc closes. Ctrl+B Shift+C opens the composer prompt for the focused pane and Enter sends.",
            region: TourRegion::Main,
            // The lens is field state, so its demo renders below the
            // card. The composer is taught by text only: its prompt is
            // a key-owning modal, and a demo would cover the card that
            // is explaining it.
            shortcut: Some(Shortcut::Lens),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Session manager",
            body: "Ctrl+B Shift+P lists every session: Enter switches (rebuilding the client on the target's sockets), l launches, x closes, c cleans up stale slots, n creates one, r reloads, Esc closes.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::SessionManager),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Help overlay",
            body: "Ctrl+B ? opens the full shortcut reference with a type-to-filter box. This tour is replayable from there with the T key.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::Help),
            demo: false,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "Settings overlay",
            body: "Ctrl+B Shift+E opens settings: theme (t), terminal passthrough (p), and this tour's run state. T replays the tour right from this overlay; Esc closes.",
            region: TourRegion::Main,
            shortcut: Some(Shortcut::SettingsOverlay),
            demo: true,
            screen: Some(TuiScreen::Terminal),
        },
        TourStep {
            title: "The prefix language",
            body: "Ctrl+B arms the prefix, then the next key runs a shortcut instead of reaching the terminal. Esc cancels. The footer always shows the most useful chords for the current screen.",
            region: TourRegion::Footer,
            shortcut: None,
            demo: false,
            screen: Some(TuiScreen::Terminal),
        },
    ]
}

impl TuiApp {
    /// Open the tour overlay. `open_help_overlay` uses the same
    /// overlay-stack path, so closing the tour returns to whatever
    /// context opened it.
    pub fn open_tour(&mut self) {
        self.tour_index = 0;
        self.tour_finished = false;
        self.tour_demo_overlay = None;
        self.open_overlay(TuiMode::Tour);
        self.run_tour_demo();
    }

    pub fn close_tour(&mut self) {
        self.tour_demo_overlay = None;
        // Every caller runs from handle_tour_key, so the mode is
        // always Tour here; direct test callers may close from any
        // other mode and skip the pop.
        if self.mode == TuiMode::Tour {
            self.close_overlay();
        }
    }

    /// Test-only: drive `run_tour_demo` from the current `tour_index`
    /// so the guard arms (out-of-range, non-demo, chordless steps) run
    /// without walking the whole tour.
    #[cfg(test)]
    pub(crate) fn run_tour_demo_for_test(&mut self) {
        self.run_tour_demo();
    }

    fn run_tour_demo(&mut self) {
        // Only the current step's demo surface stays on screen;
        // entering another step drops the previous palette render.
        self.tour_demo_overlay = None;
        let Some(step) = self.tour_steps().get(self.tour_index).cloned() else {
            return;
        };
        let Some(shortcut) = tour_demo_shortcut(&step) else {
            return;
        };
        // The demo runs the real dispatch: side effects (screen switch,
        // palette open, selection move) show up in the live render under
        // the tour card, exactly as if the user pressed the chord. When
        // the shortcut opens an overlay (search palette), the tour takes
        // the mode back: the demo surface renders below the card and the
        // tour keeps the keys, webui's hideOnDemo step. The overlay-stack
        // entry the open pushed is popped so closing the tour still lands
        // on the pre-tour mode.
        // Every shipped demo step carries its screen; the default
        // constructor leaves None only for non-demo steps, which the
        // chord guard above already returned.
        self.screen = step.screen.expect("demo steps always name a screen");
        let stack_len = self.overlay_stack.len();
        self.run_shortcut(shortcut);
        if self.mode != TuiMode::Tour {
            self.tour_demo_overlay = Some(self.mode);
            // Undo every push the shortcut made, not just one: chained
            // shortcuts (folder picker + prompt) would strand entries.
            self.overlay_stack.truncate(stack_len);
            self.mode = TuiMode::Tour;
        }
    }

    /// Key handler for the tour overlay. Returns true when the tour
    /// consumed the key; the caller then skips every other handler.
    pub fn handle_tour_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        let max = self.tour_steps().len().saturating_sub(1);
        match key.code {
            KeyCode::Char('j') | KeyCode::Right | KeyCode::Enter => {
                if self.tour_index >= max {
                    self.tour_finished = true;
                    self.record_tour_state("done");
                    self.close_tour();
                } else {
                    self.tour_index += 1;
                    self.run_tour_demo();
                }
            }
            KeyCode::Char('k') | KeyCode::Left => {
                if self.tour_index > 0 {
                    self.tour_index -= 1;
                    self.run_tour_demo();
                }
            }
            // Esc/q/? close the tour without finishing; the app state
            // the demos touched (screen, selection, overlays opened by
            // run_shortcut) stays as the user's starting point. Both
            // outcomes persist so the settings overlay can say whether
            // the walkthrough ever ran (webui parity: done vs skipped).
            KeyCode::Esc | KeyCode::Char('?') => {
                self.record_tour_state("skipped");
                self.close_tour();
            }
            KeyCode::Char('q') => {
                self.record_tour_state("skipped");
                self.close_tour();
            }
            _ => {}
        }
    }

    /// Persist the tour outcome to the shared settings file. Best
    /// effort: the settings overlay still shows "not run" when the
    /// write fails, and the status line says why the record is missing.
    fn record_tour_state(&mut self, state: &'static str) {
        match crate::tui::tui_set_tour_state(state) {
            Ok(()) => self.status = format!("tour {state}"),
            Err(err) => self.status = format!("tour state not saved: {err}"),
        }
        self.mark_dirty();
    }

    pub(crate) fn tour_step(&self) -> Option<TourStep> {
        tour_steps().into_iter().nth(self.tour_index)
    }

    fn tour_steps(&self) -> Vec<TourStep> {
        tour_steps()
    }
}

/// Coverage is off because a demo step without a chord is a data
/// invariant guard: every shipped tour demo carries its chord, so the
/// None arm only exists to protect against future step data mistakes.
#[cfg_attr(coverage, coverage(off))]
fn tour_demo_shortcut(step: &TourStep) -> Option<Shortcut> {
    if !step.demo {
        return None;
    }
    step.shortcut
}

/// Draw the tour overlay: accent border around the step's region plus a
/// card with title, body, chord, progress, and key hints. The card is a
/// bottom-anchored float like the prompt inputs, so it never covers the
/// highlighted region.
pub(crate) fn render_tour(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let Some(step) = app.tour_step() else {
        return;
    };
    let steps = tour_steps();

    // Region border: draw over the live layout, color-only change.
    let body = Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height.saturating_sub(1),
    };
    // Mirrors the sidebar column in render::split_screen; narrower
    // terminals shrink it to half the body width.
    let sidebar_width = if body.width >= 100 {
        34
    } else {
        28.min(body.width / 2)
    };
    let region_rect = match step.region {
        TourRegion::Sidebar => Rect {
            x: body.x,
            y: body.y,
            width: sidebar_width.min(body.width),
            height: body.height,
        },
        TourRegion::Agents => Rect {
            x: body.x,
            y: body.y + body.height / 2,
            width: sidebar_width.min(body.width),
            height: body.height / 2,
        },
        // The footer hint line is the bottom row of the area.
        TourRegion::Footer => Rect {
            x: area.x,
            y: area.y + area.height.saturating_sub(1),
            width: area.width,
            height: 1,
        },
        TourRegion::Main => body,
    };
    // ratatui no-ops the block render on an empty rect, so the tiny-area
    // draws skip the border without a guard here.
    let style = Style::default().fg(p.accent).add_modifier(Modifier::BOLD);
    frame.render_widget(
        ratatui::widgets::Block::default()
            .borders(ratatui::widgets::Borders::ALL)
            .border_style(style),
        region_rect,
    );

    // Card anchored bottom-center, same depth language as prompt inputs.
    let width = (area.width.saturating_sub(8)).clamp(30, 72);
    let height = 10u16;
    let card = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + area.height.saturating_sub(height + 2),
        width,
        height,
    };
    // Clear erases the dimmed backdrop under the card; the Paragraph
    // styles paint the panel background back in.
    frame.render_widget(ratatui::widgets::Clear, card);
    let block = ratatui::widgets::Block::default()
        .borders(ratatui::widgets::Borders::ALL)
        .border_style(Style::default().fg(p.accent).bg(p.panel_bg))
        .title(Span::styled(
            format!(" Tour {} / {} ", app.tour_index + 1, steps.len()),
            Style::default()
                .fg(p.accent)
                .add_modifier(Modifier::BOLD)
                .bg(p.panel_bg),
        ));
    let card_style = |style: Style| style.bg(p.panel_bg);
    let mut lines: Vec<Line> = vec![Line::from(Span::styled(
        step.title,
        card_style(Style::default().fg(p.text).add_modifier(Modifier::BOLD)),
    ))];
    // Manual wrap: body words into the card width; the card mixes styled
    // spans, so ratatui's Wrap cannot take the whole Paragraph.
    let inner_width = (width.saturating_sub(2)) as usize;
    let mut line = String::new();
    for word in step.body.split(' ') {
        if line.is_empty() {
            line.push_str(word);
        } else if line.chars().count() + word.chars().count() < inner_width {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(Line::from(Span::styled(
                line.clone(),
                card_style(Style::default().fg(p.muted)),
            )));
            line.clear();
            line.push_str(word);
        }
    }
    // The wrap loop above always leaves at least the first word in
    // `line`, so the flushed row is pushed unconditionally.
    lines.push(Line::from(Span::styled(
        line,
        card_style(Style::default().fg(p.muted)),
    )));
    lines.push(Line::from(""));
    if let Some(chord) = step.chord() {
        lines.push(Line::from(vec![
            Span::styled("Shortcut: ", card_style(Style::default().fg(p.muted))),
            Span::styled(
                chord,
                card_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD)),
            ),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            "Ctrl+B arms the prefix; Esc cancels it.",
            card_style(Style::default().fg(p.muted)),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "j/Enter next · k back · Esc close",
        card_style(Style::default().fg(p.muted)),
    )));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .style(Style::default().bg(p.panel_bg));
    frame.render_widget(paragraph, card);
}

/// Fallback accent when a palette is not at hand (tests build raw rects).
pub const TOUR_FALLBACK_ACCENT: Color = Color::Yellow;
