use std::io;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use herdr_webui::backend_client::{BackendClient, TerminalEvent, TerminalOutput};
use herdr_webui::tui::web_api::{default_web_api_port, WebApiClient};
use herdr_webui::tui::{
    build_client, is_menu_key, key_to_terminal_bytes, render, snapshot_summary, TuiApp, TuiMode,
    TuiOptions, TuiScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        println!("{}", help_text());
        return Ok(());
    }

    let cli = Cli::parse(args)?;
    let options = cli.options;
    let client = build_client(&options);

    // No explicit `--webui-api` and a live builtin backend socket: route
    // the git/file panels straight over the control socket (no HTTP
    // server, no auth dance). When the backend is not running the HTTP
    // discover fallback keeps the old behavior.
    let mut web_api = options.web_api;
    if !cli.web_api_explicit && client.api_socket().exists() {
        web_api = WebApiClient::from_backend_socket(client.api_socket());
    }

    if cli.summary {
        print_summary(&client)?;
        return Ok(());
    }

    if cli.once {
        let mut app = TuiApp::new_with_theme(client, options.refresh_interval, options.theme);
        app.refresh()?;
        // No real screen in --once mode: attach_viewport() returns the
        // documented 120x32 fallback, one source of truth for the
        // legacy geometry instead of a second hard-coded copy.
        let (cols, rows) = app.attach_viewport();
        app.load_selected_terminal_history(cols, rows);
        println!("{}", app.text_snapshot());
        return Ok(());
    }

    run_interactive(client, options.refresh_interval, options.theme, web_api)
}

fn print_summary(client: &BackendClient) -> Result<(), Box<dyn std::error::Error>> {
    let ping = client.ping()?;
    let snapshot = client.snapshot()?;
    let parsed = herdr_webui::tui::TuiSnapshot::from_backend_response(&snapshot);
    println!("{}", snapshot_summary(&parsed, Some(&ping)));
    Ok(())
}

fn run_interactive(
    client: BackendClient,
    refresh_interval: Duration,
    theme: herdr_webui::tui::TuiTheme,
    web_api: WebApiClient,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal_guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut app = TuiApp::new_with_options(client, refresh_interval, theme, web_api);
    // Screen size drives attach sizing: the pty must match the pane
    // viewport the tail renders into, so keep the recorded size fresh
    // before the first refresh can attach anything.
    if let Ok(size) = terminal.size() {
        app.set_terminal_size(size.width, size.height);
    }
    app.refresh()?;
    let mut live_terminal: Option<LiveTerminal> = None;
    let mut last_draw = Instant::now();

    loop {
        drain_live_terminal(&mut live_terminal, &mut app);
        if event::poll(Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(key) => {
                    if key.kind == KeyEventKind::Release {
                        continue;
                    }
                    let size = terminal.size()?;
                    dispatch_key(&mut app, &mut live_terminal, key, size.width, size.height)?;
                    if app.should_quit() {
                        break;
                    }
                }
                Event::Resize(width, height) => {
                    app.set_terminal_size(width, height);
                    if let Some(live) = live_terminal.as_mut() {
                        let (cols, rows) = herdr_webui::tui::render::pane_viewport_size(
                            width,
                            height,
                            app.sidebar_collapsed,
                        );
                        if live.needs_resize(cols, rows) {
                            live.resize(cols, rows);
                        }
                    }
                    app.mark_dirty();
                }
                _ => {}
            }
        }

        drain_live_terminal(&mut live_terminal, &mut app);
        app.refresh_if_due();
        if app.take_dirty() || last_draw.elapsed() >= Duration::from_millis(100) {
            terminal.draw(|frame| render(frame, &app))?;
            last_draw = Instant::now();
        }
    }

    terminal_guard.leave()?;
    Ok(())
}

struct LiveTerminal {
    terminal_id: String,
    cols: u16,
    rows: u16,
    command_tx: mpsc::Sender<LiveTerminalCommand>,
    output_rx: mpsc::Receiver<Result<TerminalOutput, String>>,
}

enum LiveTerminalCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    Detach,
}

impl LiveTerminal {
    fn start(client: BackendClient, terminal_id: String, cols: u16, rows: u16) -> Self {
        let (output_tx, output_rx) = mpsc::channel();
        let (command_tx, command_rx) = mpsc::channel();
        let worker_terminal_id = terminal_id.clone();
        thread::spawn(move || {
            let mut terminal = match client.attach_terminal(&worker_terminal_id, cols, rows) {
                Ok(terminal) => terminal,
                Err(err) => {
                    let _ = output_tx.send(Err(err.to_string()));
                    return;
                }
            };
            let mut writer = match terminal.writer() {
                Ok(writer) => writer,
                Err(err) => {
                    let _ = output_tx.send(Err(err.to_string()));
                    return;
                }
            };
            let writer_handle = thread::spawn(move || {
                for command in command_rx {
                    let mut detach = false;
                    let result = match command {
                        LiveTerminalCommand::Input(bytes) => writer.send_input(&bytes),
                        LiveTerminalCommand::Resize(cols, rows) => writer.resize(cols, rows),
                        LiveTerminalCommand::Detach => {
                            detach = true;
                            writer.detach()
                        }
                    };
                    if result.is_err() || detach {
                        break;
                    }
                }
            });
            loop {
                match terminal.read_event() {
                    Ok(TerminalEvent::Output(output)) => {
                        if output_tx.send(Ok(output)).is_err() {
                            break;
                        }
                    }
                    Ok(TerminalEvent::ServerShutdown { reason }) => {
                        let message =
                            reason.unwrap_or_else(|| "terminal server shutdown".to_string());
                        let _ = output_tx.send(Err(message));
                        break;
                    }
                    Ok(_) => {}
                    Err(err) => {
                        let _ = output_tx.send(Err(err.to_string()));
                        break;
                    }
                }
            }
            let _ = writer_handle.join();
        });
        Self {
            terminal_id,
            cols: cols.max(1),
            rows: rows.max(1),
            command_tx,
            output_rx,
        }
    }

    /// True when the stored geometry differs from the wanted one;
    /// used to decide whether a resize command must be sent (the
    /// pty must track the pane viewport, which changes with window
    /// resizes and sidebar toggles).
    fn needs_resize(&self, cols: u16, rows: u16) -> bool {
        self.cols != cols || self.rows != rows
    }

    fn send_input(&self, bytes: Vec<u8>) {
        let _ = self.command_tx.send(LiveTerminalCommand::Input(bytes));
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        let _ = self
            .command_tx
            .send(LiveTerminalCommand::Resize(self.cols, self.rows));
    }

    fn detach(&self) {
        let _ = self.command_tx.send(LiveTerminalCommand::Detach);
    }
}

impl Drop for LiveTerminal {
    fn drop(&mut self) {
        self.detach();
    }
}

/// Route one key press in the interactive loop. Extracted from
/// `run_interactive` so the routing table is unit-testable without a
/// live terminal: `cols`/`rows` stand in for `terminal.size()`.
fn dispatch_key(
    app: &mut TuiApp,
    live_terminal: &mut Option<LiveTerminal>,
    key: crossterm::event::KeyEvent,
    cols: u16,
    rows: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let in_terminal_attach = app.mode == TuiMode::Attach && app.screen == TuiScreen::Terminal;
    // The Ctrl+B prefix always wins, including terminal attach
    // mode, so shortcuts stay available while typing.
    let handled_by_prefix = app.prefix.is_armed() || is_menu_key(key);
    if in_terminal_attach && !handled_by_prefix {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('g') {
            *live_terminal = None;
            app.handle_key(key);
            return Ok(());
        }
        let Some(bytes) = key_to_terminal_bytes(key) else {
            return Ok(());
        };
        ensure_live_terminal(live_terminal, app, cols, rows)?;
        if let Some(live) = live_terminal.as_ref() {
            live.send_input(bytes);
            app.status = "sent input".to_string();
            app.mark_dirty();
        }
        return Ok(());
    }
    app.handle_key(key);
    if app.mode == TuiMode::Attach && app.screen == TuiScreen::Terminal {
        ensure_live_terminal(live_terminal, app, cols, rows)?;
    }
    Ok(())
}

fn ensure_live_terminal(
    live_terminal: &mut Option<LiveTerminal>,
    app: &TuiApp,
    cols: u16,
    rows: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(terminal_id) = app.selected_terminal_id().map(str::to_string) else {
        return Ok(());
    };
    // The pty must be sized to the pane viewport, never the full
    // TUI window: the tail renders inside the pane (minus footer, tab
    // bar, borders, header lines), and a wider pty wraps lines the
    // pane cannot show (duplicated continuation rows, prompt pushed
    // out of view).
    let (viewport_cols, viewport_rows) =
        herdr_webui::tui::render::pane_viewport_size(cols, rows, app.sidebar_collapsed);
    if let Some(live) = live_terminal.as_mut() {
        if live.terminal_id == terminal_id {
            // Same pane: keep the recorded geometry in sync with the
            // current viewport (window resize, sidebar toggle).
            if live.needs_resize(viewport_cols, viewport_rows) {
                live.resize(viewport_cols, viewport_rows);
            }
            return Ok(());
        }
    }
    *live_terminal = Some(LiveTerminal::start(
        app.client.clone(),
        terminal_id,
        viewport_cols.max(1),
        viewport_rows.max(1),
    ));
    Ok(())
}

fn drain_live_terminal(live_terminal: &mut Option<LiveTerminal>, app: &mut TuiApp) {
    let mut should_detach = false;
    if let Some(live) = live_terminal.as_ref() {
        while let Ok(event) = live.output_rx.try_recv() {
            match event {
                Ok(output) => app.ingest_terminal_output(&output),
                Err(err) => {
                    app.error = Some(err);
                    app.mark_dirty();
                    should_detach = true;
                    break;
                }
            }
        }
    }
    if should_detach {
        *live_terminal = None;
    }
}

struct TerminalGuard {
    active: bool,
}

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen)?;
        Ok(Self { active: true })
    }

    fn leave(&mut self) -> io::Result<()> {
        if self.active {
            disable_raw_mode()?;
            execute!(io::stdout(), LeaveAlternateScreen)?;
            self.active = false;
        }
        Ok(())
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = self.leave();
    }
}

#[derive(Debug)]
struct Cli {
    options: TuiOptions,
    summary: bool,
    once: bool,
    /// True when the user passed `--webui-api` explicitly; only then the
    /// HTTP endpoint wins over an available builtin backend socket.
    web_api_explicit: bool,
}

impl Cli {
    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut options = TuiOptions::default();
        let mut web_api: Option<WebApiClient> = None;
        let mut web_api_explicit = false;
        let mut summary = false;
        let mut once = false;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--help" | "-h" => return Err(help_text()),
                "--summary" => summary = true,
                "--once" => once = true,
                "--webui-api" => {
                    web_api_explicit = true;
                    let value = next_value(&mut args, "--webui-api")?;
                    web_api = Some(
                        WebApiClient::parse_url(&value)
                            .map_err(|err| format!("invalid --webui-api value: {err}"))?,
                    );
                }
                "--session" => options.session = Some(next_value(&mut args, "--session")?),
                "--api-socket" => {
                    options.api_socket =
                        Some(PathBuf::from(next_value(&mut args, "--api-socket")?));
                }
                "--terminal-socket" => {
                    options.terminal_socket =
                        Some(PathBuf::from(next_value(&mut args, "--terminal-socket")?));
                }
                "--refresh-ms" => {
                    let value = next_value(&mut args, "--refresh-ms")?;
                    let millis = value
                        .parse::<u64>()
                        .map_err(|_| format!("invalid --refresh-ms value: {value}"))?;
                    options.refresh_interval = Duration::from_millis(millis.max(50));
                }
                "--theme" => {
                    let value = next_value(&mut args, "--theme")?;
                    options.theme = value.parse()?;
                }
                other => return Err(format!("unknown argument: {other}\n{}", help_text())),
            }
        }
        if options.api_socket.is_some() != options.terminal_socket.is_some() {
            return Err("--api-socket and --terminal-socket must be provided together".to_string());
        }
        let web_api = match web_api {
            Some(client) => client,
            None => WebApiClient::discover()
                .unwrap_or_else(|_| WebApiClient::new("127.0.0.1", default_web_api_port())),
        };
        options.web_api = web_api;
        Ok(Self {
            options,
            summary,
            once,
            web_api_explicit,
        })
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn help_text() -> String {
    "Usage: herdr-webui-tui [--session NAME] [--api-socket PATH --terminal-socket PATH] [--webui-api HOST:PORT] [--summary|--once] [--refresh-ms MS] [--theme dark|light|system]\n\nRuns a terminal UI against the built-in backend sockets.\n  --summary         print backend/session summary and exit\n  --once            print a text snapshot and exit\n  --session NAME    use built-in socket namespace, default: default\n  --webui-api URL   WebUI JSON API endpoint for files/git, default: HERDR_WEBUI_TUI_API or settings bind\n  --theme MODE      color theme: system (terminal), dark, or light; default: HERDR_WEBUI_TUI_THEME/JCODE_THEME/system\n\nKeyboard: Ctrl+B is the prefix key, then a shortcut (f files, g git, t terminal, / filter, ? help, q quit)."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_defaults_and_modes() {
        let cli = Cli::parse([
            "--summary".to_string(),
            "--once".to_string(),
            "--session".to_string(),
            "work".to_string(),
            "--refresh-ms".to_string(),
            "250".to_string(),
        ])
        .unwrap();
        assert!(cli.summary);
        assert!(cli.once);
        assert_eq!(cli.options.session.as_deref(), Some("work"));
        assert_eq!(cli.options.refresh_interval, Duration::from_millis(250));
    }

    #[test]
    fn parses_socket_overrides_and_clamps_refresh() {
        let cli = Cli::parse([
            "--api-socket".to_string(),
            "/tmp/herdr.sock".to_string(),
            "--terminal-socket".to_string(),
            "/tmp/herdr-client.sock".to_string(),
            "--refresh-ms".to_string(),
            "1".to_string(),
        ])
        .unwrap();

        assert_eq!(
            cli.options.api_socket,
            Some(PathBuf::from("/tmp/herdr.sock"))
        );
        assert_eq!(
            cli.options.terminal_socket,
            Some(PathBuf::from("/tmp/herdr-client.sock"))
        );
        assert_eq!(cli.options.refresh_interval, Duration::from_millis(50));
    }

    #[test]
    fn parses_theme_flag() {
        let cli = Cli::parse(["--theme".to_string(), "light".to_string()]).unwrap();
        assert_eq!(cli.options.theme, herdr_webui::tui::TuiTheme::Light);
    }

    #[test]
    fn rejects_partial_socket_override() {
        let err =
            Cli::parse(["--api-socket".to_string(), "/tmp/herdr.sock".to_string()]).unwrap_err();
        assert!(err.contains("must be provided together"));
    }

    #[test]
    fn parses_webui_api_flag_and_defaults() {
        let cli = Cli::parse(["--webui-api".to_string(), "127.0.0.1:9000".to_string()]).unwrap();
        assert_eq!(cli.options.web_api.base_url(), "http://127.0.0.1:9000");

        let cli = Cli::parse([
            "--webui-api".to_string(),
            "http://localhost:8787/".to_string(),
        ])
        .unwrap();
        assert_eq!(cli.options.web_api.base_url(), "http://localhost:8787");

        let invalid =
            Cli::parse(["--webui-api".to_string(), "https://host:8787".to_string()]).unwrap_err();
        assert!(invalid.contains("https is not supported"));

        let missing = Cli::parse(["--webui-api".to_string()]).unwrap_err();
        assert!(missing.contains("missing value for --webui-api"));
    }

    fn key_event(code: KeyCode, ctrl: bool) -> event::KeyEvent {
        event::KeyEvent::new(
            code,
            if ctrl {
                KeyModifiers::CONTROL
            } else {
                KeyModifiers::NONE
            },
        )
    }

    fn app_with_terminal_screen() -> TuiApp {
        let client = BackendClient::new("/nonexistent-tui-test.sock", "/nonexistent-tui-test.sock");
        let mut app = TuiApp::new_with_options(
            client,
            Duration::from_secs(1),
            herdr_webui::tui::TuiTheme::Dark,
            WebApiClient::new("127.0.0.1", 1),
        );
        app.snapshot = herdr_webui::tui::TuiSnapshot::from_backend_response(&serde_json::json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
            }
        }));
        app.mode = TuiMode::Attach;
        app.screen = TuiScreen::Terminal;
        app
    }

    #[test]
    fn dispatch_key_sends_input_and_detaches() {
        // Attach on the Terminal screen: plain keys become terminal input.
        let mut app = app_with_terminal_screen();
        let mut live = None;
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('x'), false),
            80,
            24,
        )
        .unwrap();
        assert_eq!(app.status, "sent input", "plain key routes to the terminal");
        assert!(live.is_some(), "a live terminal is attached");

        // Ctrl-G detaches and returns to Navigate.
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('g'), true),
            80,
            24,
        )
        .unwrap();
        assert!(live.is_none(), "Ctrl-G drops the live terminal");
        assert_eq!(app.mode, TuiMode::Navigate);

        // The Ctrl+B prefix still wins in attach mode: arming does not
        // send input.
        app.mode = TuiMode::Attach;
        app.screen = TuiScreen::Terminal;
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('b'), true),
            80,
            24,
        )
        .unwrap();
        assert!(app.prefix.is_armed(), "Ctrl+B arms the prefix");
        assert_eq!(app.status, "detached", "arming sends no input");

        // With the prefix armed, the next key is a shortcut, not input.
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('q'), false),
            80,
            24,
        )
        .unwrap();
        assert_eq!(app.mode, TuiMode::ConfirmQuit, "prefix q asks to quit");
        assert!(!app.should_quit(), "quit needs confirmation");
    }

    #[test]
    fn dispatch_key_ignores_unmapped_key_in_attach_mode() {
        // A key with no terminal-byte mapping (e.g. F1) in attach mode
        // must be a no-op: no live terminal is spun up.
        let mut app = app_with_terminal_screen();
        let mut live = None;
        dispatch_key(&mut app, &mut live, key_event(KeyCode::F(1), false), 80, 24).unwrap();
        assert!(live.is_none(), "unmapped key attaches no live terminal");
        assert_ne!(app.status, "sent input", "no input was sent");
    }

    #[test]
    fn live_terminal_is_sized_to_the_pane_viewport_not_the_window() {
        // Regression: the pty must match the pane viewport (window
        // minus sidebar, footer, tab bar, pane borders, header
        // lines). A full-window or hard-coded pty wraps lines wider
        // than the pane can show, doubling content and pushing the
        // prompt row out of view.
        let mut app = app_with_terminal_screen();
        app.sidebar_collapsed = false;
        let mut live = None;
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('x'), false),
            100,
            30,
        )
        .unwrap();
        let live = live.expect("live terminal attached");
        assert_eq!(
            (live.cols, live.rows),
            (64, 23),
            "pty sized to the pane viewport, not the 100x30 window"
        );

        // Sidebar toggle widens the viewport: the next key resyncs
        // the live terminal instead of keeping the stale geometry.
        app.sidebar_collapsed = true;
        let mut live = Some(live);
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('y'), false),
            100,
            30,
        )
        .unwrap();
        let live = live.expect("live terminal still attached");
        assert_eq!(
            (live.cols, live.rows),
            (98, 23),
            "sidebar toggle resizes the pty to the new viewport"
        );
    }

    #[test]
    fn dispatch_key_routes_panel_keys_without_terminal() {
        // Attach on a non-Terminal screen: keys go to the panel, no live
        // terminal is created.
        let mut app = app_with_terminal_screen();
        app.screen = TuiScreen::Files;
        app.file_explorer = herdr_webui::tui::panels::FileExplorer::new("/repo");
        let mut live = None;
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('j'), false),
            80,
            24,
        )
        .unwrap();
        assert!(live.is_none(), "panel keys need no live terminal");

        // Navigate mode on the Terminal screen with no selection: keys
        // go to the navigation handler without attaching a terminal.
        let mut app = app_with_terminal_screen();
        app.mode = TuiMode::Navigate;
        let mut live = None;
        dispatch_key(
            &mut app,
            &mut live,
            key_event(KeyCode::Char('j'), false),
            80,
            24,
        )
        .unwrap();
        assert!(live.is_none());
    }

    #[test]
    fn rejects_cli_help_missing_invalid_and_unknown_values() {
        let help = Cli::parse(["--help".to_string()]).unwrap_err();
        assert!(help.contains("Usage: herdr-webui-tui"));

        let missing = Cli::parse(["--session".to_string()]).unwrap_err();
        assert!(missing.contains("missing value for --session"));

        let invalid_refresh =
            Cli::parse(["--refresh-ms".to_string(), "fast".to_string()]).unwrap_err();
        assert!(invalid_refresh.contains("invalid --refresh-ms value"));

        let invalid_theme = Cli::parse(["--theme".to_string(), "blue".to_string()]).unwrap_err();
        assert!(invalid_theme.contains("invalid theme 'blue'"));

        let unknown = Cli::parse(["--webui-url".to_string()]).unwrap_err();
        assert!(unknown.contains("unknown argument: --webui-url"));
    }
}
