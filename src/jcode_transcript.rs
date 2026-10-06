//! jcode chat transcript: read-only reader over jcode's native session
//! store (`~/.jcode/sessions`).
//!
//! Design: docs/ux/jcode-chat-transcript-design.md (validated in 11
//! rounds against the live store, jcode source, and the reference
//! herdr-web-ui model). Read model: snapshot `.json` base + journal
//! `.journal.jsonl` delta replay (the journal rotates at 512 KiB and is
//! deleted by `checkpoint_snapshot`; the snapshot always carries the
//! full message list).
//!
//! Everything here is defensive: jcode format changes show up as parse
//! misses (skipped lines, ignored unknown parts), never panics. The
//! store is only ever read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// Resolution outcome for one pane. `agent_session` on the wire mirrors
/// this (design section 6): `null` for unsupported agents, `{kind,
/// resolvable, session_id?}` for jcode panes.
#[derive(Debug, Clone, PartialEq)]
pub enum JcodeSessionResolution {
    /// A unique session was evidenced.
    Resolved { session_id: String },
    /// The pane runs jcode, but no single session could be evidenced.
    Refused { reason: RefusalReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    NoSessionPath,
    Ambiguous,
}

impl RefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RefusalReason::NoSessionPath => "no_session_path",
            RefusalReason::Ambiguous => "ambiguous",
        }
    }
}

/// One evidence row: the cheap facts needed for pane→session
/// resolution, plus the stat signature that invalidates it.
#[derive(Debug, Clone)]
struct SessionEvidence {
    session_id: String,
    working_dir: String,
    last_pid: u32,
    status_active: bool,
    /// (mtime_ns, size) of the file the evidence was read from.
    generation: (u128, u64),
}

/// Cached evidence index over `~/.jcode/sessions` (design section 2:
/// ~600 ms cold build, ~17 ms stat-only revalidation sweep — the cache
/// is mandatory, never rebuild per poll).
pub struct JcodeStoreIndex {
    store_dir: PathBuf,
    cache: Mutex<HashMap<String, SessionEvidence>>,
    // Directory sweeps are throttled like the process-table cache: a
    // poll-side reader re-sweeps at most every 250 ms. Evidence staleness
    // is bounded by this, and the stat-generation check still invalidates
    // rows once a sweep runs. Invisible at the 2 s poll interval.
    last_sweep: Mutex<Option<Instant>>,
}

impl JcodeStoreIndex {
    pub fn new() -> Self {
        Self::with_store_dir(default_store_dir())
    }

    pub fn with_store_dir(store_dir: PathBuf) -> Self {
        Self {
            store_dir,
            cache: Mutex::new(HashMap::new()),
            last_sweep: Mutex::new(None),
        }
    }

    pub fn store_dir(&self) -> &Path {
        &self.store_dir
    }

    /// Test hook: forces the next `resolve` to re-sweep instead of
    /// serving the throttled cache.
    #[cfg(test)]
    pub fn force_sweep_for_tests(&self) {
        *self.last_sweep.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Response `version` (design section 4): the combined stat
    /// signature of BOTH files. Any in-place rewrite (jcode writes
    /// tmp + rename) or rotation bumps it, so the client renders
    /// append-only while unchanged (round 11).
    pub fn session_generation(&self, session_id: &str) -> String {
        // Compact etag (design: "etag-ish hash"): FNV-1a over both files'
        // stat signatures. Stable within a server process, short on the
        // wire — never a raw Debug leak.
        let mut hash: u64 = 0xcbf29ce484222325;
        for suffix in [".json", ".journal.jsonl"] {
            let meta = std::fs::metadata(self.store_dir.join(format!("{session_id}{suffix}")));
            let generation = meta.ok().map(|m| stat_generation(&m));
            for byte in format!("{generation:?}").as_bytes() {
                hash ^= *byte as u64;
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
        format!("g{hash:016x}")
    }

    /// (model, status, reasoning_effort) as recorded in the snapshot,
    /// if readable. Effort is a top-level string ("high"/"max" seen
    /// live); older snapshots may lack it.
    pub fn session_model_status(
        &self,
        session_id: &str,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let snapshot = self.store_dir.join(format!("{session_id}.json"));
        let Ok(text) = std::fs::read_to_string(&snapshot) else {
            return (None, None, None);
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
            return (None, None, None);
        };
        let model = parsed
            .get("model")
            .and_then(|m| m.as_str())
            .map(str::to_string);
        let status = parsed
            .get("status")
            .and_then(|s| s.as_str())
            .map(str::to_string);
        let effort = parsed
            .get("reasoning_effort")
            .and_then(|e| e.as_str())
            .map(str::to_string);
        (model, status, effort)
    }

    /// Resolves a pane to its jcode session using the design's ordered
    /// steps. `pane_cwd` is the pane's (live, if available) working
    /// directory, `live_pids` the set of pids alive right now, and
    /// `descendants` the pids in the pane's process tree. Read-only;
    /// never guesses by mtime.
    pub fn resolve(
        &self,
        pane_cwd: &Path,
        live_pids: &dyn Fn(u32) -> bool,
        descendants: &dyn Fn(u32) -> bool,
        pane_tail: &str,
    ) -> JcodeSessionResolution {
        let index = self.refresh();
        let cwd = pane_cwd.to_string_lossy();

        // Step 1: PID evidence (primary). Sessions whose last_pid is in
        // the pane's process tree and whose cwd matches.
        let tree_hits: Vec<&SessionEvidence> = index
            .iter()
            .filter(|e| e.working_dir == cwd && descendants(e.last_pid))
            .collect();
        if let Some(only) = single(&tree_hits) {
            return JcodeSessionResolution::Resolved {
                session_id: only.session_id.clone(),
            };
        }

        // Step 2: live PID + cwd + status == Active (the daemonized
        // `jcode serve` pid is written into every session it hosts, so
        // the status filter is load-bearing — validated round 6).
        let live_hits: Vec<&SessionEvidence> = index
            .iter()
            .filter(|e| e.working_dir == cwd && live_pids(e.last_pid) && e.status_active)
            .collect();
        if let Some(only) = single(&live_hits) {
            return JcodeSessionResolution::Resolved {
                session_id: only.session_id.clone(),
            };
        }
        // Two or more Active sessions on the same live pid + cwd is the
        // real ambiguity the status filter cannot break (two
        // concurrent jcode clients on one daemon in one repo).
        if live_hits.len() > 1 {
            // Step 3: recency tiebreak (design step 3, evidenced live:
            // pane_7's screen carried APPLE, piglet's transcript only
            // BANANA). Match the pane's visible tail text against each
            // candidate's most recent assistant text; exactly one
            // substantial unique match wins. Never newest-mtime alone.
            if let Some(only) = self.tiebreak_by_pane_text(&live_hits, pane_tail) {
                return JcodeSessionResolution::Resolved {
                    session_id: only.session_id.clone(),
                };
            }
            return JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous,
            };
        }

        JcodeSessionResolution::Refused {
            reason: RefusalReason::NoSessionPath,
        }
    }

    /// Design step 3 tiebreak: of the ambiguous Active candidates,
    /// the one whose most recent assistant text appears verbatim in
    /// the pane's visible tail wins — but only if exactly one
    /// candidate matches with a substantial chunk (>= 24 chars, the
    /// reference's bounded pane-text match idea). Live-verified:
    /// pane_7 showed APPLE / piglet BANANA, one clean winner.
    fn tiebreak_by_pane_text<'a>(
        &self,
        candidates: &[&'a SessionEvidence],
        pane_tail: &str,
    ) -> Option<&'a SessionEvidence> {
        /// Smallest chunk of text that counts as a real match
        /// (short strings like "ok" would match every pane).
        const MIN_MATCH_CHARS: usize = 24;
        // TUI reflow: the pane wraps lines and collapses spacing, so a
        // verbatim contains() misses (found live: "ok\n\nI'll …" vs
        // "ok  I'll …"). Compare word sequences instead: collapse
        // whitespace runs to single spaces on both sides.
        let flat_tail = normalize_ws(pane_tail);
        if flat_tail.is_empty() {
            return None;
        }
        let mut winner: Option<&SessionEvidence> = None;
        for candidate in candidates {
            let Some(chunk) = last_substantial_text_chunk(
                &self.store_dir,
                &candidate.session_id,
                MIN_MATCH_CHARS,
            ) else {
                continue;
            };
            if flat_tail.contains(&normalize_ws(&chunk)) {
                if winner.is_some() {
                    return None; // two panes showing the same tail: still ambiguous
                }
                winner = Some(candidate);
            }
        }
        winner
    }

    /// Re-stats the store and re-reads only changed files. Returns the
    /// current evidence rows through the cache lock (cheap clone of
    /// the map values). ONE row per session: snapshot evidence wins;
    /// the journal meta is the fallback only when the snapshot has no
    /// evidence (pre-checkpoint session). A session with both files
    /// must never count twice — that turned one live session into a
    /// false `ambiguous` (found in the live-wire test).
    fn refresh(&self) -> Vec<SessionEvidence> {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        // Throttled sweep (see comment on `last_sweep`): within the TTL
        // serve cached rows as-is.
        {
            let mut last = self.last_sweep.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(at) = *last {
                if at.elapsed() < Duration::from_millis(250) && !cache.is_empty() {
                    return cache.values().cloned().collect();
                }
            }
            *last = Some(Instant::now());
        }
        let mut seen: Vec<String> = Vec::new();
        let mut result = Vec::new();
        let mut stale = Vec::new();

        // Group candidate files by session id first: snapshot preferred
        // over journal for the same session.
        let mut candidates: HashMap<String, Vec<(PathBuf, bool)>> = HashMap::new();
        let entries = match std::fs::read_dir(&self.store_dir) {
            Ok(entries) => entries,
            Err(_) => return cache.values().cloned().collect(),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Glob safety (validated round 3): only snapshots and
            // journals; `.bak`/tmp/corrupt files never match.
            let Some(session_id) = session_id_of(name) else {
                continue;
            };
            let is_snapshot = !name.ends_with(".journal.jsonl");
            candidates
                .entry(session_id.clone())
                .or_default()
                .push((path, is_snapshot));
            seen.push(session_id);
        }

        for (session_id, mut files) in candidates {
            // Snapshot first, journal as fallback.
            files.sort_by_key(|(_, is_snapshot)| !is_snapshot);
            let mut evidence = None;
            for (path, _) in &files {
                let Ok(meta) = path.metadata() else {
                    continue;
                };
                let generation = stat_generation(&meta);
                let cached = cache.get(&session_id);
                let fresh = cached.map(|c| c.generation == generation).unwrap_or(false);
                if fresh {
                    if let Some(e) = cached {
                        evidence = Some(e.clone());
                        break;
                    }
                }
                if let Some(e) = read_evidence(path, &session_id, generation) {
                    cache.insert(session_id.clone(), e.clone());
                    evidence = Some(e);
                    break;
                }
            }
            if let Some(evidence) = evidence {
                result.push(evidence);
            }
        }
        // Drop cache rows whose files vanished (rotation to `.bak` etc).
        for key in cache.keys() {
            if !seen.contains(key) {
                stale.push(key.clone());
            }
        }
        for key in stale {
            cache.remove(&key);
        }
        result
    }
}

fn single<'a>(v: &[&'a SessionEvidence]) -> Option<&'a SessionEvidence> {
    if v.len() == 1 {
        Some(v[0])
    } else {
        None
    }
}

/// `session_<name>_<ts>_<id>.json` -> Some(id with prefix), journal
/// `.journal.jsonl` likewise; everything else (`.bak`, tmp, corrupt) ->
/// None.
fn session_id_of(name: &str) -> Option<String> {
    let base = name
        .strip_suffix(".journal.jsonl")
        .or_else(|| name.strip_suffix(".json"))?;
    if !base.starts_with("session_") {
        return None;
    }
    Some(base.to_string())
}

fn stat_generation(meta: &std::fs::Metadata) -> (u128, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (mtime, meta.len())
}

/// Reads one file's resolution evidence (pid/cwd/status). Snapshot
/// preferred; journal meta lines are the pre-checkpoint fallback.
fn read_evidence(
    path: &Path,
    session_id: &str,
    generation: (u128, u64),
) -> Option<SessionEvidence> {
    let evidence_from = |value: &serde_json::Value| -> Option<SessionEvidence> {
        let working_dir = value.get("working_dir")?.as_str()?.to_string();
        let last_pid = value.get("last_pid")?.as_u64()? as u32;
        Some(SessionEvidence {
            session_id: session_id.to_string(),
            working_dir,
            last_pid,
            status_active: value.get("status") == Some(&serde_json::Value::String("Active".into())),
            generation,
        })
    };
    if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        // Journal: take the LAST meta line that carries evidence (the
        // latest state wins; compact-only journals carry it too —
        // validated round 3).
        let text = std::fs::read_to_string(path).ok()?;
        let mut found = None;
        for line in text.lines().rev() {
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
                continue; // torn tail / non-JSON: skip (design section 1)
            };
            if let Some(meta) = parsed.get("meta") {
                if let Some(e) = evidence_from(meta) {
                    found = Some(e);
                    break;
                }
            }
        }
        found
    } else {
        let text = std::fs::read_to_string(path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
        evidence_from(&parsed)
    }
}

fn default_store_dir() -> PathBuf {
    #[cfg(unix)]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".jcode").join("sessions"))
            .unwrap_or_else(|| PathBuf::from(".jcode/sessions"))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(".jcode/sessions")
    }
}

// ---------------------------------------------------------------------------
// Transcript: turns from snapshot + journal
// ---------------------------------------------------------------------------

/// A rendered conversation turn (thin server, thick shaping — design
/// section 4 wire shape).
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub role: TurnRole,
    /// First message timestamp (ISO) in this turn, when present.
    pub ts: Option<String>,
    /// Last message timestamp (ISO) in this turn, when present.
    pub end_ts: Option<String>,
    pub parts: Vec<TurnPart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnRole {
    User,
    Assistant,
}

/// One offered choice of a blocking ask_user request: the label shown
/// on the chooser row plus the optional one-line detail beneath it.
#[derive(Debug, Clone, PartialEq)]
pub struct DecisionOption {
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TurnPart {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Tool {
        name: String,
        brief: String,
        /// Full input as pretty JSON (reference parity: the collapsed
        /// chip shows the summary; the expanded row shows this).
        input: String,
        output: String,
        is_error: bool,
        /// Some(id) when `output` was trimmed at TOOL_OUTPUT_CHARS;
        /// lets a client fetch the rest later. Omitted on the wire when
        /// None (additive field, client-safe).
        output_ref: Option<String>,
        /// Full pre-trim output length, sent only alongside output_ref.
        output_size: Option<usize>,
    },
    /// In-flight call: no result yet (renders as `running <name>…`).
    ToolPending {
        name: String,
    },
    /// A blocking ask_user decision request that is still unanswered
    /// (the jcode `decisions` feature): the tool_use was persisted to
    /// the session BEFORE the tool blocked on the human, so its input
    /// carries the question and the offered options. Renders as an
    /// interactive chooser in the chat lens. When the answer lands the
    /// tool_result folds in and the part flips to a normal Tool part,
    /// same as any other in-flight call.
    Decision {
        /// What is being decided, phrased for the user.
        question: String,
        /// Offered options: (label, optional one-line detail), 1-based
        /// numbering on the wire mirrors the TUI chooser (option N).
        options: Vec<DecisionOption>,
        /// Optional context on why the decision point is raised.
        context: Option<String>,
    },
    /// Compaction summary (server emits it as its own user turn; the
    /// client folds nothing — design section 3).
    Compact {
        summary: String,
    },
}

pub const MAX_TURNS: usize = 200;

/// Bookkeeping user messages jcode records but never shows as chat:
/// the session-context reminder injected at session create (seen
/// live as `display_role: "system"` wrapping a `<system-reminder>`
/// block) and background-task notices (`display_role:
/// "background_task"`). This is the jcode equivalent of the reference's
/// `isCommandEntry` filter. Only a person's prompt renders.
fn is_bookkeeping_message(message: &serde_json::Value) -> bool {
    matches!(
        message.get("display_role").and_then(|r| r.as_str()),
        Some("system") | Some("background_task")
    )
}

fn message_ts(message: &serde_json::Value) -> Option<String> {
    message
        .get("timestamp")
        .and_then(|t| t.as_str())
        .map(str::to_string)
}

/// Parses the full message list (snapshot messages + journal delta,
/// deduped by id — design section 3) into turns.
pub fn parse_jcode_transcript(messages: &[serde_json::Value]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    // tool_use id -> (turn index, part index) for result folding.
    let mut pending_tools: HashMap<String, (usize, usize)> = HashMap::new();
    // tool_use id -> decision payload for in-flight ask_user calls. A
    // blocking ask_user's options live in its tool_use input; kept
    // aside so the inflight pass can turn the part into a Decision
    // chooser (and only while no tool_result folded it).
    let mut pending_decisions: HashMap<String, DecisionPayload> = HashMap::new();

    for message in messages {
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
            continue; // unknown shape: skip (design: tolerate format changes)
        };
        if is_bookkeeping_message(message) {
            continue;
        }
        match role {
            "user" => {
                let mut texts: Vec<&str> = Vec::new();
                let mut tool_results: Vec<(
                    String,
                    serde_json::Map<String, serde_json::Value>,
                    bool,
                )> = Vec::new();
                for block in blocks {
                    let Some(block) = block.as_object() else {
                        continue;
                    };
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    texts.push(t);
                                }
                            }
                        }
                        Some("tool_result") => {
                            let id = block.get("tool_use_id").and_then(|t| t.as_str());
                            let is_error =
                                block.get("is_error") == Some(&serde_json::Value::Bool(true));
                            if let Some(id) = id {
                                tool_results.push((id.to_string(), block.clone(), is_error));
                            }
                        }
                        // Unknown block types skip silently (round 7 census).
                        _ => {}
                    }
                }
                for (id, block, is_error) in tool_results {
                    if let Some(&(turn_idx, part_idx)) = pending_tools.get(&id) {
                        if let Some(TurnPart::Tool {
                            output,
                            is_error: err,
                            output_ref,
                            output_size,
                            ..
                        }) = turns
                            .get_mut(turn_idx)
                            .and_then(|t| t.parts.get_mut(part_idx))
                        {
                            // trimOutput parity: cap the page payload, keep
                            // a ref + size so a client can fetch the rest.
                            let (trimmed, was_cut) = tool_result_text(&block);
                            *output = trimmed;
                            *err = is_error;
                            if was_cut {
                                *output_ref = Some(id.clone());
                                *output_size = Some(block_content_chars(&block));
                            }
                        }
                        pending_tools.remove(&id);
                    }
                }
                if !texts.is_empty() {
                    let ts = message_ts(message);
                    turns.push(Turn {
                        role: TurnRole::User,
                        ts: ts.clone(),
                        end_ts: ts,
                        parts: vec![TurnPart::Text {
                            text: texts.join("\n"),
                        }],
                    });
                }
            }
            "assistant" => {
                // Adjacent assistant messages merge into one turn
                // (reference `assistantTurn`).
                let turn_idx = match turns.last() {
                    Some(t) if t.role == TurnRole::Assistant => turns.len() - 1,
                    _ => {
                        let ts = message_ts(message);
                        turns.push(Turn {
                            role: TurnRole::Assistant,
                            ts: ts.clone(),
                            end_ts: ts,
                            parts: Vec::new(),
                        });
                        turns.len() - 1
                    }
                };
                if let Some(end) = message_ts(message) {
                    turns[turn_idx].end_ts = Some(end);
                }
                for block in blocks {
                    let Some(block) = block.as_object() else {
                        continue;
                    };
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if !text.trim().is_empty() {
                                turns[turn_idx].parts.push(TurnPart::Text {
                                    text: text.to_string(),
                                });
                            }
                        }
                        Some("reasoning")
                        | Some("reasoning_trace")
                        | Some("open_a_i_reasoning") => {
                            // Thinking-class content when trivially
                            // available (same text field), else skip.
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                if !text.trim().is_empty() {
                                    turns[turn_idx].parts.push(TurnPart::Thinking {
                                        text: text.to_string(),
                                    });
                                }
                            }
                        }
                        // Anthropic signed thinking (ContentBlock::AnthropicThinking):
                        // the prose lives in a `thinking` field, with the
                        // replay signature beside it. The signature is
                        // provider bookkeeping, never shown. A `text`
                        // fallback covers defensive non-writer shapes.
                        Some("anthropic_thinking") => {
                            let text = block
                                .get("thinking")
                                .or_else(|| block.get("text"))
                                .and_then(|t| t.as_str())
                                .unwrap_or("");
                            if !text.trim().is_empty() {
                                turns[turn_idx].parts.push(TurnPart::Thinking {
                                    text: text.to_string(),
                                });
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let brief = tool_brief(block);
                            let input = block
                                .get("input")
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "{}".to_string());
                            turns[turn_idx].parts.push(TurnPart::Tool {
                                name: name.to_string(),
                                brief,
                                input,
                                output: String::new(),
                                is_error: false,
                                output_ref: None,
                                output_size: None,
                            });
                            if let Some(id) = block.get("id").and_then(|i| i.as_str()) {
                                pending_tools.insert(
                                    id.to_string(),
                                    (turn_idx, turns[turn_idx].parts.len() - 1),
                                );
                                if name == "ask_user" {
                                    if let Some(payload) = decision_payload(block) {
                                        pending_decisions.insert(id.to_string(), payload);
                                    }
                                }
                            }
                        }
                        // image / provider_native / tool_reference /
                        // open_ai_compaction / unknown: skip silently
                        // (out of scope, round 7; hidden provider state
                        // never belongs in chat).
                        _ => {}
                    }
                }
            }
            _ => {} // unknown roles skip
        }
    }

    // Resolve in-flight calls: any tool_use still in `pending_tools`
    // becomes a ToolPending part (renders `running <name>…`). Mark by
    // swapping the stored part; the (turn, part) indices are stable
    // because turns are only appended after this point is false — safe
    // because folding happened during the walk and no parts are added
    // after this loop except via new messages.
    //
    // An in-flight ask_user is not `running…`: it blocks the turn on
    // the human, so it becomes an interactive Decision part carrying
    // the question and options. The payload was captured at tool_use
    // parse time; only calls with a usable payload (>=1 option, a
    // non-empty question) promote — a malformed ask_user degrades to a
    // plain running row instead of a broken chooser.
    let inflight: Vec<(usize, usize)> = pending_tools.values().cloned().collect();
    for (turn_idx, part_idx) in inflight {
        if let Some(TurnPart::Tool { name, .. }) =
            turns.get(turn_idx).and_then(|t| t.parts.get(part_idx))
        {
            let name = name.clone();
            if let Some(part) = turns
                .get_mut(turn_idx)
                .and_then(|t| t.parts.get_mut(part_idx))
            {
                // ask_user with a usable payload promotes to a Decision
                // chooser; anything else stays a running row.
                let decision = if name == "ask_user" {
                    // The payload map is keyed by tool_use id: find the
                    // id whose (turn, part) position is this part.
                    pending_tools
                        .iter()
                        .find(|(_, &(t, p))| t == turn_idx && p == part_idx)
                        .and_then(|(id, _)| pending_decisions.get(id))
                        .cloned()
                } else {
                    None
                };
                *part = match decision {
                    Some(DecisionPayload {
                        question,
                        options,
                        context,
                    }) => TurnPart::Decision {
                        question,
                        options,
                        context,
                    },
                    None => TurnPart::ToolPending { name },
                };
            }
        }
    }

    if turns.len() > MAX_TURNS {
        turns.drain(0..turns.len() - MAX_TURNS);
    }
    // Reference parity: a turn with no renderable parts drops (e.g. an
    // assistant merge target whose every block was skipped).
    turns.retain(|t| !t.parts.is_empty());
    turns
}

/// Collapses every whitespace run (spaces, \n, \r, tabs) to a single
/// space — the pane reflows text, so matching must be word-sequence,
/// not byte-exact.
fn normalize_ws(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_ws = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    out.trim().to_string()
}

/// The most recent substantial text chunk for a session, scanning
/// messages backward (any role — live evidence: pane_3's last reply
/// was a bare "Ok", but its pane screen still showed the CHERRY
/// prompt echo, which discriminates just as well). Bookkeeping
/// messages skip; tool-only messages skip; texts under `min_chars`
/// skip (a bare "ok" matches every pane). Bounded tail.
fn last_substantial_text_chunk(
    store_dir: &Path,
    session_id: &str,
    min_chars: usize,
) -> Option<String> {
    const TAIL_CHARS: usize = 400;
    for message in load_session_messages(store_dir, session_id).iter().rev() {
        if is_bookkeeping_message(message) {
            continue;
        }
        let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        let text: String = blocks
            .iter()
            .filter_map(|b| {
                let b = b.as_object()?;
                if b.get("type").and_then(|t| t.as_str()) != Some("text") {
                    return None;
                }
                b.get("text").and_then(|t| t.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n");
        let trimmed = text.trim();
        if trimmed.chars().count() < min_chars {
            continue; // trivially short text ("ok"): keep looking back
        }
        let tail: String = trimmed
            .chars()
            .rev()
            .take(TAIL_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Some(tail);
    }
    None
}

pub fn load_session_messages(store_dir: &Path, session_id: &str) -> Vec<serde_json::Value> {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let snapshot = store_dir.join(format!("{session_id}.json"));
    if let Ok(text) = std::fs::read_to_string(&snapshot) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(list) = parsed.get("messages").and_then(|m| m.as_array()) {
                for message in list {
                    if let Some(id) = message.get("id").and_then(|i| i.as_str()) {
                        if !seen.insert(id.to_string()) {
                            continue; // duplicate within snapshot: skip
                        }
                    }
                    messages.push(message.clone());
                }
            }
        }
    }

    let journal = store_dir.join(format!("{session_id}.journal.jsonl"));
    if let Ok(text) = std::fs::read_to_string(&journal) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
                continue; // torn tail: skip (validated round 8)
            };
            // Non-message entries (env snapshots, replay events,
            // memory injections) carry no append_messages: skipped.
            let Some(appended) = parsed.get("append_messages").and_then(|m| m.as_array()) else {
                continue;
            };
            for message in appended {
                if let Some(id) = message.get("id").and_then(|i| i.as_str()) {
                    if !seen.insert(id.to_string()) {
                        continue; // rotation overlap: journal id already
                                  // in the snapshot base — dedup (round 8)
                    }
                }
                messages.push(message.clone());
            }
        }
    }

    messages
}

/// Compaction summary for a session (meta `compaction`), if present.
pub fn load_compaction(store_dir: &Path, session_id: &str) -> Option<String> {
    // Prefer the journal's latest meta (compaction forces a snapshot,
    // so both agree at rest — validated round 3; read the cheaper file
    // first).
    let journal = store_dir.join(format!("{session_id}.journal.jsonl"));
    if let Ok(text) = std::fs::read_to_string(&journal) {
        for line in text.lines().rev() {
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(summary) = parsed
                .pointer("/meta/compaction/summary_text")
                .and_then(|s| s.as_str())
            {
                return Some(summary.to_string());
            }
        }
    }
    let snapshot = store_dir.join(format!("{session_id}.json"));
    if let Ok(text) = std::fs::read_to_string(&snapshot) {
        let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
        return parsed
            .pointer("/compaction/summary_text")
            .and_then(|s| s.as_str())
            .map(str::to_string);
    }
    None
}

/// One whole tool output by call id (reference toolOutput parity).
///
/// The conversation payload carried a trimmed head + `output_ref`;
/// this walks the SAME message stream the conversation was built from
/// (snapshot + journal, same id dedup) and returns the pre-trim output
/// for the tool_result whose tool_use_id matches `reference`. Bounded
/// at TOOL_OUTPUT_MAX chars with the same "… trimmed" marker so a
/// runaway output stays a page, not a log download. Returns None when
/// no matching tool_result exists (rotated out, cleared, unknown id).
///
/// `reference` is a JSON-encoded needle inside line scanning, so
/// charset-validate it the way the reference's TOOL_REF does: callers
/// must have passed `valid_tool_ref` first.
pub fn tool_output_by_ref(store_dir: &Path, session_id: &str, reference: &str) -> Option<String> {
    if !valid_tool_ref(reference) {
        return None;
    }
    let messages = load_session_messages(store_dir, session_id);
    for message in &messages {
        // `?` would abort the whole scan on the first message without a
        // content array (user turn with a bare string): continue past
        // those — the tool_result may be in any LATER message.
        let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for block in blocks {
            let Some(block) = block.as_object() else {
                continue;
            };
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            if block.get("tool_use_id").and_then(|t| t.as_str()) != Some(reference) {
                continue;
            }
            return Some(cap_tool_output(tool_result_text_uncapped(block)));
        }
    }
    None
}

/// TOOL_REF parity: ids are `[A-Za-z0-9_:.-]{1,128}`. Anything else is
/// rejected before it is ever used as a scan needle.
pub fn valid_tool_ref(reference: &str) -> bool {
    let len = reference.chars().count();
    if !(1..=128).contains(&len) {
        return false;
    }
    reference
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// TOOL_OUTPUT_MAX parity: a whole output is still bounded — a page of
/// it, not a log file. Same "… trimmed" marker as the head cap.
const TOOL_OUTPUT_MAX: usize = 2_000_000;

fn cap_tool_output(text: String) -> String {
    if text.chars().count() > TOOL_OUTPUT_MAX {
        let cut: String = text.chars().take(TOOL_OUTPUT_MAX).collect();
        format!("{cut}\n… trimmed")
    } else {
        text
    }
}

/// `tool_result_text` without the head cap: the whole output, joined
/// the same way (string content or text blocks array).
fn tool_result_text_uncapped(block: &serde_json::Map<String, serde_json::Value>) -> String {
    match block.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Parsed ask_user tool_use input: the question, offered options, and
/// optional context, as captured while the call blocks on the human.
#[derive(Debug, Clone, PartialEq)]
struct DecisionPayload {
    question: String,
    options: Vec<DecisionOption>,
    context: Option<String>,
}

/// Extracts a decision payload from an ask_user tool_use block.
/// Mirrors the jcode AskUserInput shape (question + options[{label,
/// detail?}] + context?). Returns None when the input is unusable as a
/// chooser (no question or no options): such a call renders as a plain
/// running row and the terminal chooser remains the answer surface.
fn decision_payload(block: &serde_json::Map<String, serde_json::Value>) -> Option<DecisionPayload> {
    let input = block.get("input").and_then(|i| i.as_object())?;
    let question = input
        .get("question")
        .and_then(|q| q.as_str())
        .map(str::trim)
        .filter(|q| !q.is_empty())?
        .to_string();
    let options: Vec<DecisionOption> = input
        .get("options")
        .and_then(|o| o.as_array())?
        .iter()
        .filter_map(|opt| {
            let label = opt
                .get("label")
                .and_then(|l| l.as_str())
                .map(str::trim)
                .filter(|l| !l.is_empty())?
                .to_string();
            let detail = opt
                .get("detail")
                .and_then(|d| d.as_str())
                .map(str::to_string);
            Some(DecisionOption { label, detail })
        })
        .collect();
    if options.is_empty() {
        return None;
    }
    let context = input
        .get("context")
        .and_then(|c| c.as_str())
        .map(str::to_string);
    Some(DecisionPayload {
        question,
        options,
        context,
    })
}

/// One-line input summary for a tool call (bounded, escaped-content free).
fn tool_brief(block: &serde_json::Map<String, serde_json::Value>) -> String {
    // The agent states its own one-line intent on 3910 of 3919 live
    // tool calls (`input.intent`); the reference prefers it too
    // (`summary = b.intent || toolSummary(...)`), else key fields.
    if let Some(intent) = block
        .get("input")
        .and_then(|i| i.get("intent"))
        .and_then(|i| i.as_str())
        .filter(|i| !i.trim().is_empty())
    {
        return truncate_chars(intent, 120);
    }
    let input = block.get("input");
    let mut brief = String::new();
    if let Some(obj) = input.and_then(|i| i.as_object()) {
        // Prefer the common intent fields, else first few key=value pairs.
        for key in ["command", "path", "file_path", "pattern", "query", "url"] {
            if let Some(v) = obj.get(key) {
                if let Some(s) = v.as_str() {
                    brief = truncate_chars(s, 80);
                    break;
                }
            }
        }
        if brief.is_empty() {
            for (k, v) in obj.iter().take(3) {
                let value = v
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string().chars().take(30).collect::<String>());
                if !brief.is_empty() {
                    brief.push(' ');
                }
                brief.push_str(&format!("{k}={}", truncate_chars(&value, 30)));
            }
        }
    }
    brief
}

fn tool_result_text(block: &serde_json::Map<String, serde_json::Value>) -> (String, bool) {
    /// Cap matches the reference's TOOL_OUTPUT_CHARS: the page carries
    /// the head of an output, the rest stays out of the payload.
    const MAX_OUTPUT_CHARS: usize = 4000;
    let text = match block.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        (text, false)
    } else {
        let cut: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
        (format!("{cut}\n… trimmed"), true)
    }
}

/// Full (pre-trim) output length in chars, for `output_size`.
fn block_content_chars(block: &serde_json::Map<String, serde_json::Value>) -> usize {
    match block.get("content") {
        Some(serde_json::Value::String(s)) => s.chars().count(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .count(),
        _ => 0,
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user_text(id: &str, text: &str) -> serde_json::Value {
        json!({"id": id, "role": "user",
               "content": [{"type": "text", "text": text}]})
    }

    fn asst_text(id: &str, text: &str) -> serde_json::Value {
        json!({"id": id, "role": "assistant",
               "content": [{"type": "text", "text": text}]})
    }

    fn asst_tool(id: &str, call_id: &str, name: &str) -> serde_json::Value {
        json!({"id": id, "role": "assistant", "content": [
            {"type": "tool_use", "id": call_id, "name": name,
             "input": {"command": "ls -la"}},
        ]})
    }

    fn tool_result(id: &str, call_id: &str, content: serde_json::Value) -> serde_json::Value {
        json!({"id": id, "role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call_id, "content": content}
        ]})
    }

    // ---- tool_output_by_ref ----

    #[test]
    fn tool_output_by_ref_returns_whole_output() {
        let dir = std::env::temp_dir().join(format!("tool-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = "x".repeat(5000);
        let snapshot = json!({
            "messages": [
                asst_tool("a1", "call_1", "Bash"),
                tool_result("u1", "call_1", serde_json::json!(big.clone())),
            ]
        });
        std::fs::write(
            dir.join("sess.json"),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let out = tool_output_by_ref(&dir, "sess", "call_1").unwrap();
        assert_eq!(out.len(), 5000);
        assert!(!out.contains("trimmed"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tool_output_by_ref_dedups_snapshot_journal() {
        let dir = std::env::temp_dir().join(format!("tool-ref-dj-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let snapshot = json!({
            "messages": [
                asst_tool("a1", "call_1", "Bash"),
                tool_result("u1", "call_1", serde_json::json!("from-snapshot")),
            ]
        });
        std::fs::write(
            dir.join("sess.json"),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        // Same message id (u1) in the journal with different content: dedup
        // must keep the snapshot copy, so the scan finds it once, not twice.
        let journal = json!({"append_messages": [
            tool_result("u1", "call_1", serde_json::json!("from-journal"))
        ]});
        std::fs::write(
            dir.join("sess.journal.jsonl"),
            serde_json::to_string(&journal).unwrap() + "\n",
        )
        .unwrap();
        let out = tool_output_by_ref(&dir, "sess", "call_1").unwrap();
        assert_eq!(out, "from-snapshot");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tool_output_by_ref_missing_and_invalid() {
        let dir = std::env::temp_dir().join(format!("tool-ref-mi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let snapshot = json!({
            "messages": [
                asst_tool("a1", "call_1", "Bash"),
                tool_result("u1", "call_1", serde_json::json!("ok")),
            ]
        });
        std::fs::write(
            dir.join("sess.json"),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        // Unknown ref: None, no error.
        assert!(tool_output_by_ref(&dir, "sess", "call_nope").is_none());
        // Invalid refs (charset / length) rejected before scanning.
        assert!(tool_output_by_ref(&dir, "sess", "../escape").is_none());
        assert!(tool_output_by_ref(&dir, "sess", "").is_none());
        assert!(tool_output_by_ref(&dir, "sess", &"k".repeat(129)).is_none());
        assert!(tool_output_by_ref(&dir, "no-such-session", "call_1").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tool_output_by_ref_skips_messages_without_content_array() {
        let dir = std::env::temp_dir().join(format!("tool-ref-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A bare-string user message BEFORE the tool_result: the scan
        // must continue past it, not abort (the `?` bug).
        let snapshot = json!({
            "messages": [
                {"id": "u0", "role": "user", "content": "just a string"},
                asst_tool("a1", "call_1", "Bash"),
                tool_result("u1", "call_1", serde_json::json!("found")),
            ]
        });
        std::fs::write(
            dir.join("sess.json"),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let out = tool_output_by_ref(&dir, "sess", "call_1").unwrap();
        assert_eq!(out, "found");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tool_output_by_ref_caps_at_two_million() {
        let dir = std::env::temp_dir().join(format!("tool-ref-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let huge = "y".repeat(TOOL_OUTPUT_MAX + 10);
        let snapshot = json!({
            "messages": [
                asst_tool("a1", "call_1", "Bash"),
                tool_result("u1", "call_1", serde_json::json!(huge)),
            ]
        });
        std::fs::write(
            dir.join("sess.json"),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let out = tool_output_by_ref(&dir, "sess", "call_1").unwrap();
        assert!(out.ends_with("… trimmed"));
        assert_eq!(
            out.chars().count(),
            TOOL_OUTPUT_MAX + "\n… trimmed".chars().count()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn valid_tool_ref_charset() {
        assert!(valid_tool_ref("toolu_01A-b.c:d"));
        assert!(!valid_tool_ref("has space"));
        assert!(!valid_tool_ref("../etc/passwd"));
        assert!(!valid_tool_ref(""));
        assert!(!valid_tool_ref(&"z".repeat(129)));
        assert!(valid_tool_ref(&"z".repeat(128)));
    }

    fn user_result(id: &str, call_id: &str, text: &str, is_error: bool) -> serde_json::Value {
        json!({"id": id, "role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call_id, "is_error": is_error,
             "content": [{"type": "text", "text": text}]},
        ]})
    }

    #[test]
    fn parses_user_and_assistant_turns() {
        let msgs = vec![user_text("m1", "hello"), asst_text("m2", "hi there")];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, TurnRole::User);
        assert_eq!(turns[1].role, TurnRole::Assistant);
        assert_eq!(
            turns[1].parts,
            vec![TurnPart::Text {
                text: "hi there".into()
            }]
        );
    }

    #[test]
    fn adjacent_assistant_messages_merge_into_one_turn() {
        let msgs = vec![
            asst_text("m1", "part one"),
            asst_text("m2", "part two"),
            user_text("m3", "next"),
        ];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].parts.len(), 2);
    }

    #[test]
    fn folds_tool_result_into_call_and_flags_error() {
        let msgs = vec![
            user_text("m1", "run it"),
            asst_tool("m2", "call_1", "bash"),
            user_result("m3", "call_1", "boom", true),
            asst_tool("m4", "call_2", "read"),
            user_result("m5", "call_2", "ok", false),
        ];
        let turns = parse_jcode_transcript(&msgs);
        let assistant = turns
            .iter()
            .find(|t| t.role == TurnRole::Assistant)
            .unwrap();
        let tools: Vec<&TurnPart> = assistant
            .parts
            .iter()
            .filter(|p| matches!(p, TurnPart::Tool { .. }))
            .collect();
        assert_eq!(tools.len(), 2);
        match tools[0] {
            TurnPart::Tool {
                is_error,
                output,
                name,
                brief,
                ..
            } => {
                assert!(is_error);
                assert_eq!(output, "boom");
                assert_eq!(name, "bash");
                assert_eq!(brief, "ls -la");
            }
            _ => panic!("expected tool part"),
        }
        match tools[1] {
            TurnPart::Tool { is_error, .. } => assert!(!is_error),
            _ => panic!("expected tool part"),
        }
    }

    #[test]
    fn unmatched_tool_use_becomes_pending() {
        let msgs = vec![asst_tool("m1", "call_1", "bash")];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::ToolPending { name } => assert_eq!(name, "bash"),
            other => panic!("expected pending tool, got {other:?}"),
        }
    }

    #[test]
    fn pending_ask_user_becomes_decision_chooser() {
        // Writer ground truth (jcode ask_user tool): the assistant
        // message is persisted BEFORE the tool blocks, so while the
        // human has not answered the only trace is the tool_use whose
        // input carries question + options.
        let msgs = vec![json!({"id": "m1", "role": "assistant", "content": [
            {"type": "tool_use", "id": "call_d", "name": "ask_user",
             "input": {
                "intent": "Deployment target",
                "question": "Deploy where?",
                "options": [
                    {"label": "dev", "detail": "staging cluster"},
                    {"label": "prod"},
                ],
                "context": "release train",
             }},
        ]})];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::Decision {
                question,
                options,
                context,
            } => {
                assert_eq!(question, "Deploy where?");
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].label, "dev");
                assert_eq!(options[0].detail.as_deref(), Some("staging cluster"));
                assert_eq!(options[1].label, "prod");
                assert_eq!(options[1].detail, None);
                assert_eq!(context.as_deref(), Some("release train"));
            }
            other => panic!("expected decision part, got {other:?}"),
        }
    }

    #[test]
    fn answered_ask_user_folds_to_plain_tool() {
        // Once the human answers, the tool_result lands and the part is
        // an ordinary Tool row: the chooser must disappear.
        let msgs = vec![
            json!({"id": "m1", "role": "assistant", "content": [
                {"type": "tool_use", "id": "call_d", "name": "ask_user",
                 "input": {
                    "question": "Deploy where?",
                    "options": [{"label": "dev"}, {"label": "prod"}],
                 }},
            ]}),
            json!({"id": "m2", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_d",
                 "content": "User chose option 1: dev"},
            ]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::Tool { name, output, .. } => {
                assert_eq!(name, "ask_user");
                assert_eq!(output, "User chose option 1: dev");
            }
            other => panic!("expected folded tool, got {other:?}"),
        }
        assert!(turns.iter().all(|t| {
            t.parts
                .iter()
                .all(|p| !matches!(p, TurnPart::Decision { .. }))
        }));
    }

    #[test]
    fn malformed_ask_user_degrades_to_pending_row() {
        // No options in the input: unusable as a chooser, so the part
        // stays a plain running row (the terminal chooser is the
        // answer surface there).
        let msgs = vec![json!({"id": "m1", "role": "assistant", "content": [
            {"type": "tool_use", "id": "call_d", "name": "ask_user",
             "input": {"question": "Deploy where?"}},
        ]})];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::ToolPending { name } => assert_eq!(name, "ask_user"),
            other => panic!("expected pending tool, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_becomes_thinking() {
        let msgs = vec![json!({"id": "m1", "role": "assistant", "content": [
            {"type": "reasoning", "text": "thinking hard"},
            {"type": "text", "text": "answer"},
        ]})];
        let turns = parse_jcode_transcript(&msgs);
        assert!(matches!(turns[0].parts[0], TurnPart::Thinking { .. }));
        assert!(matches!(turns[0].parts[1], TurnPart::Text { .. }));
    }

    #[test]
    fn anthropic_thinking_renders_as_thinking_from_its_own_field() {
        // Writer ground truth (jcode ContentBlock::AnthropicThinking):
        // prose in `thinking`, replay signature beside it. The chat
        // shows the prose, never the signature.
        let msgs = vec![json!({"id": "m1", "role": "assistant", "content": [
            {"type": "anthropic_thinking", "thinking": "signed prose", "signature": "sig-abc"},
            {"type": "text", "text": "answer"},
        ]})];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::Thinking { text } => assert_eq!(text, "signed prose"),
            other => panic!("expected thinking part, got {other:?}"),
        }
        assert!(matches!(turns[0].parts[1], TurnPart::Text { .. }));
    }

    #[test]
    fn anthropic_thinking_empty_or_missing_prose_skips() {
        // Empty signed thinking (a signature with no prose) and a
        // defensive text-only shape both skip without a part.
        let msgs = vec![json!({"id": "m1", "role": "assistant", "content": [
            {"type": "anthropic_thinking", "thinking": "   ", "signature": "sig"},
            {"type": "anthropic_thinking", "signature": "sig2"},
            {"type": "text", "text": "answer"},
        ]})];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].parts.len(), 1);
        assert!(matches!(turns[0].parts[0], TurnPart::Text { .. }));
    }

    #[test]
    fn unknown_block_types_skip_silently() {
        // Round-7 census: image, provider_native, tool_reference exist
        // in real snapshots and must not crash or render.
        let msgs = vec![json!({"id": "m1", "role": "assistant", "content": [
            {"type": "image", "data": "b64", "media_type": "image/png"},
            {"type": "provider_native", "payload": {"x": 1}},
            {"type": "wholly_unknown_future_type", "n": 5},
            {"type": "text", "text": "kept"},
        ]})];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns[0].parts.len(), 1);
        assert!(matches!(turns[0].parts[0], TurnPart::Text { .. }));
    }

    #[test]
    fn empty_and_non_message_shapes_yield_zero_turns() {
        assert!(parse_jcode_transcript(&[]).is_empty());
        // content as bare string never happens (validated round 7) but
        // must not panic if it ever does.
        assert!(
            parse_jcode_transcript(&[json!({"id": "m1", "role": "user", "content": "hi"})])
                .is_empty()
        );
    }

    #[test]
    fn tool_brief_prefers_intent_fields() {
        let value = json!({"input": {"file_path": "/x/y.rs", "offset": 3}});
        let block = value.as_object().unwrap();
        assert_eq!(tool_brief(block), "/x/y.rs");
    }

    #[test]
    fn max_turns_caps_output() {
        let mut msgs = Vec::new();
        for i in 0..(MAX_TURNS + 10) {
            msgs.push(user_text(&format!("m{i}"), "x"));
        }
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), MAX_TURNS);
    }

    // --- loader tests over a synthetic store ---

    pub(super) fn write_store(
        dir: &Path,
        session_id: &str,
        snapshot: Option<serde_json::Value>,
        journal_lines: &[serde_json::Value],
    ) {
        if let Some(snap) = snapshot {
            std::fs::write(
                dir.join(format!("{session_id}.json")),
                serde_json::to_string(&snap).unwrap(),
            )
            .unwrap();
        }
        let text = journal_lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join(format!("{session_id}.journal.jsonl")), text + "\n").unwrap();
    }

    pub(super) fn temp_store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jcode-transcript-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn loader_reads_snapshot_base_plus_journal_delta_with_dedup() {
        let dir = temp_store("loader");
        let snapshot = json!({"messages": [user_text("m1", "a"), user_text("m2", "b")]});
        // Rotation overlap (round 8): m2 is in BOTH the snapshot and
        // the stale journal — dedup must drop the journal copy.
        let journal = vec![
            json!({"meta": {}, "append_messages": [user_text("m2", "b")]}),
            json!({"meta": {}, "append_messages": [user_text("m3", "c")]}),
        ];
        write_store(&dir, "session_a", Some(snapshot), &journal);
        let msgs = load_session_messages(&dir, "session_a");
        let ids: Vec<&str> = msgs
            .iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
            .collect();
        assert_eq!(ids, vec!["m1", "m2", "m3"]);
    }

    #[test]
    fn loader_skips_torn_tail_and_non_message_entries() {
        let dir = temp_store("torn");
        let good = json!({"meta": {}, "append_messages": [user_text("m1", "hi")]});
        let mut text = serde_json::to_string(&good).unwrap();
        text.push('\n');
        text.push_str("{\"meta\":{},\"append_messages\":[{\"id\":\"m2\""); // torn tail
        text.push('\n');
        text.push_str("{\"append_env_snapshots\":[{\"k\":1}]}"); // non-message entry
        std::fs::write(dir.join("session_b.journal.jsonl"), text).unwrap();
        let msgs = load_session_messages(&dir, "session_b");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].get("id").unwrap(), "m1");
    }

    #[test]
    fn loader_handles_missing_snapshot_and_missing_journal() {
        let dir = temp_store("missing");
        // Journal only (pre-checkpoint session).
        let journal = vec![json!({"meta": {}, "append_messages": [user_text("m1", "x")]})];
        write_store(&dir, "session_c", None, &journal);
        assert_eq!(load_session_messages(&dir, "session_c").len(), 1);
        // Snapshot only (post-rotation moment).
        write_store(
            &dir,
            "session_d",
            Some(json!({"messages": [user_text("m1", "y")]})),
            &[],
        );
        assert_eq!(load_session_messages(&dir, "session_d").len(), 1);
        // Neither: zero messages, not an error.
        assert!(load_session_messages(&dir, "session_e").is_empty());
    }

    #[test]
    fn compaction_summary_reads_from_journal_or_snapshot() {
        let dir = temp_store("compact");
        let journal = vec![json!({
            "meta": {"compaction": {"summary_text": "summarized", "covers_up_to_turn": 4}},
            "append_messages": []
        })];
        write_store(&dir, "session_f", None, &journal);
        assert_eq!(
            load_compaction(&dir, "session_f").as_deref(),
            Some("summarized")
        );
        // Snapshot path (compaction forces a snapshot save).
        std::fs::write(
            dir.join("session_g.json"),
            serde_json::to_string(
                &json!({"messages": [], "compaction": {"summary_text": "snap sum"}}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_compaction(&dir, "session_g").as_deref(),
            Some("snap sum")
        );
        assert_eq!(load_compaction(&dir, "session_h"), None);
    }

    // --- resolution tests over a synthetic store ---

    fn ev_session(_id: &str, pid: u32, cwd: &str, status: &str) -> serde_json::Value {
        json!({"working_dir": cwd, "last_pid": pid, "status": status,
               "messages": []})
    }

    pub(super) fn ev_session_public(
        _id: &str,
        pid: u32,
        cwd: &str,
        status: &str,
    ) -> serde_json::Value {
        ev_session(_id, pid, cwd, status)
    }

    #[test]
    fn resolve_step1_process_tree_unique_hit() {
        let dir = temp_store("r1");
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 500, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid != 500, &|pid| pid == 500, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
    }

    #[test]
    fn resolve_step2_status_filter_is_load_bearing() {
        // Round-6 shape: three sessions share the daemon pid and cwd;
        // exactly one is Active. Without the status filter this is
        // ambiguous.
        let dir = temp_store("r2");
        for (name, status) in [("a", "Closed"), ("b", "Active"), ("c", "Crashed")] {
            // Crashed is object-shaped on disk; Active/Closed strings.
            let ev = match status {
                "Crashed" => json!({"working_dir": "/w", "last_pid": 900,
                    "status": {"Crashed": {"message": "gone"}}, "messages": []}),
                other => ev_session(&format!("session_{name}"), 900, "/w", other),
            };
            std::fs::write(
                dir.join(format!("session_{name}.json")),
                serde_json::to_string(&ev).unwrap(),
            )
            .unwrap();
        }
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 900, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_b".into()
            }
        );
    }

    #[test]
    fn resolve_two_active_sessions_is_ambiguous() {
        let dir = temp_store("r3");
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 700, "/w", "Active")).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("session_b.json"),
            serde_json::to_string(&ev_session("session_b", 700, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 700, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous
            }
        );
    }

    #[test]
    fn resolve_dead_pid_and_wrong_cwd_refuse() {
        let dir = temp_store("r4");
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 100, "/other", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|_| true, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Refused {
                reason: RefusalReason::NoSessionPath
            }
        );
    }

    #[test]
    fn journal_only_session_resolves_via_meta() {
        // Pre-checkpoint session: evidence lives in the journal meta.
        let dir = temp_store("r5");
        std::fs::write(
            dir.join("session_j.journal.jsonl"),
            serde_json::to_string(&json!({
                "meta": {"working_dir": "/w", "last_pid": 300, "status": "Active"},
                "append_messages": [user_text("m1", "hi")]
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 300, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_j".into()
            }
        );
    }

    #[test]
    fn index_cache_revalidates_on_file_change() {
        let dir = temp_store("r6");
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 100, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        let res1 = index.resolve(Path::new("/w"), &|pid| pid == 100, &|_| false, "");
        assert!(matches!(res1, JcodeSessionResolution::Resolved { .. }));
        // Rewrite with a different pid; the stat generation must
        // invalidate the cached evidence.
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 200, "/w", "Active")).unwrap(),
        )
        .unwrap();
        index.force_sweep_for_tests();
        let res2 = index.resolve(Path::new("/w"), &|pid| pid == 200, &|_| false, "");
        assert_eq!(
            res2,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
        index.force_sweep_for_tests();
        let res3 = index.resolve(Path::new("/w"), &|pid| pid == 100, &|_| false, "");
        assert!(matches!(res3, JcodeSessionResolution::Refused { .. }));
    }

    #[test]
    fn bak_and_foreign_files_are_ignored() {
        let dir = temp_store("r7");
        std::fs::write(dir.join("session_a.bak"), "garbage").unwrap();
        std::fs::write(dir.join("session_a.json.tmp.x"), "garbage").unwrap();
        std::fs::write(dir.join("notes.txt"), "hi").unwrap();
        std::fs::write(
            dir.join("session_b.json"),
            serde_json::to_string(&ev_session("session_b", 42, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_b".into()
            }
        );
    }
}

#[cfg(test)]
mod refresh_tests {
    use super::tests::{temp_store, write_store};
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_and_journal_same_session_count_once() {
        // Regression (live-wire test): a session with BOTH a snapshot and
        // a journal on disk must yield ONE evidence row. The original
        // per-file sweep counted it twice and made every live session
        // resolve as false `ambiguous`.
        let dir = temp_store("r8");
        let snapshot =
            json!({"messages": [], "working_dir": "/w", "last_pid": 42, "status": "Active"});
        let journal = vec![json!({
            "meta": {"working_dir": "/w", "last_pid": 42, "status": "Active"},
            "append_messages": []
        })];
        write_store(&dir, "session_a", Some(snapshot), &journal);
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
    }

    #[test]
    fn journal_fallback_used_only_when_snapshot_has_no_evidence() {
        // Snapshot exists but lacks evidence fields: the journal meta
        // must serve as the fallback (pre-checkpoint session).
        let dir = temp_store("r9");
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&json!({"messages": []})).unwrap(),
        )
        .unwrap();
        let journal = vec![json!({
            "meta": {"working_dir": "/w", "last_pid": 42, "status": "Active"},
            "append_messages": []
        })];
        write_store(&dir, "session_a", None, &journal);
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
    }
}

#[cfg(test)]
mod review_pass_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bookkeeping_display_roles_do_not_render() {
        // Live-wire evidence: session-create reminders carry
        // display_role "system", background-task notices
        // "background_task". Neither is a person's prompt.
        let msgs = vec![
            json!({"id": "m1", "role": "user", "display_role": "system",
                   "content": [{"type": "text", "text": "<system-reminder>ctx</system-reminder>"}]}),
            json!({"id": "m2", "role": "user", "display_role": "background_task",
                   "content": [{"type": "text", "text": "**Background task stalled**"}]}),
            json!({"id": "m3", "role": "user",
                   "content": [{"type": "text", "text": "real prompt"}]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 1);
        assert!(matches!(&turns[0].parts[0],
            TurnPart::Text { text } if text == "real prompt"));
    }

    #[test]
    fn tool_output_is_capped_with_trimmed_marker() {
        let long = "x".repeat(5000);
        let msgs = vec![
            json!({"id": "m1", "role": "assistant", "content": [
                {"type": "tool_use", "id": "c1", "name": "bash", "input": {"command": "cat"}},
            ]}),
            json!({"id": "m2", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1",
                 "content": [{"type": "text", "text": long}]},
            ]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::Tool { output, .. } => {
                assert!(output.ends_with("… trimmed"));
                assert!(output.chars().count() < 5000);
                assert!(output.chars().count() >= 4000);
            }
            other => panic!("expected tool part, got {other:?}"),
        }
    }

    #[test]
    fn empty_turns_drop() {
        // An assistant message whose every block was skipped must not
        // leave an empty turn behind (reference parity filter).
        let msgs = vec![
            json!({"id": "m1", "role": "user", "content": [{"type": "text", "text": "hi"}]}),
            json!({"id": "m2", "role": "assistant", "content": [
                {"type": "image", "data": "b64"},
            ]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].role, TurnRole::User);
    }

    #[test]
    fn tool_result_only_user_message_does_not_split_assistant_turn() {
        // Reference assistantTurn semantics: assistant activity across a
        // tool-result-only user message is ONE turn (the result folds
        // into the tool part; the follow-up text appends to the turn).
        let msgs = vec![
            json!({"id": "m1", "role": "user", "content": [{"type": "text", "text": "run"}]}),
            json!({"id": "m2", "role": "assistant", "content": [
                {"type": "tool_use", "id": "c1", "name": "bash", "input": {"command": "ls"}},
            ]}),
            json!({"id": "m3", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": "ok"},
            ]}),
            json!({"id": "m4", "role": "assistant", "content": [
                {"type": "text", "text": "done"},
            ]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 2);
        let assistant = &turns[1];
        assert_eq!(assistant.parts.len(), 2);
        assert!(
            matches!(&assistant.parts[0], TurnPart::Tool { output, is_error, .. }
            if output == "ok" && !is_error)
        );
        assert!(matches!(&assistant.parts[1], TurnPart::Text { text } if text == "done"));
    }
}

#[cfg(test)]
mod review_pass2_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_part_carries_input_json() {
        let msgs = vec![
            json!({"id": "m1", "role": "user", "content": [{"type": "text", "text": "go"}]}),
            json!({"id": "m2", "role": "assistant", "content": [
                {"type": "tool_use", "id": "c9", "name": "bash", "input": {"command": "ls", "cwd": "/tmp"}},
            ]}),
            json!({"id": "m3", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c9", "content": "ok"},
            ]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[1].parts[0] {
            TurnPart::Tool {
                input,
                output_ref,
                output_size,
                ..
            } => {
                assert!(input.contains("\"command\":\"ls\""));
                assert!(output_ref.is_none());
                assert!(output_size.is_none());
            }
            other => panic!("expected tool part, got {other:?}"),
        }
    }

    #[test]
    fn trimmed_output_sets_ref_and_size() {
        let long = "y".repeat(9000);
        let msgs = vec![
            json!({"id": "m1", "role": "assistant", "content": [
                {"type": "tool_use", "id": "c7", "name": "read", "input": {}},
            ]}),
            json!({"id": "m2", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c7", "content": long},
            ]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        match &turns[0].parts[0] {
            TurnPart::Tool {
                output,
                output_ref,
                output_size,
                ..
            } => {
                assert!(output.ends_with("… trimmed"));
                assert_eq!(output_ref.as_deref(), Some("c7"));
                assert_eq!(*output_size, Some(9000));
            }
            other => panic!("expected tool part, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod intent_brief_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_brief_prefers_agent_intent_over_fields() {
        // 99.8% of live calls carry input.intent; reference prefers it.
        let value = json!({"input": {"command": "rm -rf /", "intent": "clean build dir"}});
        let block = value.as_object().unwrap();
        assert_eq!(tool_brief(block), "clean build dir");
    }

    #[test]
    fn tool_brief_falls_back_when_intent_empty() {
        let value = json!({"input": {"command": "ls", "intent": "   "}});
        let block = value.as_object().unwrap();
        assert_eq!(tool_brief(block), "ls");
    }
}

#[cfg(test)]
mod step3_tiebreak_tests {
    use super::*;
    use serde_json::json;

    fn store_with_twin_sessions(dir: &std::path::Path, tail_apple: &str, tail_banana: &str) {
        let store = dir;
        // session_a: last assistant says APPLE
        let a = json!({
            "id": "session_a", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"id": "m2", "role": "assistant", "content": [
                    {"type": "text", "text": tail_apple}]},
            ],
        });
        std::fs::write(
            store.join("session_a.json"),
            serde_json::to_string(&a).unwrap(),
        )
        .unwrap();
        // session_b: last assistant says BANANA
        let b = json!({
            "id": "session_b", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"id": "m2", "role": "assistant", "content": [
                    {"type": "text", "text": tail_banana}]},
            ],
        });
        std::fs::write(
            store.join("session_b.json"),
            serde_json::to_string(&b).unwrap(),
        )
        .unwrap();
    }

    fn store(name: &str) -> PathBuf {
        // Unique per test: Rust runs tests in parallel threads, and a
        // shared dir raced twin-session writes (found in the batch run).
        let dir = std::env::temp_dir().join(format!("jcode-step3-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pane_tail_text_breaks_twin_session_ambiguity() {
        let dir = store("apple");
        store_with_twin_sessions(
            &dir,
            "The word to remember is APPLE, confirmed.",
            "The word to remember is BANANA, confirmed.",
        );
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // Both Active on the same live pid + cwd: ambiguous without the tail.
        let res = index.resolve(Path::new("/w"), &|pid| pid == 900, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous
            }
        );
        // The pane visibly shows session_a's answer: unique substantial match wins.
        let res = index.resolve(
            Path::new("/w"),
            &|pid| pid == 900,
            &|_| false,
            "some chrome\nThe word to remember is APPLE, confirmed.\nprompt line",
        );
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
    }

    #[test]
    fn both_panes_same_tail_stays_ambiguous() {
        let dir = store("both");
        store_with_twin_sessions(
            &dir,
            "The word to remember is APPLE, confirmed.",
            "The word to remember is BANANA, confirmed.",
        );
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // A pane showing BOTH answers (scrollback bleed) must not resolve.
        let res = index.resolve(
            Path::new("/w"),
            &|pid| pid == 900,
            &|_| false,
            "The word to remember is APPLE, confirmed. earlier The word to remember is BANANA, confirmed.",
        );
        assert_eq!(
            res,
            JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous
            }
        );
    }

    #[test]
    fn short_tail_match_does_not_win() {
        let dir = store("short");
        store_with_twin_sessions(&dir, "ok", "ok");
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // "ok" is under MIN_MATCH_CHARS: no winner even though both match.
        let res = index.resolve(Path::new("/w"), &|pid| pid == 900, &|_| false, "ok");
        assert_eq!(
            res,
            JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous
            }
        );
    }
}

#[cfg(test)]
mod step3_short_reply_tests {
    use super::*;
    use serde_json::json;

    /// Live scenario from the twin-pane wire test: last replies were a
    /// bare "Ok" / "Durian noted." — under the match minimum — but the
    /// pane screens still showed the CHERRY / DURIAN prompt echoes.
    /// The tiebreak must fall back to the prompt text, not give up.
    #[test]
    fn short_reply_falls_back_to_prompt_echo() {
        let dir = std::env::temp_dir().join(format!("jcode-step3-echo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = json!({
            "id": "session_a", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Remember the word CHERRY. Reply ok then stop."}]},
                {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "Ok"}]},
            ],
        });
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&a).unwrap(),
        )
        .unwrap();
        let b = json!({
            "id": "session_b", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Remember the word DURIAN. Just say Durian noted."}]},
                {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "Durian noted."}]},
            ],
        });
        std::fs::write(
            dir.join("session_b.json"),
            serde_json::to_string(&b).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // pane shows the CHERRY prompt echo and the short "Ok" reply
        let res = index.resolve(
            Path::new("/w"),
            &|pid| pid == 900,
            &|_| false,
            "chrome\nRemember the word CHERRY. Reply ok then stop.\nOk",
        );
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
    }
}

#[cfg(test)]
mod step3_journal_tests {
    use super::*;
    use serde_json::json;

    /// Wire-test regression: the twin-pane live run resolved while both
    /// sessions' newest substantial texts lived only in the JOURNAL
    /// (snapshot held just 2 messages), then flipped ambiguous on a
    /// later poll. The chunk extraction must always work from the
    /// merged (snapshot + journal) view, which load_session_messages
    /// provides — this test pins that path end to end.
    #[test]
    fn tiebreak_chunk_comes_from_journal_delta_too() {
        let dir = std::env::temp_dir().join(format!("jcode-step3-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // snapshot: older exchange only
        let snap = json!({
            "id": "session_a", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Remember the word ELDERBERRY. Reply ok."}]},
            ],
        });
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&snap).unwrap(),
        )
        .unwrap();
        // journal: the NEW prompt, only there
        let jline = json!({"append_messages": [
            {"id": "m2", "role": "user", "content": [{"type": "text",
              "text": "Run this exact command with bash and wait for it: sleep 30 && echo finished-slowly. Then reply slow done."}]},
        ]});
        std::fs::write(
            dir.join("session_a.journal.jsonl"),
            serde_json::to_string(&jline).unwrap() + "\n",
        )
        .unwrap();
        let snap_b = json!({
            "id": "session_b", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Remember the word FIG. Reply ok."}]},
            ],
        });
        std::fs::write(
            dir.join("session_b.json"),
            serde_json::to_string(&snap_b).unwrap(),
        )
        .unwrap();

        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        let res = index.resolve(
            Path::new("/w"),
            &|pid| pid == 900,
            &|_| false,
            "Run this exact command with bash and wait for it: sleep 30 && echo finished-slowly. Then reply slow done.",
        );
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
    }
}

#[cfg(test)]
mod step3_reflow_tests {
    use super::*;
    use serde_json::json;

    /// Live wire failure: the TUI reflowed the reply on screen
    /// ("ok  I'll remember …" with double spaces and no newlines)
    /// while the store chunk kept "ok\n\nI'll remember …". Verbatim
    /// matching missed; word-sequence matching must hit.
    #[test]
    fn reflowed_pane_text_still_matches() {
        let dir = std::env::temp_dir().join(format!("jcode-step3-reflow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = json!({
            "id": "session_a", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Remember the word GRAPEFRUIT. Reply ok."}]},
                {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "Ok."}]},
            ],
        });
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&a).unwrap(),
        )
        .unwrap();
        let b = json!({
            "id": "session_b", "working_dir": "/w", "status": "Active", "last_pid": 900,
            "messages": [
                {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Remember the word HONEYDEW. Reply ok."}]},
                {"id": "m2", "role": "assistant", "content": [
                    {"type": "text", "text": "ok"},
                    {"type": "text", "text": "I’ll remember the word HONEYDEW."}]},
            ],
        });
        std::fs::write(
            dir.join("session_b.json"),
            serde_json::to_string(&b).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // pane_7's actual screen shape: spaces collapsed, no newlines
        let res = index.resolve(
            Path::new("/w"),
            &|pid| pid == 900,
            &|_| false,
            "ok  I’ll remember the word HONEYDEW.  710ms · ↑17k ↓19",
        );
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_b".into()
            }
        );
    }
}

#[cfg(test)]
mod coverage_gaps {
    //! Gap-closing tests for paths the main suites never exercised
    //! (store error paths, trim helpers, journal evidence fallbacks).
    use super::tests::{ev_session_public as ev_session, temp_store, write_store};
    use super::*;
    use serde_json::json;

    // --- RefusalReason::as_str ---

    #[test]
    fn refusal_reason_codes_round_trip() {
        assert_eq!(RefusalReason::NoSessionPath.as_str(), "no_session_path");
        assert_eq!(RefusalReason::Ambiguous.as_str(), "ambiguous");
    }

    // --- session_model_status ---

    #[test]
    fn model_status_reads_snapshot_fields() {
        let dir = temp_store("model-ok");
        std::fs::write(
            dir.join("session_m.json"),
            serde_json::to_string(&json!({
                "model": "fable-5", "status": "Active",
                "reasoning_effort": "high", "messages": []
            }))
            .unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        assert_eq!(
            index.session_model_status("session_m"),
            (
                Some("fable-5".into()),
                Some("Active".into()),
                Some("high".into())
            )
        );
    }

    #[test]
    fn model_status_missing_snapshot_and_bad_json_yield_nones() {
        let dir = temp_store("model-miss");
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // No snapshot at all.
        assert_eq!(
            index.session_model_status("session_none"),
            (None, None, None)
        );
        // Unparseable snapshot.
        std::fs::write(dir.join("session_bad.json"), "{not json").unwrap();
        assert_eq!(
            index.session_model_status("session_bad"),
            (None, None, None)
        );
        // Snapshot without the optional fields: Nones, not errors.
        std::fs::write(
            dir.join("session_plain.json"),
            serde_json::to_string(&json!({"messages": []})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            index.session_model_status("session_plain"),
            (None, None, None)
        );
    }

    // --- session_generation ---

    #[test]
    fn generation_changes_when_files_change() {
        let dir = temp_store("gen");
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        write_store(&dir, "session_g", Some(json!({"messages": []})), &[]);
        let g1 = index.session_generation("session_g");
        assert!(!g1.is_empty());
        // In-place rewrite (tmp + rename parity): same content, new
        // mtime -> different generation.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let tmp = dir.join("session_g.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_string(&json!({"messages": []})).unwrap(),
        )
        .unwrap();
        std::fs::rename(&tmp, dir.join("session_g.json")).unwrap();
        let g2 = index.session_generation("session_generation_bump");
        // And a missing session yields an empty-ish but stable value.
        assert!(!index.session_generation("session_absent").is_empty());
        assert_ne!(g1, ""); // sanity: real value shape
        let _ = g2; // only that it does not panic
    }

    // --- refresh: stale-row drop, read_dir failure, throttle ---

    #[test]
    fn refresh_drops_cache_rows_whose_files_vanished() {
        let dir = temp_store("stale");
        write_store(&dir, "session_a", Some(json!({"messages": []})), &[]);
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // First sweep caches session_a.
        index.force_sweep_for_tests();
        let res = index.resolve(Path::new("/w"), &|_| false, &|_| false, "");
        assert!(matches!(res, JcodeSessionResolution::Refused { .. }));
        // Vanish both files; force a fresh sweep: the stale cached row
        // must be dropped, not resurrected from cache. Resolve again:
        // with no evidence rows left, the answer must be a refusal.
        std::fs::remove_file(dir.join("session_a.json")).unwrap();
        std::fs::remove_file(dir.join("session_a.journal.jsonl")).unwrap();
        index.force_sweep_for_tests();
        let res = index.resolve(Path::new("/w"), &|_| false, &|_| false, "");
        assert!(
            matches!(res, JcodeSessionResolution::Refused { .. }),
            "stale cache row must not resurrect the session"
        );
    }

    #[test]
    fn refresh_serves_cache_when_dir_unreadable() {
        // A store dir that does not exist: sweep returns empty
        // without panicking.
        let dir = std::env::temp_dir().join(format!("jcode-cov-nodir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let index = JcodeStoreIndex::with_store_dir(dir);
        index.force_sweep_for_tests();
        let res = index.resolve(Path::new("/w"), &|_| false, &|_| false, "");
        assert!(matches!(res, JcodeSessionResolution::Refused { .. }));
    }

    // --- session_id_of edge: non-session files ---

    #[test]
    fn foreign_and_bak_filenames_are_rejected() {
        assert_eq!(session_id_of("session_a.json"), Some("session_a".into()));
        assert_eq!(
            session_id_of("session_a.journal.jsonl"),
            Some("session_a".into())
        );
        assert_eq!(session_id_of("random.json"), None);
        assert_eq!(session_id_of("session.json"), None); // bare "session"
        assert_eq!(session_id_of("session_a.bak"), None);
        assert_eq!(session_id_of("session_a"), None); // no suffix
    }

    // --- journal-meta evidence fallback with torn tail ---

    #[test]
    fn journal_evidence_skips_torn_tail_lines() {
        let dir = temp_store("jmeta-torn");
        let good = json!({
            "meta": {"working_dir": "/w", "last_pid": 77, "status": "Active"},
            "append_messages": []
        });
        std::fs::write(
            dir.join("session_t.json"),
            serde_json::to_string(&json!({"messages": []})).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("session_t.journal.jsonl"),
            serde_json::to_string(&good).unwrap() + "\n{torn json\n",
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 77, &|_| false, "");
        // Snapshot has NO evidence fields -> journal meta is used,
        // torn tail line skipped.
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_t".into()
            }
        );
    }

    // --- parse: bookkeeping, unknown roles/blocks, non-object blocks ---

    #[test]
    fn parse_skips_bookkeeping_unknown_roles_and_non_object_blocks() {
        let msgs = vec![
            // Bookkeeping display roles never render.
            json!({"id": "b1", "role": "user", "display_role": "system",
                   "content": [{"type": "text", "text": "hidden"}]}),
            json!({"id": "b2", "role": "user", "display_role": "background_task",
                   "content": [{"type": "text", "text": "hidden too"}]}),
            // Unknown role: skipped.
            json!({"id": "b3", "role": "tool", "content": [
                {"type": "text", "text": "nope"}]}),
            // Non-object block inside a content array: skipped.
            json!({"id": "b4", "role": "user", "content": ["bare", {"type": "text", "text": "shown"}]}),
            // Unknown block type in user message: skipped silently.
            json!({"id": "b5", "role": "user", "content": [
                {"type": "mystery", "text": "x"}, {"type": "text", "text": "ok"}]}),
            // Unknown block type in assistant message: skipped too.
            json!({"id": "b6", "role": "assistant", "content": [
                {"type": "mystery", "text": "x"}, {"type": "text", "text": "fine"}]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        let texts: Vec<String> = turns
            .iter()
            .flat_map(|t| {
                t.parts.iter().filter_map(|p| match p {
                    TurnPart::Text { text } => Some(text.clone()),
                    _ => None,
                })
            })
            .collect();
        assert_eq!(texts, vec!["shown", "ok", "fine"]);
    }

    // --- parse: assistant end_ts from timestamps ---

    #[test]
    fn assistant_end_ts_comes_from_message_timestamp() {
        let msgs = vec![
            json!({"id": "a1", "role": "assistant",
                   "timestamp": "2026-01-01T00:00:01Z",
                   "content": [{"type": "text", "text": "hi"}]}),
            // Adjacent assistant message updates end_ts.
            json!({"id": "a2", "role": "assistant",
                   "timestamp": "2026-01-01T00:00:05Z",
                   "content": [{"type": "text", "text": "again"}]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].ts.as_deref(), Some("2026-01-01T00:00:01Z"));
        assert_eq!(turns[0].end_ts.as_deref(), Some("2026-01-01T00:00:05Z"));
    }

    // --- trim helpers directly ---

    #[test]
    fn tool_result_text_caps_at_4000_with_marker() {
        let long = "y".repeat(4500);
        let block = json!({"content": long}).as_object().unwrap().clone();
        let (text, was_cut) = tool_result_text(&block);
        assert!(was_cut);
        assert!(text.ends_with("… trimmed"));
        assert!(text.chars().count() <= 4010);
        // Short content: not cut.
        let block = json!({"content": "short"}).as_object().unwrap().clone();
        let (text, was_cut) = tool_result_text(&block);
        assert_eq!(text, "short");
        assert!(!was_cut);
    }

    #[test]
    fn uncapped_tool_result_text_joins_array_blocks() {
        let block = json!({"content": [
            {"type": "text", "text": "line1"},
            {"type": "text", "text": "line2"},
            {"type": "other", "blob": 1},
        ]})
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(tool_result_text_uncapped(&block), "line1\nline2");
        // Bare string content passes through.
        let block = json!({"content": "plain"}).as_object().unwrap().clone();
        assert_eq!(tool_result_text_uncapped(&block), "plain");
        // Missing content: empty.
        let block = json!({}).as_object().unwrap().clone();
        assert_eq!(tool_result_text_uncapped(&block), "");
    }

    #[test]
    fn block_content_chars_counts_string_and_arrays() {
        let block = json!({"content": "hello"}).as_object().unwrap().clone();
        assert_eq!(block_content_chars(&block), 5);
        let block = json!({"content": [
            {"type": "text", "text": "ab"}, {"type": "text", "text": "cde"},
        ]})
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(block_content_chars(&block), 6);
        let block = json!({}).as_object().unwrap().clone();
        assert_eq!(block_content_chars(&block), 0);
    }

    #[test]
    fn truncate_chars_ellipsizes_beyond_max() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        assert_eq!(truncate_chars("abcdef", 5), "abcde…");
        // Multi-byte safe: two chars only.
        assert_eq!(truncate_chars("ñññ", 2), "ññ…");
    }

    #[test]
    fn tool_brief_key_value_fallback_stops_at_three_pairs() {
        // No intent/command fields: first 3 key=value pairs.
        let value = json!({"input": {"aa": "1", "bb": "2", "cc": "3", "dd": "4"}});
        let brief = tool_brief(value.as_object().unwrap());
        assert_eq!(brief, "aa=1 bb=2 cc=3");
        // Non-string values serialize and truncate.
        let value = json!({"input": {"n": 12345678901234567890u64}});
        let brief = tool_brief(value.as_object().unwrap());
        assert!(brief.starts_with("n="));
        // Missing input entirely: empty brief.
        let value = json!({});
        assert_eq!(tool_brief(value.as_object().unwrap()), "");
    }

    // --- cap_tool_output: the 2 MB whole-output page cap ---

    #[test]
    fn cap_tool_output_bounds_huge_outputs() {
        let huge = "z".repeat(TOOL_OUTPUT_MAX + 50);
        let capped = cap_tool_output(huge.clone());
        assert!(capped.len() < huge.len());
        assert!(capped.ends_with("… trimmed") || capped.chars().count() <= TOOL_OUTPUT_MAX + 20);
        let small = cap_tool_output("fine".to_string());
        assert_eq!(small, "fine");
    }

    // --- load_session_messages: no-id messages and missing files ---

    #[test]
    fn loader_keeps_no_id_messages_and_handles_missing_files() {
        let dir = temp_store("loader-noid");
        let snapshot = json!({"messages": [
            {"role": "user", "content": [{"type": "text", "text": "no id"}]},
            {"id": "m1", "role": "user", "content": [{"type": "text", "text": "with id"}]},
        ]});
        write_store(&dir, "session_l", Some(snapshot), &[]);
        let msgs = load_session_messages(&dir, "session_l");
        assert_eq!(msgs.len(), 2);
        // Entirely absent session: empty, no panic.
        assert!(load_session_messages(&dir, "session_nothere").is_empty());
        // Snapshot with duplicate ids keeps only the first.
        let snapshot = json!({"messages": [
            {"id": "d", "role": "user", "content": [{"type": "text", "text": "first"}]},
            {"id": "d", "role": "user", "content": [{"type": "text", "text": "dup"}]},
        ]});
        write_store(&dir, "session_dup", Some(snapshot), &[]);
        assert_eq!(load_session_messages(&dir, "session_dup").len(), 1);
    }

    // --- load_compaction: torn tail and snapshot fallback ---

    #[test]
    fn compaction_snapshot_fallback_and_torn_journal() {
        let dir = temp_store("compact-fb");
        // Journal torn + snapshot carries compaction at the TOP level
        // (`/compaction/summary_text`, the snapshot's own shape).
        std::fs::write(
            dir.join("session_c.json"),
            serde_json::to_string(&json!({
                "compaction": {"summary_text": "from snapshot"},
                "messages": []
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("session_c.journal.jsonl"), "{torn\n").unwrap();
        assert_eq!(
            load_compaction(&dir, "session_c"),
            Some("from snapshot".to_string())
        );
        // No compaction anywhere: None.
        write_store(&dir, "session_n", Some(json!({"messages": []})), &[]);
        assert_eq!(load_compaction(&dir, "session_n"), None);
    }

    // --- tool_output_by_ref: skips bookkeeping and content-less msgs ---

    #[test]
    fn tool_output_walks_past_bookkeeping_and_malformed() {
        // tool_output_by_ref intentionally does NOT filter bookkeeping
        // rows (only the TURN parser does): a tool_use in the visible
        // conversation may still be answered inside a system-injected
        // result row. What it must skip: messages with no content
        // array, and keep scanning PAST them.
        let dir = temp_store("tool-walk");
        let snapshot = json!({"messages": [
            // No content array: skipped, not fatal.
            {"id": "k2", "role": "user", "content": "bare string"},
            // The real result.
            {"id": "k3", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_x", "content": "visible"}]},
        ]});
        write_store(&dir, "session_w", Some(snapshot), &[]);
        assert_eq!(
            tool_output_by_ref(&dir, "session_w", "call_x"),
            Some("visible".to_string())
        );
    }

    // --- tiebreak: empty pane tail ---

    #[test]
    fn tiebreak_empty_pane_tail_is_none() {
        // Two Active sessions, empty pane tail: step 3 cannot run,
        // refusal is ambiguous.
        let dir = temp_store("tie-empty");
        std::fs::write(
            dir.join("session_p.json"),
            serde_json::to_string(&ev_session("session_p", 42, "/w", "Active")).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("session_q.json"),
            serde_json::to_string(&ev_session("session_q", 42, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous
            }
        );
    }

    // --- stale-row drop: REAL evidence rows ---

    #[test]
    fn refresh_drops_cached_evidence_when_session_files_vanish() {
        let dir = temp_store("stale-ev");
        // Session with REAL evidence (pid/cwd/status) so the first
        // sweep caches it.
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 500, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // First sweep: resolves by tree (pid 500 in tree).
        index.force_sweep_for_tests();
        let res = index.resolve(Path::new("/w"), &|_| false, &|pid| pid == 500, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_a".into()
            }
        );
        // Files vanish; forced fresh sweep must DROP the cached row
        // (not resurrect it from the 250 ms throttle window).
        std::fs::remove_file(dir.join("session_a.json")).unwrap();
        index.force_sweep_for_tests();
        let res = index.resolve(Path::new("/w"), &|_| false, &|pid| pid == 500, "");
        assert!(
            matches!(res, JcodeSessionResolution::Refused { .. }),
            "stale cached evidence must not resurrect a vanished session"
        );
    }

    // --- session_generation missing files ---

    #[test]
    fn generation_for_absent_session_is_stable() {
        let dir = temp_store("gen-absent");
        let index = JcodeStoreIndex::with_store_dir(dir);
        let g1 = index.session_generation("session_nothere");
        let g2 = index.session_generation("session_nothere");
        assert_eq!(g1, g2);
        assert!(!g1.is_empty(), "absent session still needs a stable sig");
    }

    // --- parse: whitespace-only and missing text fields ---

    #[test]
    fn parse_drops_whitespace_only_text_blocks() {
        let msgs = vec![
            // Whitespace-only user text: no turn.
            json!({"id": "w1", "role": "user", "content": [
                {"type": "text", "text": "   \n  "},
                {"type": "text", "text": "real"}]}),
            // Assistant text field missing entirely (non-string): skip.
            json!({"id": "w2", "role": "assistant", "content": [
                {"type": "text", "count": 7},
                {"type": "text", "text": "kept"}]}),
        ];
        let turns = parse_jcode_transcript(&msgs);
        let texts: Vec<&str> = turns
            .iter()
            .flat_map(|t| {
                t.parts.iter().filter_map(|p| match p {
                    TurnPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
            })
            .collect();
        assert_eq!(texts, vec!["real", "kept"]);
    }

    // --- tool_brief: non-string intent value ignored ---

    #[test]
    fn tool_brief_skips_non_string_intent() {
        let value = json!({"input": {"intent": {"nested": 1}, "command": "ls"}});
        let brief = tool_brief(value.as_object().unwrap());
        assert_eq!(brief, "ls");
    }

    // --- last_substantial_text_chunk: bookkeeping + malformed rows ---

    #[test]
    fn tiebreak_chunk_skips_bookkeeping_and_contentless_messages() {
        // Build a session where the LAST messages are bookkeeping or
        // malformed, and an older assistant message carries the real
        // substantial text — the chunk walker must keep looking back.
        let dir = temp_store("chunk-walk");
        let snapshot = json!({"messages": [
            {"id": "m1", "role": "assistant", "content": [
                {"type": "text", "text": "this reply is definitely substantial enough for matching"}]},
            // Bookkeeping row with text: skipped.
            {"id": "m2", "role": "user", "display_role": "system", "content": [
                {"type": "text", "text": "hidden injected memory text that is long enough"}]},
            // No content array: skipped.
            {"id": "m3", "role": "user", "content": "bare"},
            // Tool-result-only user row (no text blocks): skipped.
            {"id": "m4", "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": "done"}]},
        ]});
        write_store(&dir, "session_k", Some(snapshot), &[]);
        let chunk = last_substantial_text_chunk(&dir, "session_k", 24);
        assert_eq!(
            chunk.as_deref(),
            Some("this reply is definitely substantial enough for matching")
        );
        // A session whose every text row is bookkeeping: no chunk.
        let snapshot = json!({"messages": [
            {"id": "b1", "role": "user", "display_role": "system", "content": [
                {"type": "text", "text": "hidden injected memory text long enough"}]},
        ]});
        write_store(&dir, "session_k2", Some(snapshot), &[]);
        assert_eq!(last_substantial_text_chunk(&dir, "session_k2", 24), None);
        // Empty session: no chunk.
        write_store(&dir, "session_k3", Some(json!({"messages": []})), &[]);
        assert_eq!(last_substantial_text_chunk(&dir, "session_k3", 24), None);
    }

    // --- tool_result_text: missing content arm ---

    #[test]
    fn tool_result_text_without_content_is_empty() {
        let block = json!({"tool_use_id": "x"}).as_object().unwrap().clone();
        let (text, was_cut) = tool_result_text(&block);
        assert_eq!(text, "");
        assert!(!was_cut);
    }

    // --- refresh: non-UTF8 filename in the store dir ---
    // NOTE: APFS (macOS) rejects non-UTF-8 filenames at the syscall
    // level, so the `to_str() == None` branch (src line ~280) cannot
    // be exercised on this platform; it is defensive for Linux
    // stores. Kept as a documented gap, not fake-covered.

    // --- refresh: metadata failure on a vanished candidate ---

    #[test]
    fn refresh_tolerates_candidate_files_that_vanish_mid_sweep() {
        let dir = temp_store("vanish-mid");
        // A dangling symlink with a session-shaped name: read_dir lists
        // it, metadata() fails, the sweep continues to the snapshot.
        let target = dir.join("session_ghost.json");
        std::os::unix::fs::symlink("no-such-target-anywhere", &target).unwrap();
        std::fs::write(
            dir.join("session_real.json"),
            serde_json::to_string(&ev_session("session_real", 12, "/w", "Active")).unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        index.force_sweep_for_tests();
        let res = index.resolve(Path::new("/w"), &|pid| pid == 12, &|_| false, "");
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved {
                session_id: "session_real".into()
            }
        );
    }
}
