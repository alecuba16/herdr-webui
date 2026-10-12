//! Chat-lens domain module: the structured conversation feature,
//! deliberately separated from terminal/PTY code and backend state.
//!
//! Ownership map (design: docs/ux/jcode-chat-transcript-design.md):
//! - [`jcode_transcript`] (sibling module): native-file parsing —
//!   resolution, snapshot+journal replay, turn shaping.
//! - This module: the wire layer — agent gating, conversation and
//!   tool-output payloads for `pane.conversation` /
//!   `pane.tool_output`, the response `version`/`generation` contract.
//! - `builtin_backend`: thin stateful adapter — gathers pane context
//!   (live cwd, process map, pane tail) from terminals/panes, then
//!   calls this module. No chat logic lives there.
//!
//! The input boundary is [`PaneContext`]: plain data (paths, pids,
//! tail text) so this module stays testable without a terminal.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::jcode_transcript::{
    JcodeSessionResolution, JcodeStoreIndex, RefusalReason, Turn, TurnPart, TurnRole,
};

/// Agent kinds with a transcript provider (design section 6).
/// `jcode` only; everything else keeps `agent_session: null` and the
/// Chat|Terminal toggle hidden. One definition for the whole backend;
/// the TUI (tui/model.rs) and the web frontend (lens.js) mirror it.
pub const SUPPORTED_AGENTS: &[&str] = &["jcode"];

/// True when the pane's agent kind has chat support.
pub fn agent_supported(agent: Option<&str>) -> bool {
    agent.is_some_and(|a| SUPPORTED_AGENTS.contains(&a))
}

/// Plain-data context for one pane, gathered by the backend adapter.
/// Everything the chat needs from the terminal side; nothing more.
#[derive(Debug, Clone)]
pub struct PaneContext {
    /// Session candidate: the pane's shell working directory, live
    /// (via the PTY child's cwd) when available, registered otherwise.
    pub live_cwd: PathBuf,
    /// The pane's PTY child pid, when a terminal is attached.
    pub terminal_pid: Option<u32>,
    /// Live processes, from the same table snapshot the backend uses.
    pub processes: Vec<ProcessRow>,
    /// Verbatim pane tail (ANSI stripped, CR dropped) for the
    /// recency tiebreak; empty is acceptable.
    pub pane_tail: String,
}

/// One process row the chat's resolution needs. Mirrors only the two
/// fields [`JcodeStoreIndex::resolve`] uses, so the backend's private
/// process type never leaks in.
#[derive(Debug, Clone, Copy)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
}

impl ProcessRow {
    /// From a backend process row (pid + parent pid).
    pub fn new(pid: u32, ppid: u32) -> Self {
        Self { pid, ppid }
    }
}

/// Global cached evidence index over `~/.jcode/sessions`. Same
/// process-lifetime pattern as the process-table cache.
pub fn store_index() -> &'static JcodeStoreIndex {
    static INDEX: OnceLock<JcodeStoreIndex> = OnceLock::new();
    INDEX.get_or_init(JcodeStoreIndex::new)
}

/// Same, against an explicit evidence index (fixture stores in tests).
pub fn resolve_session_with(
    index: &JcodeStoreIndex,
    context: &PaneContext,
) -> Result<String, String> {
    match resolve_with(index, context) {
        JcodeSessionResolution::Resolved { session_id } => Ok(session_id),
        JcodeSessionResolution::Refused { reason } => Err(match reason {
            RefusalReason::NoSessionPath => {
                "no_session_path: could not find a matching jcode session".to_string()
            }
            RefusalReason::Ambiguous => {
                "ambiguous: multiple jcode sessions match this pane".to_string()
            }
        }),
    }
}

/// Raw resolution with the typed reason, for the agent_session wire
/// object (its `reason` field is the code, not the message).
fn resolve_with(index: &JcodeStoreIndex, context: &PaneContext) -> JcodeSessionResolution {
    let processes: Vec<ProcessRow> = context.processes.clone();
    let by_pid: HashMap<u32, bool> = processes.iter().map(|p| (p.pid, true)).collect();
    index.resolve(
        &context.live_cwd,
        &|pid| by_pid.contains_key(&pid),
        &|pid| pid_in_tree(pid, context.terminal_pid, &processes),
        &context.pane_tail,
    )
}

/// The pane's `agent_session` value (design section 6). `null` for
/// unsupported agents (Chat lens hidden); `{kind, resolvable,
/// session_id}` for jcode panes when resolution succeeds.
pub fn agent_session(agent: &str, context: &PaneContext) -> Value {
    if !agent_supported(Some(agent)) {
        return Value::Null;
    }
    match resolve_with(store_index(), context) {
        JcodeSessionResolution::Resolved { session_id } => json!({
            "kind": agent,
            "resolvable": true,
            "session_id": session_id,
        }),
        JcodeSessionResolution::Refused { reason } => json!({
            "kind": agent,
            "resolvable": false,
            "reason": reason.as_str(),
        }),
    }
}

/// Page request for the conversation payload (reference `before` /
/// `from` parity): `before` names the turn the next OLDER page must
/// end before; `from` anchors the newest page so a poll never reads
/// more than a page once the chat holds older pages. Both cursors
/// are validated against the SAME session + generation or refused
/// with `history_changed` (409 semantics, design section 3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConversationPage {
    /// Cursor of the turn BEFORE which the page is cut. None = the
    /// newest page (no `before` param).
    pub before: Option<String>,
    /// Cursor of the oldest turn the chat already holds (`from`): a
    /// newest-page poll starts at it while it is still inside the
    /// newest page. None = first fetch.
    pub from: Option<String>,
}

/// A validated cursor: which session, which generation, which message
/// id opened the turn. The string form is `session_id:generation:message_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cursor {
    session_id: String,
    generation: String,
    message_id: String,
}

impl Cursor {
    fn encode(&self) -> String {
        format!(
            "{}:{}:{}",
            self.session_id, self.generation, self.message_id
        )
    }

    /// Parse `session_id:generation:message_id`. The session segment
    /// must match the live session (a cursor from another file answers
    /// history_changed, reference parity). The generation segment is
    /// NOT compared to the live stat signature: appends bump it every
    /// poll, and a held `from` cursor would 409 on every new message.
    /// Rotation is caught one layer down instead — the message id must
    /// still exist in the transcript, and rotation removes ids
    /// (snapshot+journal replay keeps survivors; /clear drops them).
    fn decode(cursor: &str, session_id: &str) -> Option<Self> {
        let mut parts = cursor.splitn(3, ':');
        let c_session = parts.next()?;
        let c_generation = parts.next()?;
        let c_message = parts.next()?;
        if c_session != session_id {
            return None; // another session's cursor
        }
        if !crate::jcode_transcript::valid_tool_ref(c_message) {
            return None;
        }
        Some(Self {
            session_id: c_session.to_string(),
            generation: c_generation.to_string(),
            message_id: c_message.to_string(),
        })
    }
}

/// Full conversation payload for a jcode pane (design section 4). The
/// stat signature of BOTH files (snapshot + journal) forms the response
/// `version`: an in-place rewrite (jcode writes tmp + rename) bumps it,
/// and any rotation/compaction changes it — so the client can render
/// append-only while it is unchanged (round 11).
///
/// Tests pass a fixture index; the adapter passes the process-lifetime
/// one (`store_index()`).
pub fn conversation_payload_with(
    index: &JcodeStoreIndex,
    context: &PaneContext,
    page: &ConversationPage,
) -> Result<Value, String> {
    // Resolution (pid evidence, live-pid+Active, recency tiebreak) is
    // shared with tool output: the conversation and every fetched
    // output must come from the SAME session.
    let session_id = resolve_session_with(index, context)?;
    let store_dir = index.store_dir();
    let generation = index.session_generation(&session_id);
    // Cursor validation FIRST (reference parseCursor parity): a cursor
    // naming another session refuses with history_changed before any
    // transcript work happens. (The generation segment rides along for
    // debugging only; see Cursor::decode for why it is not compared.)
    let before = match &page.before {
        Some(raw) => Some(
            Cursor::decode(raw, &session_id)
                .ok_or_else(|| "history_changed: cursor names another session".to_string())?,
        ),
        None => None,
    };
    let from = match &page.from {
        Some(raw) => Some(
            Cursor::decode(raw, &session_id)
                .ok_or_else(|| "history_changed: cursor names another session".to_string())?,
        ),
        None => None,
    };
    // A contradictory pair (both `before` and `from`) used to fall
    // through with `from` silently ignored. Refuse it: the client
    // only ever sends one direction per request, so a pair means a
    // bug or a hand-crafted URL, and guessing a winner would serve a
    // page the caller never asked for. Same refusal family as the
    // decode failures above so the wire code stays history_changed.
    if before.is_some() && from.is_some() {
        return Err("history_changed: before and from cursors are mutually exclusive".to_string());
    }
    // Cached read+parse, keyed by both files' stat signatures (the
    // SAME pair `generation` above hashes): an unchanged transcript
    // costs two stat calls, a journal append re-parses whole before
    // anything is served. `load_compaction` still reads every call:
    // it is one small file and must never ride a stale snapshot.
    let (messages, parsed_turns) = index.session_transcript_cached(&session_id);
    let messages = messages.as_ref();
    let turns_source = parsed_turns.as_ref().clone();
    let compaction = crate::jcode_transcript::load_compaction(store_dir, &session_id);
    // Both files unreadable/unparseable NOW (they existed at sweep time —
    // rotation or a deleted session raced us): transcript_missing.
    // Zero messages alone is a LEGITIMATE state (compact-only sessions,
    // empty fresh sessions) — render, never error (design section 3).
    if messages.is_empty() && compaction.is_none() {
        let snapshot_readable =
            std::fs::read_to_string(store_dir.join(format!("{session_id}.json")))
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .is_some();
        let journal_readable =
            std::fs::read(store_dir.join(format!("{session_id}.journal.jsonl"))).is_ok();
        if !snapshot_readable && !journal_readable {
            return Err("transcript_missing: session files are unreadable".to_string());
        }
    }
    let mut turns = turns_source;
    if let Some(summary) = compaction {
        // The server emits compaction as its own leading user turn and
        // drops nothing; the client renders it as a collapsed summary
        // widget (design section 3, reference isCompactSummary).
        turns.insert(
            0,
            Turn {
                role: TurnRole::User,
                ts: None,
                end_ts: None,
                message_id: None,
                parts: vec![TurnPart::Compact { summary }],
            },
        );
    }
    // --- page cut (reference MAX_PAGE_PROMPTS parity) ---
    // Cursors name the message id that OPENED a turn. The `before`
    // cursor's own turn belongs to the page ABOVE it: a `before` page
    // must end strictly before it, so find the turn whose message_id
    // matches and cut there. An id the live transcript no longer
    // holds answers history_changed (reference parseCursor parity):
    // rotation or /clear removed it, and serving anything else would
    // let the chat join pages from two different histories. The
    // compaction lead has no message id; it can never be a cursor
    // anchor and always stays on the page containing the session's
    // oldest real turn.
    let mut cut = turns.len();
    if let Some(before) = &before {
        cut = turns
            .iter()
            .position(|t| t.message_id.as_deref() == Some(before.message_id.as_str()))
            .ok_or_else(|| {
                "history_changed: cursor message no longer in the transcript".to_string()
            })?;
    }
    let mut start = 0usize;
    if let Some(from) = &from {
        // Hold the from-anchor while it is inside the newest page
        // (reference: `held >= newest.start`): the anchor's index is
        // where the newest page starts. A vanished `from` id answers
        // history_changed for the same reason as a vanished `before`
        // id: the anchor cannot be honored, and the reference makes the
        // chat re-anchor with a clean fetch rather than guess.
        let pos = turns
            .iter()
            .position(|t| t.message_id.as_deref() == Some(from.message_id.as_str()))
            .ok_or_else(|| {
                "history_changed: cursor message no longer in the transcript".to_string()
            })?;
        if pos < cut {
            start = pos;
        }
    }
    // At most PAGE_TURNS turns, ending at `cut`, starting on a turn
    // boundary: the newest page must exactly meet the page above it.
    let page_len = cut.saturating_sub(start).min(PAGE_TURNS);
    start = cut.saturating_sub(page_len);
    let page_turns = &turns[start..cut];
    // The next-older cursor: the message id that opens the page's
    // first turn. A page that starts AT the transcript's beginning
    // carries no cursor (reference: `cursor = null at the
    // conversation's beginning`) — the load-older control must see
    // the beginning, not a self-referencing `before` of the first
    // turn (which would answer a zero-turn page forever).
    let cursor = if start > 0 {
        page_turns
            .first()
            .and_then(|t| t.message_id.clone())
            .map(|message_id| Cursor {
                session_id: session_id.clone(),
                generation: generation.clone(),
                message_id,
            })
            .map(|c| c.encode())
    } else {
        None
    };
    let (model, status, reasoning_effort) = index.session_model_status(&session_id);
    let title = index.session_title(&session_id);
    let context_used = context_usage(messages);
    Ok(json!({
        "source": "jcode-transcript",
        "session_id": session_id,
        "turns": page_turns.iter().map(turn_json).collect::<Vec<_>>(),
        "cursor": cursor,
        "title": title,
        "context_used": context_used,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "status": status,
        "version": generation,
    }))
}

/// Page bound (reference MAX_PAGE_PROMPTS: half of MAX_TURNS, a
/// prompt-count the reference picks so a page reads quickly).
const PAGE_TURNS: usize = 100;

/// Tokens of context the LAST request filled (reference
/// ConversationMetadata.context.used parity). jcode records
/// `token_usage` per assistant message; the LAST one is the context
/// the model just saw. The writer is the guarantee: jcode stores
/// `prompt_tokens = effective_context_tokens_from_usage(...)`
/// (turn_streaming_mpsc.rs:1367, turn_loops.rs:921) — the effective
/// context fill under the provider's own accounting style
/// (compaction-core, issue #441: OpenAI-style subsets count the
/// cache inside `input_tokens`, Anthropic-style splits add
/// `cache_read` and `cache_creation` on top). It is what the
/// reference computes at read time for gjc transcripts
/// (conversation-metadata.ts:86, `input + cacheRead + cacheWrite`),
/// pre-resolved per request and immune to provider switches
/// mid-session. Older records lack it and mixed-provider totals
/// cannot be reconstructed, so absent means absent on the wire.
/// Verified against the real store: every usage record across
/// journals and snapshots carries it (77k+ on a live, growing
/// store), and usage rides assistant records only — the newest
/// user turn carries none, so the backward scan walks past it to
/// the latest assistant fill, the number a status line reads.
fn context_usage(messages: &[serde_json::Value]) -> Option<u64> {
    messages.iter().rev().find_map(|message| {
        let usage = message.get("token_usage")?;
        usage
            .get("prompt_tokens")
            .and_then(|t| t.as_u64())
            .filter(|t| *t > 0)
    })
}

/// One image the conversation's image part named, by ref (reference
/// conversationImage parity): same resolution pipeline and error
/// codes as the conversation itself, so an image ref can only be
/// fetched from the session the page came from. Ok(None) ->
/// image_not_found.
/// Same, against an explicit evidence index (fixture stores in tests).
pub fn conversation_image_with(
    index: &JcodeStoreIndex,
    context: &PaneContext,
    reference: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let session_id = resolve_session_with(index, context)?;
    Ok(crate::jcode_transcript::image_by_ref(
        index.store_dir(),
        &session_id,
        reference,
    ))
}

/// One whole tool output by call id (reference toolOutput parity):
/// walks the SAME message stream the conversation was built from and
/// returns the pre-trim output for the matching `tool_use_id`.
/// `Ok(None)` -> `tool_output_not_found`.
pub fn tool_output(context: &PaneContext, reference: &str) -> Result<Option<String>, String> {
    tool_output_with(store_index(), context, reference)
}

/// Same, against an explicit evidence index (fixture stores in tests).
pub fn tool_output_with(
    index: &JcodeStoreIndex,
    context: &PaneContext,
    reference: &str,
) -> Result<Option<String>, String> {
    if !crate::jcode_transcript::valid_tool_ref(reference) {
        return Ok(None);
    }
    let session_id = resolve_session_with(index, context)?;
    Ok(crate::jcode_transcript::tool_output_by_ref(
        index.store_dir(),
        &session_id,
        reference,
    ))
}

/// Wire shape of one turn: role, timestamps, parts with kinds the
/// client renders (text/thinking/tool/tool_pending/compact).
fn turn_json(turn: &Turn) -> Value {
    let parts = turn
        .parts
        .iter()
        .map(|part| match part {
            TurnPart::Text { text } => json!({ "kind": "text", "text": text }),
            TurnPart::Thinking { text } => json!({ "kind": "thinking", "text": text }),
            TurnPart::Tool {
                name,
                brief,
                input,
                output,
                is_error,
                output_ref,
                output_size,
            } => {
                let mut part = json!({
                    "kind": "tool", "name": name, "brief": brief,
                    "input": input, "output": output, "is_error": is_error,
                });
                if let Some(reference) = output_ref {
                    part["output_ref"] = Value::String(reference.clone());
                    if let Some(size) = output_size {
                        part["output_size"] = Value::from(*size);
                    }
                }
                part
            }
            TurnPart::ToolPending { name } => json!({ "kind": "tool_pending", "name": name }),
            TurnPart::Decision {
                question,
                options,
                context,
            } => {
                // Interactive ask_user chooser: same additive-shape rule
                // as every part — unknown kinds render as nothing in old
                // clients, and this carries no secrets (the options are
                // already in the session file the poll reads).
                json!({
                    "kind": "decision",
                    "question": question,
                    "options": options.iter().map(|opt| json!({
                        "label": opt.label,
                        "detail": opt.detail,
                    })).collect::<Vec<_>>(),
                    "context": context,
                })
            }
            TurnPart::Compact { summary } => json!({ "kind": "compact", "summary": summary }),
            TurnPart::Image { media_type, ref_id } => {
                json!({ "kind": "image", "media_type": media_type, "ref": ref_id })
            }
        })
        .collect::<Vec<_>>();
    json!({
        "role": match turn.role {
            TurnRole::User => "user",
            TurnRole::Assistant => "assistant",
        },
        "ts": turn.ts,
        "end_ts": turn.end_ts,
        "parts": parts,
    })
}

/// True when `pid` is inside the pane's process tree (the pane's PTY
/// child or any of its descendants). Evidence pid must be inside the
/// tree for step-1 resolution; jcode launched from this shell is.
fn pid_in_tree(pid: u32, root_pid: Option<u32>, processes: &[ProcessRow]) -> bool {
    let Some(root_pid) = root_pid else {
        return false;
    };
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for process in processes {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    let mut stack = vec![root_pid];
    let mut seen = HashSet::new();
    while let Some(current) = stack.pop() {
        if current == pid {
            return true;
        }
        if !seen.insert(current) {
            continue;
        }
        if let Some(child_pids) = children.get(&current) {
            stack.extend(child_pids.iter().copied());
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn only_jcode_is_supported() {
        assert!(agent_supported(Some("jcode")));
        assert!(!agent_supported(Some("claude")));
        assert!(!agent_supported(Some("codex")));
        assert!(!agent_supported(None));
    }

    #[test]
    fn turn_json_covers_all_part_kinds() {
        let turn = Turn {
            role: TurnRole::Assistant,
            ts: Some("2026-01-01T00:00:00Z".into()),
            end_ts: Some("2026-01-01T00:00:01Z".into()),
            message_id: Some("message_1".into()),
            parts: vec![
                TurnPart::Text {
                    text: "answer".into(),
                },
                TurnPart::Thinking { text: "hmm".into() },
                TurnPart::Tool {
                    name: "bash".into(),
                    brief: "ls".into(),
                    input: "{}".into(),
                    output: "files".into(),
                    is_error: false,
                    output_ref: Some("call_1".into()),
                    output_size: Some(5),
                },
                TurnPart::ToolPending {
                    name: "read".into(),
                },
                TurnPart::Decision {
                    question: "Deploy where?".into(),
                    options: vec![
                        crate::jcode_transcript::DecisionOption {
                            label: "dev".into(),
                            detail: Some("staging cluster".into()),
                        },
                        crate::jcode_transcript::DecisionOption {
                            label: "prod".into(),
                            detail: None,
                        },
                    ],
                    context: Some("release train".into()),
                },
                TurnPart::Compact {
                    summary: "folded".into(),
                },
            ],
        };
        let wire = turn_json(&turn);
        assert_eq!(wire["role"], "assistant");
        assert_eq!(wire["ts"], "2026-01-01T00:00:00Z");
        let kinds: Vec<&str> = wire["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["kind"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "text",
                "thinking",
                "tool",
                "tool_pending",
                "decision",
                "compact"
            ]
        );
        let tool = &wire["parts"][2];
        assert_eq!(tool["output_ref"], "call_1");
        assert_eq!(tool["output_size"], 5);
        let decision = &wire["parts"][4];
        assert_eq!(decision["question"], "Deploy where?");
        assert_eq!(decision["options"][0]["label"], "dev");
        assert_eq!(decision["options"][0]["detail"], "staging cluster");
        assert_eq!(decision["options"][1]["label"], "prod");
        assert_eq!(decision["options"][1]["detail"], serde_json::Value::Null);
        assert_eq!(decision["context"], "release train");
    }

    #[test]
    fn tool_part_without_ref_has_no_ref_fields() {
        let turn = Turn {
            role: TurnRole::User,
            ts: None,
            end_ts: None,
            message_id: None,
            parts: vec![TurnPart::Tool {
                name: "t".into(),
                brief: "b".into(),
                input: "{}".into(),
                output: "o".into(),
                is_error: true,
                output_ref: None,
                output_size: None,
            }],
        };
        let wire = turn_json(&turn);
        assert!(wire["parts"][0].get("output_ref").is_none());
        assert!(wire["parts"][0].get("output_size").is_none());
        assert_eq!(wire["parts"][0]["is_error"], true);
    }

    #[test]
    fn pid_in_tree_walks_descendants() {
        let rows = vec![
            ProcessRow { pid: 1, ppid: 0 },
            ProcessRow { pid: 2, ppid: 1 },
            ProcessRow { pid: 3, ppid: 2 },
            ProcessRow { pid: 9, ppid: 0 },
        ];
        assert!(pid_in_tree(3, Some(1), &rows));
        assert!(pid_in_tree(2, Some(1), &rows));
        assert!(!pid_in_tree(9, Some(1), &rows));
        assert!(!pid_in_tree(3, None, &rows));
    }

    #[test]
    fn agent_session_null_for_unsupported_and_object_for_jcode() {
        // Unsupported agent: null (Chat lens hidden).
        assert_eq!(agent_session("claude", &dummy_context()), Value::Null);
        // jcode with no matching session: resolvable:false with the
        // refusal reason code.
        let value = agent_session("jcode", &dummy_context());
        assert_eq!(value["kind"], "jcode");
        assert_eq!(value["resolvable"], false);
        assert_eq!(value["reason"], "no_session_path");
    }

    fn dummy_context() -> PaneContext {
        PaneContext {
            live_cwd: PathBuf::from("/nonexistent-definitely"),
            terminal_pid: None,
            processes: Vec::new(),
            pane_tail: String::new(),
        }
    }

    // --- fixture-store integration tests (full resolve -> payload
    // --- path over a synthetic ~/.jcode/sessions directory) ---

    use serde_json::json;

    /// Evidence + messages in one snapshot, journal appending more.
    /// The returned guard removes the scratch dir on scope exit, panic
    /// included; the trailing best-effort removes in older tests could
    /// not guarantee that and leaked a dir per run into TMPDIR.
    fn fixture_store(
        name: &str,
    ) -> (
        std::path::PathBuf,
        crate::tests::TempDirGuard,
        JcodeStoreIndex,
        String,
    ) {
        let dir = std::env::temp_dir().join(format!(
            "herdr-chat-lens-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = crate::tests::TempDirGuard::new(dir.clone());
        let session_id = format!("session_lens_{name}");
        // Snapshot: evidence (pid 4242, cwd /w, Active) + base turns.
        let snapshot = json!({
            "working_dir": "/w",
            "last_pid": 4242,
            "status": "Active",
            "messages": [
                {"id": "m1", "role": "user",
                 "content": [{"type": "text", "text": "hello"}]},
                {"id": "m2", "role": "assistant",
                 "content": [{"type": "text", "text": "hi there"}]}
            ]
        });
        std::fs::write(
            dir.join(format!("{session_id}.json")),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        // Journal: one more user turn.
        let journal = json!({
            "meta": {},
            "append_messages": [
                {"id": "m3", "role": "user",
                 "content": [{"type": "text", "text": "and more"}]}
            ]
        });
        std::fs::write(
            dir.join(format!("{session_id}.journal.jsonl")),
            serde_json::to_string(&journal).unwrap() + "\n",
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        (dir, _guard, index, session_id)
    }

    fn fixture_context() -> PaneContext {
        PaneContext {
            live_cwd: PathBuf::from("/w"),
            terminal_pid: Some(1),
            // 4242 in the pane's tree (child of 1).
            processes: vec![
                ProcessRow { pid: 1, ppid: 0 },
                ProcessRow { pid: 4242, ppid: 1 },
            ],
            pane_tail: String::new(),
        }
    }

    #[test]
    fn resolve_session_with_matches_by_process_tree() {
        let (_dir, _guard, index, session_id) = fixture_store("resolve");
        assert_eq!(
            resolve_session_with(&index, &fixture_context()),
            Ok(session_id)
        );
    }

    #[test]
    fn resolve_session_with_no_evidence_refuses_no_session_path() {
        let (_dir, _guard, index, _id) = fixture_store("refuse");
        let err = resolve_session_with(&index, &dummy_context()).unwrap_err();
        assert!(err.starts_with("no_session_path"), "got {err}");
    }

    #[test]
    fn conversation_payload_with_builds_turns_version_and_stats() {
        let (_dir, _guard, index, _id) = fixture_store("payload");
        let payload =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        // Wire shape (design section 4): source, session_id, version,
        // turns.
        assert_eq!(payload["source"], "jcode-transcript");
        assert_eq!(payload["session_id"], "session_lens_payload");
        assert!(payload["version"].is_string());
        assert!(!payload["version"].as_str().unwrap().is_empty());
        let turns = payload["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 3, "snapshot base + journal delta");
        assert_eq!(turns[0]["role"], "user");
        assert_eq!(turns[0]["parts"][0]["kind"], "text");
        assert_eq!(turns[0]["parts"][0]["text"], "hello");
        assert_eq!(turns[2]["parts"][0]["text"], "and more");
    }

    #[test]
    fn conversation_payload_with_transcript_missing_when_files_deleted() {
        let (dir, _guard, index, _id) = fixture_store("missing");
        // Prime the evidence cache (sweep sees the files), then the
        // session vanishes before the transcript read: resolution
        // still serves the cached row, both files unreadable NOW ->
        // transcript_missing. (If the sweep re-runs it sees nothing,
        // and the refusal degrades to no_session_path — also fine,
        // but the throttle makes the cached row the normal path.)
        let session_id = resolve_session_with(&index, &fixture_context()).unwrap();
        std::fs::remove_file(dir.join(format!("{session_id}.json"))).unwrap();
        std::fs::remove_file(dir.join(format!("{session_id}.journal.jsonl"))).unwrap();
        let err =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap_err();
        assert!(
            err.starts_with("transcript_missing") || err.starts_with("no_session_path"),
            "got {err}"
        );
    }

    #[test]
    fn conversation_payload_with_empty_session_returns_empty_turns() {
        // Resolves (evidence exists) but the store has zero parseable
        // messages and no compaction: empty turns array, not an error.
        let dir =
            std::env::temp_dir().join(format!("herdr-chat-lens-test-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _dir_guard = crate::tests::TempDirGuard::new(dir.clone());
        std::fs::write(
            dir.join("session_empty.json"),
            serde_json::to_string(&json!({
                "working_dir": "/w", "last_pid": 4242, "status": "Active",
                "messages": []
            }))
            .unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let payload =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        assert_eq!(payload["turns"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn tool_output_with_walks_the_same_message_stream() {
        let (_dir, _guard, index, _id) = fixture_store("tool");
        // No tool calls in the fixture: any ref is not found.
        assert_eq!(
            tool_output_with(&index, &fixture_context(), "toolu_call_1"),
            Ok(None)
        );
        // "not-a-ref" LOOKS invalid but is valid charset: it hits the
        // store and misses like any unknown id.
        assert_eq!(
            tool_output_with(&index, &fixture_context(), "not-a-ref"),
            Ok(None)
        );
        // A genuinely invalid ref (space) short-circuits before resolve.
        assert_eq!(
            tool_output_with(&index, &fixture_context(), "has space"),
            Ok(None)
        );
        // Empty ref: invalid too.
        assert_eq!(tool_output_with(&index, &fixture_context(), ""), Ok(None));
    }

    #[test]
    fn resolve_session_with_two_active_sessions_is_ambiguous() {
        // Two Active sessions, same pid, same cwd, empty pane tail:
        // tree step finds both, tiebreak cannot run -> ambiguous.
        let dir =
            std::env::temp_dir().join(format!("herdr-chat-lens-test-amb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _dir_guard = crate::tests::TempDirGuard::new(dir.clone());
        for id in ["session_p", "session_q"] {
            std::fs::write(
                dir.join(format!("{id}.json")),
                serde_json::to_string(&json!({
                    "working_dir": "/w", "last_pid": 4242, "status": "Active",
                    "messages": []
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let index = JcodeStoreIndex::with_store_dir(dir);
        let err = resolve_session_with(&index, &fixture_context()).unwrap_err();
        assert!(err.starts_with("ambiguous"), "got {err}");
    }

    #[test]
    fn conversation_payload_with_compaction_leads_with_summary_turn() {
        // Compaction summary in the journal meta: the payload inserts a
        // leading compact turn and drops nothing (design section 3).
        let dir =
            std::env::temp_dir().join(format!("herdr-chat-lens-test-cpt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _dir_guard = crate::tests::TempDirGuard::new(dir.clone());
        std::fs::write(
            dir.join("session_c.json"),
            serde_json::to_string(&json!({
                "working_dir": "/w", "last_pid": 4242, "status": "Active",
                "messages": [
                    {"id": "m1", "role": "user",
                     "content": [{"type": "text", "text": "after fold"}]}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("session_c.journal.jsonl"),
            serde_json::to_string(&json!({
                "meta": {"compaction": {"summary_text": "earlier context folded"}},
                "append_messages": []
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir);
        let payload =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        let turns = payload["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["role"], "user");
        assert_eq!(turns[0]["parts"][0]["kind"], "compact");
        assert_eq!(turns[0]["parts"][0]["summary"], "earlier context folded");
        assert_eq!(turns[1]["parts"][0]["text"], "after fold");
    }

    #[test]
    fn pid_in_tree_survives_ppid_cycles() {
        // A ppid cycle (1->2->1) must not loop forever: the seen set
        // stops re-visiting and the walk terminates.
        let rows = vec![
            ProcessRow { pid: 1, ppid: 2 },
            ProcessRow { pid: 2, ppid: 1 },
            ProcessRow { pid: 9, ppid: 0 },
        ];
        assert!(!pid_in_tree(9, Some(1), &rows));
        // A real descendant still resolves through the cycle members.
        let rows = vec![
            ProcessRow { pid: 1, ppid: 2 },
            ProcessRow { pid: 2, ppid: 1 },
            ProcessRow { pid: 7, ppid: 2 },
        ];
        assert!(pid_in_tree(7, Some(1), &rows));
    }

    #[test]
    fn parameterless_adapters_refuse_unresolvable_contexts() {
        // The production entry points (global ~/.jcode index) against
        // a context that cannot match ANY session: cwd is a path that
        // does not exist, no live processes, no pane text. Read-only
        // on the real store; the answer is refusal regardless of its
        // contents (nothing can match an empty process set).
        let err = conversation_payload_with(
            store_index(),
            &dummy_context(),
            &ConversationPage::default(),
        )
        .unwrap_err();
        assert!(err.starts_with("no_session_path"), "got {err}");
        // Invalid ref short-circuits before resolution.
        assert_eq!(tool_output(&dummy_context(), "has space"), Ok(None));
        // Valid ref, unresolvable pane: refusal, not a crash.
        let err = tool_output(&dummy_context(), "toolu_deadbeef").unwrap_err();
        assert!(err.starts_with("no_session_path"), "got {err}");
    }

    // --- cursor paging (reference before/from parity) ---

    /// A store with `count` user turns, ids m001..: long enough to
    /// cross the PAGE_TURNS bound.
    fn paged_store(name: &str, count: usize) -> (std::path::PathBuf, JcodeStoreIndex, String) {
        let dir = std::env::temp_dir().join(format!(
            "herdr-chat-lens-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session_id = format!("session_{name}");
        let messages: Vec<Value> = (0..count)
            .map(|i| {
                json!({
                    "id": format!("m{i:03}"),
                    "role": "user",
                    "content": [{"type": "text", "text": format!("turn {i}")}]
                })
            })
            .collect();
        std::fs::write(
            dir.join(format!("{session_id}.json")),
            serde_json::to_string(&json!({
                "working_dir": "/w",
                "last_pid": 4242,
                "status": "Active",
                "messages": messages,
            }))
            .unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        (dir, index, session_id)
    }

    #[test]
    fn newest_page_is_capped_and_carries_a_before_cursor() {
        let (_dir, index, session_id) = paged_store("page", 250);
        let payload =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        let turns = payload["turns"].as_array().unwrap();
        assert_eq!(turns.len(), PAGE_TURNS, "newest page is exactly PAGE_TURNS");
        // The newest page ends at the transcript tail.
        assert_eq!(turns.last().unwrap()["parts"][0]["text"], "turn 249");
        // The cursor is the ENCODED session:generation:message form the
        // client passes back as `before`.
        let cursor = payload["cursor"].as_str().unwrap();
        assert!(cursor.ends_with(":m150"), "cursor names m150, got {cursor}");
        assert!(cursor.starts_with(&session_id), "cursor names this session");
    }

    #[test]
    fn before_cursor_serves_the_page_above() {
        let (_dir, index, session_id) = paged_store("before", 250);
        let newest =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        let cursor = newest["cursor"].as_str().unwrap().to_string();
        let older = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: Some(cursor),
                from: None,
            },
        )
        .unwrap();
        let turns = older["turns"].as_array().unwrap();
        assert_eq!(turns.len(), PAGE_TURNS);
        // The before-page ENDS strictly before the cursor's own turn:
        // its last turn is the one just older than m150.
        assert_eq!(turns.last().unwrap()["parts"][0]["text"], "turn 149");
        assert_eq!(turns.first().unwrap()["parts"][0]["text"], "turn 50");
        // And it chains: the next-older cursor names m050.
        let older_cursor = older["cursor"].as_str().unwrap();
        assert!(
            older_cursor.starts_with(&format!("{session_id}:")),
            "same session"
        );
        assert!(
            older_cursor.ends_with(":m050"),
            "cursor names m050, got {older_cursor}"
        );
        // The third page reaches the beginning: cursor becomes null.
        let oldest = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: Some(older_cursor.to_string()),
                from: None,
            },
        )
        .unwrap();
        let oldest_turns = oldest["turns"].as_array().unwrap();
        assert_eq!(oldest_turns.len(), 50);
        assert_eq!(oldest_turns.first().unwrap()["parts"][0]["text"], "turn 0");
        assert_eq!(oldest["cursor"], serde_json::Value::Null);
    }

    #[test]
    fn from_cursor_holds_the_anchor_inside_the_newest_page() {
        // 120 turns: the newest page is capped at PAGE_TURNS (100), so
        // it starts at m020. A `from` anchor INSIDE that page is honored
        // (reference `held >= newest.start ? held : newest.start`).
        let (_dir, index, _id) = paged_store("from", 120);
        let anchored = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: None,
                from: Some("session_from:g1:m050".into()),
            },
        )
        .unwrap();
        let turns = anchored["turns"].as_array().unwrap();
        assert_eq!(
            turns.first().unwrap()["parts"][0]["text"],
            "turn 50",
            "from anchor inside the page window is the first turn served"
        );
        assert_eq!(turns.len(), 70);
        // An anchor OLDER than the page window cannot be honored in one
        // page: the newest page serves its capped window and the client
        // detects the slide (cursor != from) and backfills with `before`.
        // This mirrors the reference's `held >= newest.start ? held : newest.start`.
        let slid = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: None,
                from: Some("session_from:g1:m010".into()),
            },
        )
        .unwrap();
        let slid_turns = slid["turns"].as_array().unwrap();
        assert_eq!(slid_turns.len(), PAGE_TURNS);
        assert_eq!(slid_turns.first().unwrap()["parts"][0]["text"], "turn 20");
        assert!(slid["cursor"].as_str().unwrap().ends_with(":m020"));
        // The anchor survives appends: a from-poll after two new turns
        // still starts at the (in-window) anchor and reaches the tail.
        let (dir, index, _id) = paged_store("from2", 60);
        std::fs::write(
            dir.join("session_from2.journal.jsonl"),
            serde_json::to_string(&json!({
                "meta": {},
                "append_messages": [
                    {"id": "m060", "role": "user",
                     "content": [{"type": "text", "text": "new a"}]},
                    {"id": "m061", "role": "user",
                     "content": [{"type": "text", "text": "new b"}]}
                ]
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();
        let after = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: None,
                from: Some("session_from2:g1:m010".into()),
            },
        )
        .unwrap();
        let turns = after["turns"].as_array().unwrap();
        assert_eq!(turns.first().unwrap()["parts"][0]["text"], "turn 10");
        assert_eq!(turns.last().unwrap()["parts"][0]["text"], "new b");
    }

    #[test]
    fn cursor_from_another_session_or_a_vanished_id_answers_history_changed() {
        let (_dir, index, session_id) = paged_store("gone", 5);
        // Session-mismatched cursor: refused before any transcript work.
        let err = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: Some("session_other:g1:m001".into()),
                from: None,
            },
        )
        .unwrap_err();
        assert!(err.starts_with("history_changed"), "got {err}");
        // Same-session cursor whose message id no longer exists
        // (rotation or /clear removed it).
        let err = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: Some(format!("{session_id}:g1:nope")),
                from: None,
            },
        )
        .unwrap_err();
        assert!(err.starts_with("history_changed"), "got {err}");
        // Same for `from`.
        let err = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: None,
                from: Some(format!("{session_id}:g1:nope")),
            },
        )
        .unwrap_err();
        assert!(err.starts_with("history_changed"), "got {err}");
    }

    #[test]
    fn payload_carries_title_and_context_used_from_the_newest_usage() {
        // The composer meta line rests on two wire fields that have no
        // wire-layer assertion: `title` (journal meta first, snapshot
        // fallback) and `context_used` (NEWEST prompt_tokens — a
        // session's context grows, so the last request's usage is the
        // one a status line should read).
        let dir =
            std::env::temp_dir().join(format!("herdr-chat-lens-test-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session_id = "session_lens_meta";
        // Journal: a meta line (real shape: title lives under
        // `meta`, custom_title is the user-chosen name) plus a delta
        // record whose appended user turn's token_usage is the NEWEST
        // (12k, later than the snapshot's 950). Real journals carry
        // {meta, append_messages} pairs, never bare messages.
        let journal = json!({
            "meta": {},
            "append_messages": [],
        });
        let delta = json!({
            "meta": {
                "title": null,
                "custom_title": "permissions to dmitri",
            },
            // Real store shape (verified live): token_usage rides
            // ASSISTANT messages — the response carries the request's
            // usage. A trailing user message carries none, so the scan
            // must keep walking backward past it.
            "append_messages": [
                {
                    "id": "m3",
                    "role": "assistant",
                    "token_usage": { "prompt_tokens": 12000 },
                    "content": [{"type": "text", "text": "later turn"}],
                },
                {
                    "id": "m4",
                    "role": "user",
                    "content": [{"type": "text", "text": "follow-up question"}],
                }
            ],
        });
        let snapshot = json!({
            "working_dir": "/w",
            "last_pid": 4242,
            "status": "Active",
            "title": "snapshot fallback title",
            "messages": [
                {"id": "m1", "role": "user",
                 "content": [{"type": "text", "text": "hello"}]},
                {"id": "m2", "role": "assistant",
                 "token_usage": { "prompt_tokens": 950 },
                 "content": [{"type": "text", "text": "hi there"}]}
            ]
        });
        std::fs::write(
            dir.join(format!("{session_id}.json")),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let text = format!(
            "{}\n{}\n",
            serde_json::to_string(&journal).unwrap(),
            serde_json::to_string(&delta).unwrap()
        );
        std::fs::write(dir.join(format!("{session_id}.journal.jsonl")), text).unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        let payload =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        // Title: the journal's newest meta line decides — custom_title
        // (the user-chosen name) over the auto-generated `title`
        // summary, exactly jcode's display_title rule (session.rs).
        assert_eq!(payload["title"], "permissions to dmitri");
        // Context: the newest prompt_tokens, not the oldest, not a sum.
        assert_eq!(payload["context_used"], 12000);
        // Three turns: m2+m3 are adjacent assistants and merge into
        // one turn (parse rule, tested in jcode_transcript); the
        // trailing user message is its own turn.
        assert_eq!(payload["turns"].as_array().unwrap().len(), 3);

        // Without any usage on the wire: null, so the composer drops
        // the segment instead of inventing a count.
        let no_usage_dir = dir.join("no-usage");
        std::fs::create_dir_all(&no_usage_dir).unwrap();
        let snap2 = json!({
            "working_dir": "/w",
            "last_pid": 4242,
            "status": "Active",
            "messages": [
                {"id": "m1", "role": "user",
                 "content": [{"type": "text", "text": "hello"}]}
            ]
        });
        std::fs::write(
            no_usage_dir.join(format!("{session_id}.json")),
            serde_json::to_string(&snap2).unwrap(),
        )
        .unwrap();
        std::fs::write(
            no_usage_dir.join(format!("{session_id}.journal.jsonl")),
            "\n",
        )
        .unwrap();
        let index2 = JcodeStoreIndex::with_store_dir(no_usage_dir.clone());
        let bare =
            conversation_payload_with(&index2, &fixture_context(), &ConversationPage::default())
                .unwrap();
        assert_eq!(
            bare["title"],
            serde_json::Value::Null,
            "no title anywhere: null"
        );
        assert_eq!(
            bare["context_used"],
            serde_json::Value::Null,
            "no token_usage recorded: null, never 0 (composer drops the segment)"
        );

        // Auto-summary fallback: the snapshot's long `title` (the real
        // store carries full sentences there) is truncated to one
        // status line; a short one passes through untouched.
        let auto_dir = dir.join("auto-title");
        std::fs::create_dir_all(&auto_dir).unwrap();
        let long = "The objective is to increase the UX quality and visual feel of the whole application, across every surface, without regressions";
        let snap3 = json!({
            "working_dir": "/w",
            "last_pid": 4242,
            "status": "Active",
            "title": long,
            "messages": [
                {"id": "m1", "role": "user",
                 "content": [{"type": "text", "text": "hello"}]}
            ]
        });
        std::fs::write(
            auto_dir.join(format!("{session_id}.json")),
            serde_json::to_string(&snap3).unwrap(),
        )
        .unwrap();
        std::fs::write(auto_dir.join(format!("{session_id}.journal.jsonl")), "\n").unwrap();
        let index3 = JcodeStoreIndex::with_store_dir(auto_dir.clone());
        let auto =
            conversation_payload_with(&index3, &fixture_context(), &ConversationPage::default())
                .unwrap();
        assert_eq!(
            auto["title"].as_str().unwrap().chars().count(),
            81,
            "a long auto-summary truncates to 80 chars plus the ellipsis"
        );
        assert!(auto["title"].as_str().unwrap().ends_with('…'));
        assert!(auto["title"].as_str().unwrap().starts_with("The objective"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn version_bumps_on_real_file_change_so_etag_stops_matching() {
        // The end-to-end etag invariant at the wire layer: two reads of
        // an unchanged store carry the SAME version (the poll stores
        // it), and an in-place snapshot rewrite (jcode writes tmp +
        // rename) produces a DIFFERENT one, so the lens's stored tag no
        // longer matches and the next poll gets the full payload, not a
        // 304 with stale turns.
        let (dir, index, session_id) = paged_store("etag-e2e", 3);
        let page = ConversationPage::default();
        let v1 = conversation_payload_with(&index, &fixture_context(), &page).unwrap()["version"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            conversation_payload_with(&index, &fixture_context(), &page).unwrap()["version"],
            v1.as_str(),
            "unchanged store: same version, the etag is usable"
        );
        // Rewrite the snapshot in place with one more message.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let messages: Vec<Value> = (0..4)
            .map(|i| {
                json!({
                    "id": format!("m{i:03}"),
                    "role": "user",
                    "content": [{"type": "text", "text": format!("turn {i}")}]
                })
            })
            .collect();
        let tmp = dir.join(format!("{session_id}.tmp"));
        std::fs::write(
            &tmp,
            serde_json::to_string(&json!({
                "working_dir": "/w",
                "last_pid": 4242,
                "status": "Active",
                "messages": messages,
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::rename(&tmp, dir.join(format!("{session_id}.json"))).unwrap();
        let fresh = conversation_payload_with(&index, &fixture_context(), &page).unwrap();
        assert_ne!(
            fresh["version"].as_str().unwrap(),
            v1,
            "a rewritten transcript must not answer 304 against the old tag"
        );
        assert_eq!(
            fresh["turns"].as_array().unwrap().len(),
            4,
            "the new turn is visible"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cursor_generation_segment_rides_but_never_gates() {
        // A held `from` cursor from an OLD generation must still serve:
        // every append bumps the generation, and gating on it would
        // 409 the anchor on every new message (design change, Cursor::decode).
        let (dir, index, _id) = paged_store("gen", 5);
        std::fs::write(
            dir.join("session_gen.journal.jsonl"),
            serde_json::to_string(&json!({
                "meta": {},
                "append_messages": [
                    {"id": "m005", "role": "user",
                     "content": [{"type": "text", "text": "appended"}]}
                ]
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();
        let anchored = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: None,
                from: Some("session_gen:stale-generation:m001".into()),
            },
        )
        .unwrap();
        let turns = anchored["turns"].as_array().unwrap();
        assert_eq!(turns.first().unwrap()["parts"][0]["text"], "turn 1");
        assert_eq!(turns.last().unwrap()["parts"][0]["text"], "appended");
    }

    // --- image part bytes (reference conversationImage parity) ---

    #[test]
    fn conversation_image_with_serves_the_named_message_bytes() {
        let dir =
            std::env::temp_dir().join(format!("herdr-chat-lens-test-img-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 1x1 PNG, hand-encoded base64 (no crates).
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let decoded = crate::jcode_transcript::base64_decode(png_b64).unwrap();
        std::fs::write(
            dir.join("session_img.json"),
            serde_json::to_string(&json!({
                "working_dir": "/w",
                "last_pid": 4242,
                "status": "Active",
                "messages": [
                    {"id": "m1", "role": "user",
                     "content": [
                        {"type": "text", "text": "look"},
                        {"type": "image", "media_type": "image/png", "data": png_b64}
                     ]}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let index = JcodeStoreIndex::with_store_dir(dir.clone());
        // The image part carries the ref on the wire (turn_json) and the
        // bytes come back through conversation_image_with. Images LEAD
        // the turn (reference parity: the words reference the picture
        // above them), so the image is parts[0] and the text parts[1].
        let payload =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        let part = &payload["turns"][0]["parts"][0];
        assert_eq!(part["kind"], "image");
        assert_eq!(part["media_type"], "image/png");
        assert_eq!(part["ref"], "m1");
        assert_eq!(payload["turns"][0]["parts"][1]["text"], "look");
        let (media_type, bytes) = conversation_image_with(&index, &fixture_context(), "m1")
            .unwrap()
            .unwrap();
        assert_eq!(media_type, "image/png");
        assert_eq!(bytes, decoded);
        // Unknown ref: None (image_not_found at the route).
        assert_eq!(
            conversation_image_with(&index, &fixture_context(), "m999"),
            Ok(None)
        );
        // Invalid charset: None before resolution work.
        assert_eq!(
            conversation_image_with(&index, &fixture_context(), "has space"),
            Ok(None)
        );
        // Empty ref: None.
        assert_eq!(
            conversation_image_with(&index, &fixture_context(), ""),
            Ok(None)
        );
    }

    // --- cached read+parse (per-session, stat-signature keyed) ---

    #[test]
    fn transcript_cache_serves_the_same_parse_while_files_are_unchanged() {
        let (_dir, index, session_id) = fixture_store("cache_hit");
        let page = ConversationPage::default();
        let first = conversation_payload_with(&index, &fixture_context(), &page).unwrap();
        let (messages_a, turns_a) = index.session_transcript_cached(&session_id);
        let second = conversation_payload_with(&index, &fixture_context(), &page).unwrap();
        let (messages_b, turns_b) = index.session_transcript_cached(&session_id);
        // Same generation, same Arc: the second call served the cached
        // parse instead of re-reading the files.
        assert!(Arc::ptr_eq(&messages_a, &messages_b));
        assert!(Arc::ptr_eq(&turns_a, &turns_b));
        // And the payload over the cache is the payload from disk.
        assert_eq!(first, second);
        let turns = second["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 3, "snapshot m1/m2 + journal m3");
    }

    #[test]
    fn transcript_cache_invalidates_on_journal_append() {
        let (dir, index, session_id) = fixture_store("cache_inval");
        let page = ConversationPage::default();
        let first = conversation_payload_with(&index, &fixture_context(), &page).unwrap();
        assert_eq!(first["turns"].as_array().unwrap().len(), 3);
        // Append one more turn to the journal: the size stat moves, the
        // cached parse must be dropped, never partially patched.
        let journal = json!({
            "meta": {},
            "append_messages": [
                {"id": "m4", "role": "user",
                 "content": [{"type": "text", "text": "fresh append"}]}
            ]
        });
        std::fs::write(
            dir.join(format!("{session_id}.journal.jsonl")),
            serde_json::to_string(&journal).unwrap() + "\n",
        )
        .unwrap();
        let second = conversation_payload_with(&index, &fixture_context(), &page).unwrap();
        let turns = second["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 3, "snapshot m1/m2 + journal m4 only");
        assert_eq!(turns.last().unwrap()["parts"][0]["text"], "fresh append");
    }

    // --- before+from pair: explicit refusal, no silent winner ---

    #[test]
    fn before_and_from_together_refuse_with_history_changed() {
        let (_dir, index, _session_id) = paged_store("pair", 120);
        let newest =
            conversation_payload_with(&index, &fixture_context(), &ConversationPage::default())
                .unwrap();
        let before_cursor = newest["cursor"].as_str().unwrap().to_string();
        let err = conversation_payload_with(
            &index,
            &fixture_context(),
            &ConversationPage {
                before: Some(before_cursor),
                from: Some(format!("{}:g1:m007", newest_session_id(&newest))),
            },
        )
        .unwrap_err();
        assert!(err.starts_with("history_changed"), "got {err}");
        assert!(err.contains("mutually exclusive"), "got {err}");
    }

    fn newest_session_id(payload: &Value) -> String {
        payload["session_id"].as_str().unwrap().to_string()
    }
}
