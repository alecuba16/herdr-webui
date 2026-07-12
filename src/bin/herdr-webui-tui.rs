use std::io;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use herdr_webui::backend_client::{BackendClient, TerminalEvent, TerminalOutput};
use herdr_webui::tui::{
    build_client, key_to_terminal_bytes, render, snapshot_summary, TuiApp, TuiMode, TuiOptions,
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

    if cli.summary {
        print_summary(&client)?;
        return Ok(());
    }

    if cli.once {
        let mut app = TuiApp::new(client, options.refresh_interval);
        app.refresh()?;
        app.load_selected_terminal_history(120, 32);
        println!("{}", app.text_snapshot());
        return Ok(());
    }

    run_interactive(client, options.refresh_interval)?;
    Ok(())
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
) -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal_guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut app = TuiApp::new(client, refresh_interval);
    app.refresh()?;
    let mut live_terminal: Option<LiveTerminal> = None;
    let mut last_draw = Instant::now();

    loop {
        drain_live_terminal(&mut live_terminal, &mut app);
        if event::poll(Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(key) => {
                    if app.mode == TuiMode::Attach {
                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && key.code == KeyCode::Char('g')
                        {
                            live_terminal = None;
                            app.handle_key(key);
                        } else if let Some(bytes) = key_to_terminal_bytes(key) {
                            ensure_live_terminal(&mut live_terminal, &app)?;
                            if let Some(live) = &live_terminal {
                                live.send_input(bytes);
                                app.status = "sent input".to_string();
                                app.mark_dirty();
                            }
                        }
                    } else {
                        app.handle_key(key);
                        if app.mode == TuiMode::Attach {
                            ensure_live_terminal(&mut live_terminal, &app)?;
                        }
                    }
                    if app.should_quit() {
                        break;
                    }
                }
                Event::Resize(_, _) => {
                    if let Some(live) = &live_terminal {
                        let size = terminal.size()?;
                        live.resize(size.width, size.height);
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
            command_tx,
            output_rx,
        }
    }

    fn send_input(&self, bytes: Vec<u8>) {
        let _ = self.command_tx.send(LiveTerminalCommand::Input(bytes));
    }

    fn resize(&self, cols: u16, rows: u16) {
        let _ = self
            .command_tx
            .send(LiveTerminalCommand::Resize(cols, rows));
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

fn ensure_live_terminal(
    live_terminal: &mut Option<LiveTerminal>,
    app: &TuiApp,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(terminal_id) = app.selected_terminal_id().map(str::to_string) else {
        return Ok(());
    };
    if live_terminal
        .as_ref()
        .is_some_and(|live| live.terminal_id == terminal_id)
    {
        return Ok(());
    }
    *live_terminal = Some(LiveTerminal::start(
        app.client.clone(),
        terminal_id,
        120,
        32,
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
}

impl Cli {
    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut options = TuiOptions::default();
        let mut summary = false;
        let mut once = false;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--help" | "-h" => return Err(help_text()),
                "--summary" => summary = true,
                "--once" => once = true,
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
                other => return Err(format!("unknown argument: {other}\n{}", help_text())),
            }
        }
        if options.api_socket.is_some() != options.terminal_socket.is_some() {
            return Err("--api-socket and --terminal-socket must be provided together".to_string());
        }
        Ok(Self {
            options,
            summary,
            once,
        })
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn help_text() -> String {
    "Usage: herdr-webui-tui [--session NAME] [--api-socket PATH --terminal-socket PATH] [--summary|--once] [--refresh-ms MS]\n\nRuns a terminal UI against the built-in backend sockets.\n  --summary       print backend/session summary and exit\n  --once          print a text snapshot and exit\n  --session NAME  use built-in socket namespace, default: default"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_defaults_and_modes() {
        let cli = Cli::parse([
            "--summary".to_string(),
            "--refresh-ms".to_string(),
            "250".to_string(),
        ])
        .unwrap();
        assert!(cli.summary);
        assert_eq!(cli.options.refresh_interval, Duration::from_millis(250));
    }

    #[test]
    fn rejects_partial_socket_override() {
        let err =
            Cli::parse(["--api-socket".to_string(), "/tmp/herdr.sock".to_string()]).unwrap_err();
        assert!(err.contains("must be provided together"));
    }
}
