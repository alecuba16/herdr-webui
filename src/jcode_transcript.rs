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
        let mut combined = String::new();
        for suffix in [".json", ".journal.jsonl"] {
            let meta = std::fs::metadata(self.store_dir.join(format!("{session_id}{suffix}")));
            let generation = meta.ok().map(|m| stat_generation(&m));
            combined.push_str(&format!("{generation:?};"));
        }
        combined
    }

    /// (model, status) as recorded in the snapshot, if readable.
    pub fn session_model_status(&self, session_id: &str) -> (Option<String>, Option<String>) {
        let snapshot = self.store_dir.join(format!("{session_id}.json"));
        let Ok(text) = std::fs::read_to_string(&snapshot) else {
            return (None, None);
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
            return (None, None);
        };
        let model = parsed
            .get("model")
            .and_then(|m| m.as_str())
            .map(str::to_string);
        let status = parsed
            .get("status")
            .and_then(|s| s.as_str())
            .map(str::to_string);
        (model, status)
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
            return JcodeSessionResolution::Refused {
                reason: RefusalReason::Ambiguous,
            };
        }

        JcodeSessionResolution::Refused {
            reason: RefusalReason::NoSessionPath,
        }
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
    let base = if let Some(b) = name.strip_suffix(".journal.jsonl") {
        b
    } else if let Some(b) = name.strip_suffix(".json") {
        b
    } else {
        return None;
    };
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
fn read_evidence(path: &Path, session_id: &str, generation: (u128, u64)) -> Option<SessionEvidence> {
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

#[derive(Debug, Clone, PartialEq)]
pub enum TurnPart {
    Text { text: String },
    Thinking { text: String },
    Tool {
        name: String,
        brief: String,
        output: String,
        is_error: bool,
    },
    /// In-flight call: no result yet (renders as `running <name>…`).
    ToolPending { name: String },
    /// Compaction summary (server emits it as its own user turn; the
    /// client folds nothing — design section 3).
    Compact { summary: String },
}

pub const MAX_TURNS: usize = 200;

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

    for message in messages {
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
            continue; // unknown shape: skip (design: tolerate format changes)
        };
        match role {
            "user" => {
                let mut texts: Vec<&str> = Vec::new();
                let mut tool_results: Vec<(String, serde_json::Map<String, serde_json::Value>, bool)> = Vec::new();
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
                            let is_error = block.get("is_error") == Some(&serde_json::Value::Bool(true));
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
                        if let Some(TurnPart::Tool { output, is_error: err, .. }) =
                            turns.get_mut(turn_idx).and_then(|t| t.parts.get_mut(part_idx))
                        {
                            *output = tool_result_text(&block);
                            *err = is_error;
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
                        Some("reasoning") | Some("reasoning_trace") | Some("open_a_i_reasoning") => {
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
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let brief = tool_brief(block);
                            turns[turn_idx].parts.push(TurnPart::Tool {
                                name: name.to_string(),
                                brief,
                                output: String::new(),
                                is_error: false,
                            });
                            if let Some(id) = block.get("id").and_then(|i| i.as_str()) {
                                pending_tools
                                    .insert(id.to_string(), (turn_idx, turns[turn_idx].parts.len() - 1));
                            }
                        }
                        // image / provider_native / tool_reference /
                        // unknown: skip silently (out of scope, round 7).
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
    let inflight: Vec<(usize, usize)> = pending_tools.values().cloned().collect();
    for (turn_idx, part_idx) in inflight {
        if let Some(TurnPart::Tool { name, .. }) =
            turns.get(turn_idx).and_then(|t| t.parts.get(part_idx))
        {
            let name = name.clone();
            if let Some(part) =
                turns.get_mut(turn_idx).and_then(|t| t.parts.get_mut(part_idx))
            {
                *part = TurnPart::ToolPending { name };
            }
        }
    }

    if turns.len() > MAX_TURNS {
        turns.drain(0..turns.len() - MAX_TURNS);
    }
    turns
}

/// Loads a session's full message list: snapshot base + journal delta
/// replay with id-dedup (rotation-race hardening, design section 1).
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

/// One-line input summary for a tool call (bounded, escaped-content free).
fn tool_brief(block: &serde_json::Map<String, serde_json::Value>) -> String {
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
            let mut count = 0;
            for (k, v) in obj {
                if count >= 3 {
                    break;
                }
                let value = v.as_str().map(str::to_string).unwrap_or_else(|| {
                    v.to_string().chars().take(30).collect::<String>()
                });
                if !brief.is_empty() {
                    brief.push(' ');
                }
                brief.push_str(&format!("{k}={}", truncate_chars(&value, 30)));
                count += 1;
            }
        }
    }
    brief
}

fn tool_result_text(block: &serde_json::Map<String, serde_json::Value>) -> String {
    match block.get("content") {
        Some(serde_json::Value::String(s)) => s.chars().take(2000).collect(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(2000)
            .collect(),
        _ => String::new(),
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
            vec![TurnPart::Text { text: "hi there".into() }]
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
        let assistant = turns.iter().find(|t| t.role == TurnRole::Assistant).unwrap();
        let tools: Vec<&TurnPart> = assistant
            .parts
            .iter()
            .filter(|p| matches!(p, TurnPart::Tool { .. }))
            .collect();
        assert_eq!(tools.len(), 2);
        match tools[0] {
            TurnPart::Tool { is_error, output, name, brief, .. } => {
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
        assert!(parse_jcode_transcript(&[json!({"id": "m1", "role": "user", "content": "hi"})])
            .is_empty());
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

    pub(super) fn write_store(dir: &Path, session_id: &str, snapshot: Option<serde_json::Value>, journal_lines: &[serde_json::Value]) {
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
        let dir = std::env::temp_dir().join(format!("jcode-transcript-test-{name}-{}", std::process::id()));
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
        let ids: Vec<&str> = msgs.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str())).collect();
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
        write_store(&dir, "session_d", Some(json!({"messages": [user_text("m1", "y")]})), &[]);
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
        assert_eq!(load_compaction(&dir, "session_f").as_deref(), Some("summarized"));
        // Snapshot path (compaction forces a snapshot save).
        std::fs::write(
            dir.join("session_g.json"),
            serde_json::to_string(&json!({"messages": [], "compaction": {"summary_text": "snap sum"}})).unwrap(),
        )
        .unwrap();
        assert_eq!(load_compaction(&dir, "session_g").as_deref(), Some("snap sum"));
        assert_eq!(load_compaction(&dir, "session_h"), None);
    }

    // --- resolution tests over a synthetic store ---

    fn ev_session(_id: &str, pid: u32, cwd: &str, status: &str) -> serde_json::Value {
        json!({"working_dir": cwd, "last_pid": pid, "status": status,
               "messages": []})
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
        let res = index.resolve(Path::new("/w"), &|pid| pid != 500, &|pid| pid == 500);
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved { session_id: "session_a".into() }
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
        let res = index.resolve(Path::new("/w"), &|pid| pid == 900, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved { session_id: "session_b".into() }
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
        let res = index.resolve(Path::new("/w"), &|pid| pid == 700, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Refused { reason: RefusalReason::Ambiguous }
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
        let res = index.resolve(Path::new("/w"), &|_| true, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Refused { reason: RefusalReason::NoSessionPath }
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
        let res = index.resolve(Path::new("/w"), &|pid| pid == 300, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved { session_id: "session_j".into() }
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
        let res1 = index.resolve(Path::new("/w"), &|pid| pid == 100, &|_| false);
        assert!(matches!(res1, JcodeSessionResolution::Resolved { .. }));
        // Rewrite with a different pid; the stat generation must
        // invalidate the cached evidence.
        std::fs::write(
            dir.join("session_a.json"),
            serde_json::to_string(&ev_session("session_a", 200, "/w", "Active")).unwrap(),
        )
        .unwrap();
        index.force_sweep_for_tests();
        let res2 = index.resolve(Path::new("/w"), &|pid| pid == 200, &|_| false);
        assert_eq!(
            res2,
            JcodeSessionResolution::Resolved { session_id: "session_a".into() }
        );
        index.force_sweep_for_tests();
        let res3 = index.resolve(Path::new("/w"), &|pid| pid == 100, &|_| false);
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
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved { session_id: "session_b".into() }
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
        let snapshot = json!({"messages": [], "working_dir": "/w", "last_pid": 42, "status": "Active"});
        let journal = vec![json!({
            "meta": {"working_dir": "/w", "last_pid": 42, "status": "Active"},
            "append_messages": []
        })];
        write_store(&dir, "session_a", Some(snapshot), &journal);
        let index = JcodeStoreIndex::with_store_dir(dir);
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved { session_id: "session_a".into() }
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
        let res = index.resolve(Path::new("/w"), &|pid| pid == 42, &|_| false);
        assert_eq!(
            res,
            JcodeSessionResolution::Resolved { session_id: "session_a".into() }
        );
    }
}
