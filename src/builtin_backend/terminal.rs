//! Pty terminal runtime, subscribers, and OSC-9 tracking.

use super::*;

/// A composer message as sent: trailing newlines are the composer's, not the
/// text's; CRLF reads as one newline. Mirrors upstream `composerMessage`.
pub(super) fn composer_message(text: &str) -> String {
    let trimmed = text.trim_end_matches(['\r', '\n']);
    trimmed.replace("\r\n", "\n").replace('\r', "\n")
}

/// One bracketed paste: newlines become CR inside the paste block so a
/// multi-line message stays one prompt instead of one submit per line.
pub(super) fn bracketed_paste_payload(message: &str) -> String {
    let body = message.replace('\n', "\r");
    format!("\u{1b}[200~{body}\u{1b}[201~")
}

/// Mirrors upstream herdr's `terminal::state::RecentAgentProcessExit`:
/// recorded once when a previously-live agent process disappears from the
/// pane's process tree (the user quit jcode inside the shell, so the pane
/// itself keeps running). While present, the pane must stop reporting the
/// exited agent, otherwise stale screen text / OSC payloads keep a ghost
/// agent row alive in `agent.list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RecentAgentProcessExit {
    pub(super) agent: &'static str,
    pub(super) observed_at: Instant,
}

impl RecentAgentProcessExit {
    /// A record is active until an optional TTL elapses. With
    /// `RECENT_AGENT_EXIT_TTL = None` records stay active until a live agent
    /// process is detected again, matching upstream herdr's behavior.
    pub(super) fn is_active(&self, now: Instant) -> bool {
        RECENT_AGENT_EXIT_TTL.is_none_or(|ttl| now.duration_since(self.observed_at) < ttl)
    }
}

/// Captures the latest OSC 9 progress payload from raw PTY bytes.
/// Some agents emit `ESC]9;<agent>:<state> BEL` as a structured
/// side-channel for agent status detection, avoiding fragile screen-scraping.
/// Real jcode (master) does not emit it; jcode status rides on the terminal
/// title (` · work ~` / ` · last ~`, see `osc_title_status_for_agent`) plus
/// the screen-scrape fallback. This tracker serves agents that do use the
/// channel (amp, codex, hermes, qwen, grok, claude) and a hypothetical jcode
/// build with the herdr_detectable side-channel.
/// This is a minimal state machine that tracks the OSC body between
/// `ESC ]` and `BEL` (0x07) or `ST` (`ESC \`).
///
/// Matching upstream herdr's `AgentOscStateTracker`, the latest payload is
/// retained without a TTL: agents on this channel emit on state change only
/// (upstream jcode dedups in `agent_osc_state`), so a timestamped staleness
/// window would treat every long turn as "no recent status" and silently
/// degrade to screen-scraping.
/// Staleness is handled structurally instead: `reset()` clears the payload
/// when the terminal exits, and `notify_exited` clears it when the agent
/// process disappears.
#[derive(Default)]
pub(super) struct Osc9Tracker {
    pub(super) state: Osc9State,
    pub(super) body: Vec<u8>,
    pub(super) latest_payload: Option<String>,
    /// Latest OSC 0 terminal title, used for `osc_title` detection rules.
    pub(super) latest_title: Option<String>,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub(super) enum Osc9State {
    #[default]
    Ground,
    Escape,
    OscBody,
    OscEscape,
}

impl Osc9Tracker {
    pub(super) fn observe(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            match self.state {
                Osc9State::Ground => {
                    if byte == 0x1b {
                        self.state = Osc9State::Escape;
                    }
                }
                Osc9State::Escape => {
                    if byte == b']' {
                        self.body.clear();
                        self.state = Osc9State::OscBody;
                    } else if byte == 0x1b {
                        self.state = Osc9State::Escape;
                    } else {
                        self.state = Osc9State::Ground;
                    }
                }
                Osc9State::OscBody => match byte {
                    0x07 => {
                        self.finalize();
                        self.state = Osc9State::Ground;
                    }
                    0x1b => self.state = Osc9State::OscEscape,
                    _ => self.body.push(byte),
                },
                Osc9State::OscEscape => {
                    if byte == b'\\' {
                        self.finalize();
                        self.state = Osc9State::Ground;
                    } else {
                        self.body.push(0x1b);
                        self.body.push(byte);
                        self.state = Osc9State::OscBody;
                    }
                }
            }

            if self.body.len() > 4096 {
                self.body.clear();
                self.state = Osc9State::Ground;
            }
        }
    }

    pub(super) fn finalize(&mut self) {
        if let Some((command, payload)) = parse_osc_body(&self.body) {
            if command == b"9" {
                let text = String::from_utf8_lossy(payload);
                let sanitized: String = text.chars().filter(|c| !c.is_control()).collect();
                if !sanitized.is_empty() {
                    self.latest_payload = Some(sanitized);
                }
            } else if command == b"0" || command == b"2" {
                // OSC 0 and OSC 2 both set the terminal title.
                let text = String::from_utf8_lossy(payload);
                let sanitized: String = text.chars().filter(|c| !c.is_control()).collect();
                if !sanitized.is_empty() {
                    self.latest_title = Some(sanitized);
                }
            }
        }
        self.body.clear();
    }

    /// Returns the latest OSC 9 progress payload, or `""` if none has been
    /// seen. The payload is retained until the terminal exits or the agent
    /// process disappears (`reset`), matching upstream herdr's
    /// `AgentOscStateTracker::latest_progress`.
    pub(super) fn latest_progress(&self) -> &str {
        self.latest_payload.as_deref().unwrap_or("")
    }

    /// Extract a stable agent label from the OSC 9 progress payload when the
    /// payload follows a `<agent>:<state>` convention (the herdr_detectable
    /// jcode branch emits `jcode:working`, `jcode:idle`, `jcode:blocked`;
    /// jcode master does not emit OSC 9). This lets the backend
    /// identify the agent from its side-channel even when argv and process-tree
    /// detection fail (e.g. an agent launched through a wrapper script or shell
    /// that hides the binary name).
    pub(super) fn latest_agent_label(&self) -> Option<&'static str> {
        let payload = self.latest_payload.as_deref()?;
        let colon = payload.find(':')?;
        let prefix = &payload[..colon];
        match prefix {
            "jcode" => Some("jcode"),
            _ => None,
        }
    }

    /// Clear all captured payloads. Called when the terminal exits so a stale
    /// OSC status does not persist after the agent process is gone.
    pub(super) fn reset(&mut self) {
        self.latest_payload = None;
        self.latest_title = None;
        self.body.clear();
        self.state = Osc9State::Ground;
    }

    /// Returns the latest OSC 0/2 terminal title, if any.
    pub(super) fn latest_title(&self) -> &str {
        self.latest_title.as_deref().unwrap_or("")
    }
}

pub(super) fn parse_osc_body(body: &[u8]) -> Option<(&[u8], &[u8])> {
    let sep = body.iter().position(|&b| b == b';')?;
    Some((&body[..sep], &body[sep + 1..]))
}

pub(super) struct TerminalRuntime {
    pub(super) _id: String,
    pub(super) child_pid: Option<u32>,
    pub(super) argv: Vec<String>,
    pub(super) event_hub: BuiltinEventHub,
    pub(super) event_context: PaneEventContext,
    pub(super) last_agent_state: Mutex<Option<(Option<String>, String, u64)>>,
    /// Monotonic detection sequence: grabbed at the start of every
    /// detect_and_publish_agent_status run and committed with the result.
    /// The sweeper force pass and the agent_prompt synchronous re-check can
    /// run concurrently with the output path; without a sequence number a
    /// later-started pass with an older tail snapshot could commit after a
    /// newer one and briefly regress the published status. Stale commits
    /// are dropped inside the compare-and-set.
    pub(super) detection_seq: AtomicU64,
    pub(super) last_status_check: Mutex<Option<Instant>>,
    /// Set when output arrived while the status check was throttled. A
    /// trailing-edge sweeper (spawned once per runtime) runs the pending
    /// check when the throttle window expires, so a status flip carried by
    /// the LAST bytes of an output burst is never missed (e.g. a question
    /// dialog printed right after heavy output, then the pane goes silent
    /// while `read` blocks — no further output would ever trigger a check).
    pub(super) pending_status_check: AtomicBool,
    /// Set once when a previously-live agent process disappears from the
    /// process tree while the pane shell keeps running. Suppresses the
    /// exited agent's label until a live agent is detected again.
    pub(super) recent_agent_process_exit: Mutex<Option<RecentAgentProcessExit>>,
    /// Last agent label seen live in this pane's process tree. Arms the
    /// exit record: only a successful process-table read that comes back
    /// empty after this was set records an exit.
    pub(super) last_live_process_agent: Mutex<Option<&'static str>>,
    pub(super) master: Mutex<Box<dyn MasterPty + Send>>,
    pub(super) child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    pub(super) writer: Mutex<Box<dyn Write + Send>>,
    pub(super) scrollback: Mutex<VecDeque<u8>>,
    pub(super) subscribers: Mutex<Vec<TerminalSubscriber>>,
    pub(super) osc9_tracker: Mutex<Osc9Tracker>,
    pub(super) exited: AtomicBool,
    pub(super) jcode_detection_variant: JcodeDetectionVariant,
}

#[derive(Clone)]
pub(super) enum TerminalSubscriberMessage {
    // Arc so append_output allocates the chunk once and every subscriber
    // shares it; cloning the message is a refcount bump, not a Vec copy.
    // (Before: each subscriber got its own to_vec() copy per chunk, which
    // multiplied PTY output volume by the subscriber count.)
    Output(Arc<Vec<u8>>),
    // Attach replay frame. Queued as the first message on the writer
    // channel so the history write and live output writes are serialized
    // by the same thread instead of racing on a dup'ed socket. Carries its
    // own charged length: the re-attach path queues additional replays
    // through the same channel, and the writer must subtract exactly what
    // this send added, not the length captured at the first attach.
    Replay(Box<ServerMessage>, usize),
    Exited,
    // Terminal output backlog exceeded MAX_SUBSCRIBER_PENDING_BYTES: the
    // writer thread sends a shutdown frame instead of leaving the client
    // blocked on read_message forever.
    Overflow,
}

/// One attached terminal client. Unbounded queue: a slow client never
/// silently loses output while it catches up. `pending_bytes` bounds memory
/// for clients that stopped reading; on overflow the subscriber is shed
/// with an explicit Overflow notice, never a silent drop.
pub(super) struct TerminalSubscriber {
    pub(super) tx: mpsc::Sender<TerminalSubscriberMessage>,
    pub(super) pending_bytes: Arc<AtomicUsize>,
}

/// Open a pty, retrying transient failures. Under parallel test load (and
/// busy CI runners) `openpty` can fail with ENXIO ("Device not configured")
/// when the kernel briefly runs out of available ptys; a short backoff retry
/// makes pane creation robust there. Permanent errors surface after the
/// retries are exhausted. The attempt closure is injected so tests can drive
/// the failure path hermetically.
pub(super) fn openpty_with_retry<T, E>(
    rows: u16,
    cols: u16,
    attempt_open: &dyn Fn(u16, u16) -> Result<T, E>,
) -> io::Result<T>
where
    E: std::fmt::Display,
{
    let mut last_err = String::new();
    for attempt in 0..3 {
        match attempt_open(rows, cols) {
            Ok(pair) => return Ok(pair),
            Err(err) => {
                last_err = err.to_string();
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(100 * (attempt + 1)));
                }
            }
        }
    }
    Err(io::Error::other(last_err))
}

impl TerminalRuntime {
    pub(super) fn spawn(
        id: String,
        cwd: PathBuf,
        argv: Vec<String>,
        rows: u16,
        cols: u16,
        event_hub: BuiltinEventHub,
        event_context: PaneEventContext,
        jcode_detection_variant: JcodeDetectionVariant,
    ) -> io::Result<Arc<Self>> {
        let pty_system = native_pty_system();
        // Under parallel test load (and busy CI runners) openpty can fail
        // transiently with ENXIO ("Device not configured") when the kernel
        // briefly runs out of available ptys. A short retry makes pane
        // creation robust there; permanent errors still surface after the
        // retries are exhausted.
        let pair = openpty_with_retry(rows, cols, &|rows, cols| {
            pty_system.openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
        })?;
        let program = argv.first().cloned().unwrap_or_else(default_shell);
        let use_login_shell = argv.len() <= 1 && is_shell_program(&program);
        let shell_for_env = if use_login_shell {
            program.clone()
        } else {
            default_shell()
        };
        let mut command = if use_login_shell {
            CommandBuilder::new_default_prog()
        } else {
            let mut command = CommandBuilder::new(program);
            for arg in argv.iter().skip(1) {
                command.arg(arg);
            }
            command
        };
        for (key, value) in terminal_environment(&shell_for_env) {
            command.env(key, value);
        }
        for key in TERMINAL_ENV_SCRUB_KEYS {
            command.env_remove(key);
        }
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| io::Error::other(err.to_string()))?;
        let child_pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let runtime = Arc::new(Self {
            _id: id,
            child_pid,
            argv,
            event_hub,
            event_context,
            last_agent_state: Mutex::new(None),
            detection_seq: AtomicU64::new(0),
            last_status_check: Mutex::new(None),
            pending_status_check: AtomicBool::new(false),
            recent_agent_process_exit: Mutex::new(None),
            last_live_process_agent: Mutex::new(None),
            master: Mutex::new(pair.master),
            child: Mutex::new(Some(child)),
            writer: Mutex::new(writer),
            scrollback: Mutex::new(VecDeque::new()),
            subscribers: Mutex::new(Vec::new()),
            osc9_tracker: Mutex::new(Osc9Tracker::default()),
            exited: AtomicBool::new(false),
            jcode_detection_variant,
        });
        let runtime_for_reader = Arc::clone(&runtime);
        thread::spawn(move || {
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => runtime_for_reader.append_output(&buf[..n]),
                    Err(_) => break,
                }
            }
            runtime_for_reader.notify_exited();
        });
        // Trailing-edge status sweeper: append_output only checks the status
        // throttle on output arrival; if the last burst landed inside a
        // throttle window, the pending flag stays set until this loop runs
        // the check once the window expires. Exits when the pane is gone.
        {
            let sweeper_runtime = Arc::clone(&runtime);
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(100));
                if sweeper_runtime.exited.load(Ordering::Acquire) {
                    return;
                }
                if !sweeper_runtime
                    .pending_status_check
                    .swap(false, Ordering::AcqRel)
                {
                    continue;
                }
                sweeper_runtime.publish_agent_status_if_changed_force();
            });
        }
        Ok(runtime)
    }

    pub(super) fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }

    /// Probes the pane's process tree for a live agent and updates the exit
    /// record, mirroring upstream herdr's live→absent transition:
    /// - A live agent clears any exit record (the agent is back) and becomes
    ///   the new `last_live_process_agent`.
    /// - A successful read that finds no agent after a previously-live agent
    ///   records the exit exactly once (the armed flag is cleared so repeat
    ///   empty reads do not re-set it).
    /// - A failed `ps` read is a no-op: we cannot distinguish "agent gone"
    ///   from "probe broken", so we keep the previous record state.
    pub(super) fn update_agent_exit_record(
        &self,
        live_agent: Option<&'static str>,
        probe_ok: bool,
    ) {
        if !probe_ok {
            return;
        }
        if let Some(agent) = live_agent {
            if let Ok(mut last_live) = self.last_live_process_agent.lock() {
                *last_live = Some(agent);
            }
            if let Ok(mut record) = self.recent_agent_process_exit.lock() {
                *record = None;
            }
            return;
        }
        let exited_agent = self
            .last_live_process_agent
            .lock()
            .ok()
            .and_then(|mut last_live| last_live.take());
        let Some(agent) = exited_agent else {
            return;
        };
        if let Ok(mut record) = self.recent_agent_process_exit.lock() {
            *record = Some(RecentAgentProcessExit {
                agent,
                observed_at: Instant::now(),
            });
        }
        // Agent quit INSIDE the pane's shell (jcode + Ctrl-C, zsh alive):
        // notify_exited never fires for this, so the DECRST the agent never
        // sent must be synthesized here, exactly at the live->absent
        // transition. The shell still owns the pty, so the agent's DECSET
        // bytes outlived the agent; append_output feeds subscribers and
        // scrollback, which is what flips the web adapter's sniffed mouse
        // mode off. The armed-flag take() above guarantees this runs once
        // per exit, not on repeat empty probes.
        self.append_output(AGENT_EXIT_DECRST_BYTES);
    }

    /// True while an agent process previously seen live in this pane has
    /// exited and no live agent has been detected since. Suppresses the
    /// exited agent's label in presentation and status publishing.
    pub(super) fn recent_agent_exit_active(&self) -> bool {
        self.recent_agent_process_exit
            .lock()
            .ok()
            .and_then(|record| *record)
            .is_some_and(|record| record.is_active(Instant::now()))
    }

    /// Live agent in this pane's process tree, or `None` when the table
    /// read fails (the failure is propagated so callers can treat a broken
    /// probe as a no-op rather than an exit).
    pub(super) fn probe_live_process_agent(&self) -> Option<Option<&'static str>> {
        let pid = self.child_pid()?;
        let processes = process_table().ok()?;
        Some(detect_agent_label_from_processes(pid, &processes))
    }

    pub(super) fn write_input(&self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("terminal writer unavailable"))?;
        writer.write_all(bytes)?;
        writer.flush()
    }

    pub(super) fn resize(&self, rows: u16, cols: u16) {
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub(super) fn subscribe(&self, subscriber: TerminalSubscriber) {
        if self.exited.load(Ordering::Acquire) {
            let _ = subscriber.tx.send(TerminalSubscriberMessage::Exited);
            return;
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.push(subscriber);
        }
    }

    pub(super) fn history_bytes(&self) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|scrollback| scrollback.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Bounded, line-aligned attach replay tail. Cutting raw scrollback at an
    /// arbitrary byte can split an escape sequence mid-way: the client VT
    /// emulator then consumes visible text as sequence payload bytes and
    /// renders garbage on the first rows. Advancing to the first line break
    /// after the cut guarantees the replay starts on a clean sequence
    /// boundary (no escape sequence spans a newline).
    pub(super) fn attach_replay_bytes(&self) -> Vec<u8> {
        let mut bytes = self.history_tail_bytes(ATTACH_REPLAY_MAX_BYTES);
        if bytes.len() < ATTACH_REPLAY_MAX_BYTES {
            return bytes;
        }
        match bytes.iter().position(|&b| b == b'\n' || b == b'\r') {
            Some(at) => {
                bytes.drain(..=at);
                bytes
            }
            // No line break in the whole window (one giant unterminated
            // line): a split escape is possible either way, but dropping
            // everything would show an empty attach. Keep the tail.
            None => bytes,
        }
    }

    /// Last `max_bytes` of raw scrollback, byte-exact (no VT emulation),
    /// for consumers that strip ANSI themselves. The resolution tail
    /// uses this instead of history_bytes: the recency tiebreak matches
    /// a <=400-char chunk, so 64KB bounds the copy and strip that used to
    /// walk the full 8MB scrollback on every conversation poll.
    pub(super) fn history_tail_bytes(&self, max_bytes: usize) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|scrollback| {
                let mut bytes = scrollback
                    .iter()
                    .rev()
                    .take(max_bytes)
                    .copied()
                    .collect::<Vec<_>>();
                bytes.reverse();
                bytes
            })
            .unwrap_or_default()
    }

    pub(super) fn history_tail_text(&self, max_bytes: usize) -> String {
        let bytes = self.history_tail_bytes(max_bytes);
        terminal_screen_text_lossy(&String::from_utf8_lossy(&bytes))
    }

    pub(super) fn append_output(&self, bytes: &[u8]) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.extend(bytes.iter().copied());
            let overflow = scrollback.len().saturating_sub(MAX_SCROLLBACK_BYTES);
            for _ in 0..overflow {
                scrollback.pop_front();
            }
        }
        // Feed raw bytes to the OSC 9 tracker so agent status can be detected
        // via structured payloads (e.g. `ESC]9;jcode:working BEL` on the
        // herdr_detectable branch; jcode master never sends one).
        if let Ok(mut tracker) = self.osc9_tracker.lock() {
            tracker.observe(bytes);
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            let payload = TerminalSubscriberMessage::Output(Arc::new(bytes.to_vec()));
            // Count the chunk before queueing: the writer decrements only
            // after the kernel accepts the frame, so the counter covers the
            // channel backlog AND any in-flight blocked write. The add must
            // land first or the counter wraps.
            subscribers.retain(|subscriber| {
                subscriber
                    .pending_bytes
                    .fetch_add(bytes.len(), Ordering::AcqRel);
                match subscriber.tx.send(payload.clone()) {
                    Ok(()) => {
                        if subscriber.pending_bytes.load(Ordering::Acquire)
                            > MAX_SUBSCRIBER_PENDING_BYTES
                        {
                            // Shed, but queue an Overflow notice behind the
                            // backlog so the writer can tell the client.
                            let _ = subscriber.tx.send(TerminalSubscriberMessage::Overflow);
                            false
                        } else {
                            true
                        }
                    }
                    Err(_) => {
                        // Disconnected writer never dequeues: undo the add.
                        subscriber
                            .pending_bytes
                            .fetch_sub(bytes.len(), Ordering::AcqRel);
                        false
                    }
                }
            });
        }
        // Invalidate cached agent presentation so next agent.list recomputes
        self.publish_agent_status_if_changed();
    }

    pub(super) fn notify_exited(&self) {
        if self.exited.swap(true, Ordering::AcqRel) {
            return;
        }
        // Synthesize the mouse/paste resets the agent never sent (jcode's
        // crossterm restore only flips raw mode, no DECRST). append_output is
        // the only path that matters: it feeds subscribers and scrollback,
        // which is what the web adapter's sniffer keys on. The bytes are
        // deliberately NOT written to the pty master: they would arrive as
        // INPUT to the shell (echoed/buffered as garbage on the command
        // line), and the kernel tty does not track DECSET 1000/1006 anyway
        // (application-level modes).
        self.append_output(AGENT_EXIT_DECRST_BYTES);
        // Compute the agent label one last time so we can publish a final
        // "done" status. After this the tracker is reset, so we capture the
        // label from argv or screen text before clearing.
        let tail = self.history_tail_text(DETECTION_TAIL_BYTES);
        // If the agent process exited recently while the pane shell kept
        // running (jcode quit inside the shell), the exit record is active and
        // the pane must not keep reporting the agent. Only publish a final
        // "done" for an agent the pane still legitimately reports.
        let agent_suppressed = self.recent_agent_exit_active();
        let agent = if agent_suppressed {
            None
        } else {
            detect_agent_label(&self.argv)
                .or_else(|| detect_agent_label_from_text(&tail))
                .or_else(|| {
                    self.osc9_tracker
                        .lock()
                        .ok()
                        .and_then(|t| t.latest_agent_label())
                })
                .map(str::to_string)
        };
        // Clear OSC 9 state so stale payloads do not persist after the agent
        // process exits. Without this, a captured `jcode:working` would keep
        // the pane stuck in "working" even after the process is gone.
        if let Ok(mut tracker) = self.osc9_tracker.lock() {
            tracker.reset();
        }
        // Publish a final "done" status so the UI does not show a stale
        // working/idle state after the process is gone.
        if let Some(ref agent) = agent {
            self.event_hub.publish(
                "pane.agent_status_changed",
                json!({
                    "workspace_id": self.event_context.workspace_id,
                    "tab_id": self.event_context.tab_id,
                    "pane_id": self.event_context.pane_id,
                    "terminal_id": self.event_context.terminal_id,
                    "agent": agent,
                    "agent_status": "done",
                    "status": "done",
                }),
            );
        }
        // Clear cached agent state so the next agent.list recomputes from
        // scratch (pane_agent_presentation will see exited=true → "done").
        if let Ok(mut previous) = self.last_agent_state.lock() {
            previous.take();
        }
        self.event_hub.publish(
            "pane.exited",
            json!({
                "workspace_id": self.event_context.workspace_id,
                "tab_id": self.event_context.tab_id,
                "pane_id": self.event_context.pane_id,
                "terminal_id": self.event_context.terminal_id,
                "reason": "terminal exited",
            }),
        );
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|subscriber| {
                matches!(
                    subscriber.tx.send(TerminalSubscriberMessage::Exited),
                    Ok(())
                )
            });
        }
    }

    /// Resets the status-detection throttle so the next output-driven
    /// `publish_agent_status_if_changed` run is guaranteed to execute.
    /// Only used by tests to avoid racing the spawned shell's prompt output,
    /// which can consume the 500ms throttle window before the synthetic
    /// append_output call lands.
    #[cfg(test)]
    pub(super) fn reset_status_throttle(&self) {
        if let Ok(mut last_check) = self.last_status_check.lock() {
            *last_check = None;
        }
    }

    pub(super) fn publish_agent_status_if_changed(&self) {
        // Throttle status detection to max once per 500ms per terminal
        // This prevents CPU burn during heavy terminal output
        let should_check = self
            .last_status_check
            .lock()
            .map(|mut last_check| {
                let now = Instant::now();
                let should_run = last_check
                    .map(|last| now.duration_since(last) >= Duration::from_millis(500))
                    .unwrap_or(true);
                if should_run {
                    *last_check = Some(now);
                }
                should_run
            })
            .unwrap_or(false);

        if !should_check {
            // Mark pending so the trailing-edge sweeper re-runs the check
            // once the throttle window expires; without it, a flip carried
            // by the last bytes of a burst is lost when the pane goes
            // silent right after (blocked on input with no more output).
            self.pending_status_check.store(true, Ordering::Release);
            return;
        }
        self.pending_status_check.store(false, Ordering::Release);
        // Run the detection core directly. Routing through
        // run_status_detection would re-check the throttle this method just
        // consumed (last_status_check was refreshed a moment ago, so the
        // second gate always fails), starving detection for as long as
        // output keeps flowing: a turn with continuous spinner frames
        // would never publish "working", and even the boot sequence only
        // ever detected via the sweeper's silent-window luck.
        self.detect_and_publish_agent_status();
    }

    /// Un-throttled detection entry point used by the sweeper thread. The
    /// pending flag is cleared by the caller; the throttle bookkeeping in
    /// `run_status_detection` still applies so the sweeper cannot hammer
    /// detection while output keeps flowing.
    pub(super) fn publish_agent_status_if_changed_force(&self) {
        self.run_status_detection();
    }

    /// The pane's last published agent status ("working"/"blocked"/"done"/
    /// "idle"), or None when no agent has been detected yet. The sweeper
    /// guarantees this is fresh even when the flip rode the last bytes of an
    /// output burst (see `pending_status_check`).
    pub(super) fn last_agent_status(&self) -> Option<String> {
        self.last_agent_state
            .lock()
            .ok()
            .and_then(|state| state.as_ref().map(|(_, status, _)| status.clone()))
    }

    /// Server-side composer submit ("agent.prompt" semantics): paste the
    /// message into the pane's PTY as one bracketed paste, then its Enter
    /// after a gap. Runs on the server so the paste→Enter sequence survives
    /// a jittery connection and a locked phone, and so a blocked pane can
    /// refuse before anything is typed (a message typed into an open
    /// permission/question dialog would answer the dialog, never the
    /// composer).
    ///
    /// The Enter gap (300ms) is deliberately outside jcode's 150ms
    /// paste-guard window (`paste_guard.rs`, the #544 Windows Terminal fix):
    /// a trailing Enter inside that window is swallowed as paste residue, so
    /// the submit would silently not happen. Never shorten below ~200ms.
    ///
    /// Takes the runtime Arc because the delayed Enter runs on a detached
    /// thread that must outlive the submitting HTTP request (the phone can
    /// lock or the connection drop between paste and Enter).
    pub(super) fn agent_prompt(self: &Arc<Self>, text: &str) -> Result<(), String> {
        self.agent_prompt_impl(text, false)
    }

    /// Long-press Send (composer enqueue): the message is pasted the
    /// same way, but instead of a plain Enter the server sends the kitty
    /// CSI-u sequence for Ctrl+Enter. jcode maps Ctrl+Enter while
    /// processing to queue_message (a numbered pending row the agent
    /// picks up at the next turn boundary) and submits like Enter while
    /// idle, so the same button works against both states. crossterm
    /// parses CSI-u unconditionally, and the 300ms gap stays outside
    /// jcode's 150ms paste-guard window exactly like agent_prompt.
    pub(super) fn agent_prompt_enqueue(self: &Arc<Self>, text: &str) -> Result<(), String> {
        self.agent_prompt_impl(text, true)
    }

    pub(super) fn agent_prompt_impl(
        self: &Arc<Self>,
        text: &str,
        enqueue: bool,
    ) -> Result<(), String> {
        if self.exited.load(Ordering::Acquire) {
            return Err("agent_exited: terminal has exited".to_string());
        }
        if self.last_agent_status().as_deref() == Some("blocked") {
            return Err(
                "agent_blocked: the agent is waiting for an answer in the terminal".to_string(),
            );
        }
        // The cached status comes from the output-driven detector + the
        // 100ms trailing sweeper, which can lag a fresh permission dialog
        // by up to ~600ms (throttle + sweeper tick) and far longer on a
        // starved machine (observed >10s on a loaded CI runner). A paste
        // that lands inside that window would answer the dialog, so run
        // the detection core once more right here: a submit is a rare
        // user action and the tail parse is milliseconds. This closes the
        // submit-vs-sweeper race instead of merely narrowing it.
        self.detect_and_publish_agent_status();
        if self.last_agent_status().as_deref() == Some("blocked") {
            return Err(
                "agent_blocked: the agent is waiting for an answer in the terminal".to_string(),
            );
        }
        let message = composer_message(text);
        let payload = bracketed_paste_payload(&message);
        self.write_input(payload.as_bytes())
            .map_err(|err| format!("io_error: {err}"))?;
        // The Enter must go even if the submitting client disconnects or
        // locks, so the gap + CR run on a detached thread holding only the
        // runtime Arc.
        let runtime = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(AGENT_PROMPT_ENTER_GAP_MS));
            if runtime.exited.load(Ordering::Acquire) {
                return;
            }
            if enqueue {
                // kitty CSI-u: keycode 13 (Enter) with modifier 5 (Ctrl).
                let _ = runtime.write_input(b"\x1b[13;5u");
            } else {
                let _ = runtime.write_input(b"\r");
            }
        });
        Ok(())
    }

    pub(super) fn run_status_detection(&self) {
        // After the terminal exits, the final "done" status was already
        // published in notify_exited. Skip further detection to avoid CPU
        // waste, stale screen-text false positives, and consuming the
        // throttle window on a dead terminal (the sweeper stops calling
        // once it observes `exited`, but a force call racing the exit must
        // still be a full no-op).
        if self.exited.load(Ordering::Acquire) {
            return;
        }
        let now = Instant::now();
        let should_check = self
            .last_status_check
            .lock()
            .map(|mut last_check| {
                let should_run = last_check
                    .map(|last| now.duration_since(last) >= Duration::from_millis(500))
                    .unwrap_or(true);
                if should_run {
                    *last_check = Some(now);
                }
                should_run
            })
            .unwrap_or(false);
        if !should_check {
            // Window not expired yet (the sweeper woke too early): re-mark
            // pending so the next sweeper tick retries.
            self.pending_status_check.store(true, Ordering::Release);
            return;
        }
        self.detect_and_publish_agent_status();
    }

    /// The detection core shared by the throttled/sweeper paths and the
    /// composer refusal gate: parse the pane tail (+ OSC state) and
    /// publish the resulting (agent, status) pair when it changed.
    /// Throttle-free by design; the callers own rate limiting.
    pub(super) fn detect_and_publish_agent_status(&self) {
        // Reserve the sequence before reading the tail: two concurrent
        // passes get distinct seqs, and a pass that commits after a newer
        // one (higher committed seq) is stale and must not regress the
        // published state.
        let seq = self.detection_seq.fetch_add(1, Ordering::AcqRel) + 1;
        let tail = self.history_tail_text(DETECTION_TAIL_BYTES);
        let (osc_progress, osc_title, osc_agent) = self
            .osc9_tracker
            .lock()
            .map(|tracker| {
                // The OSC 9 payload is retained until the terminal exits
                // (reset) or the agent process disappears (notify_exited
                // resets the tracker). Agents that use this channel emit on
                // state change only, so there is no timestamped freshness
                // window. Note real jcode master emits no OSC 9 progress:
                // status comes from the title rules plus screen-scrape, and
                // this payload path only serves a hypothetical jcode build
                // with the herdr_detectable side-channel.
                let progress = tracker.latest_progress().to_string();
                (
                    progress,
                    tracker.latest_title().to_string(),
                    tracker.latest_agent_label(),
                )
            })
            .unwrap_or_default();
        let process_agent = self
            .probe_live_process_agent()
            .inspect(|&live_agent| {
                self.update_agent_exit_record(live_agent, true);
            })
            // Probe unavailable (no child pid or `ps` failed): treat as a
            // no-op so a broken probe never fabricates an exit record.
            .unwrap_or(None);
        // While a recent agent-process exit is active, stop reporting the
        // exited agent: stale OSC 9 labels and leftover screen text (spinner
        // frames, banners) would otherwise keep the ghost agent alive.
        let agent_suppressed = self.recent_agent_exit_active();
        let agent = if agent_suppressed {
            None
        } else {
            detect_agent_label(&self.argv)
                .or(process_agent)
                .or(osc_agent)
                .or_else(|| detect_agent_label_from_text(&tail))
                .map(str::to_string)
        };
        let status = detect_agent_status_with_osc(
            agent.as_deref(),
            &tail,
            &osc_progress,
            &osc_title,
            self.jcode_detection_variant,
        )
        .to_string();
        let current = (agent.clone(), status.clone());
        let should_publish = self
            .last_agent_state
            .lock()
            .map(|mut previous| {
                // Stale pass: a newer detection already committed after
                // this one started reading its tail. Committing would
                // regress the published status; drop the result instead.
                if previous
                    .as_ref()
                    .is_some_and(|(_, _, committed_seq)| *committed_seq >= seq)
                {
                    return false;
                }
                let changed = previous
                    .as_ref()
                    .map(|(prev_agent, prev_status, _)| {
                        (prev_agent.clone(), prev_status.clone()) != current
                    })
                    .unwrap_or(true);
                // A Some→None agent transition must emit an event so the
                // frontend drops the exited agent from its list; plain shell
                // panes (previous was already None) must not spam events.
                let previous_agent_was_some = previous
                    .as_ref()
                    .is_some_and(|(previous_agent, _, _)| previous_agent.is_some());
                *previous = Some((current.0, current.1, seq));
                changed && (agent.is_some() || previous_agent_was_some)
            })
            .unwrap_or(false);
        if should_publish {
            self.event_hub.publish(
                "pane.agent_status_changed",
                json!({
                    "workspace_id": self.event_context.workspace_id,
                    "tab_id": self.event_context.tab_id,
                    "pane_id": self.event_context.pane_id,
                    "terminal_id": self.event_context.terminal_id,
                    "agent": agent,
                    "agent_status": status,
                    "status": status,
                }),
            );
        }
    }
}

impl TerminalRuntime {
    /// Test-only: kill the pane child and block until it is truly gone.
    /// `Drop` kills without waiting, and jcode's session threads can keep
    /// creating files under `JCODE_HOME` for a while after the kill lands
    /// (observed re-creating `ambient/transcripts` over 1s later under
    /// load), so a cleanup that starts right after `drop(terminal)` races
    /// the dying process. Reaping first makes the scratch-tree removal
    /// deterministic.
    ///
    /// Also blocks until the reader thread observed EOF and ran
    /// notify_exited: the `agent_exited` refusal gate keys on the
    /// `exited` flag, which the reader flips AFTER child.wait() returns,
    /// so a request landing in that gap would paste into a dead PTY and
    /// the refusal assert would flake.
    #[cfg(test)]
    pub(super) fn kill_and_wait(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.exited.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for TerminalRuntime {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            // Reap without blocking the dropping thread: kill delivers
            // SIGKILL, so wait() returns almost immediately, but a Drop on
            // a UI-sensitive thread must never sit in a syscall. An
            // unreaped child would linger as a zombie until server exit.
            // Taking the box out releases the lock before the thread
            // spawn, so the guard never crosses a thread boundary.
            if let Some(child) = child.take() {
                let mut child = child;
                let _ = child.kill();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
        }
    }
}
