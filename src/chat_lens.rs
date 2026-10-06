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

/// Full conversation payload for a jcode pane (design section 4). The
/// stat signature of BOTH files (snapshot + journal) forms the response
/// `version`: an in-place rewrite (jcode writes tmp + rename) bumps it,
/// and any rotation/compaction changes it — so the client can render
/// append-only while it is unchanged (round 11).
pub fn conversation_payload(context: &PaneContext) -> Result<Value, String> {
    conversation_payload_with(store_index(), context)
}

/// Same, against an explicit evidence index (tests pass a fixture
/// store; the adapter passes the process-lifetime one).
pub fn conversation_payload_with(
    index: &JcodeStoreIndex,
    context: &PaneContext,
) -> Result<Value, String> {
    // Resolution (pid evidence, live-pid+Active, recency tiebreak) is
    // shared with tool output: the conversation and every fetched
    // output must come from the SAME session.
    let session_id = resolve_session_with(index, context)?;
    let store_dir = index.store_dir();
    let messages = crate::jcode_transcript::load_session_messages(store_dir, &session_id);
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
    let mut turns = crate::jcode_transcript::parse_jcode_transcript(&messages);
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
                parts: vec![TurnPart::Compact { summary }],
            },
        );
    }
    let version = index.session_generation(&session_id);
    let (model, status, reasoning_effort) = index.session_model_status(&session_id);
    Ok(json!({
        "source": "jcode-transcript",
        "session_id": session_id,
        "turns": turns.iter().map(turn_json).collect::<Vec<_>>(),
        "cursor": null,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "status": status,
        "version": version,
    }))
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
    fn fixture_store(name: &str) -> (std::path::PathBuf, JcodeStoreIndex, String) {
        let dir = std::env::temp_dir().join(format!(
            "herdr-chat-lens-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
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
        (dir, index, session_id)
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
        let (_dir, index, session_id) = fixture_store("resolve");
        assert_eq!(
            resolve_session_with(&index, &fixture_context()),
            Ok(session_id)
        );
    }

    #[test]
    fn resolve_session_with_no_evidence_refuses_no_session_path() {
        let (_dir, index, _id) = fixture_store("refuse");
        let err = resolve_session_with(&index, &dummy_context()).unwrap_err();
        assert!(err.starts_with("no_session_path"), "got {err}");
    }

    #[test]
    fn conversation_payload_with_builds_turns_version_and_stats() {
        let (_dir, index, _id) = fixture_store("payload");
        let payload = conversation_payload_with(&index, &fixture_context()).unwrap();
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
        let (dir, index, _id) = fixture_store("missing");
        // Prime the evidence cache (sweep sees the files), then the
        // session vanishes before the transcript read: resolution
        // still serves the cached row, both files unreadable NOW ->
        // transcript_missing. (If the sweep re-runs it sees nothing,
        // and the refusal degrades to no_session_path — also fine,
        // but the throttle makes the cached row the normal path.)
        let session_id = resolve_session_with(&index, &fixture_context()).unwrap();
        std::fs::remove_file(dir.join(format!("{session_id}.json"))).unwrap();
        std::fs::remove_file(dir.join(format!("{session_id}.journal.jsonl"))).unwrap();
        let err = conversation_payload_with(&index, &fixture_context()).unwrap_err();
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
        let payload = conversation_payload_with(&index, &fixture_context()).unwrap();
        assert_eq!(payload["turns"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn tool_output_with_walks_the_same_message_stream() {
        let (_dir, index, _id) = fixture_store("tool");
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
        let payload = conversation_payload_with(&index, &fixture_context()).unwrap();
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
        let err = conversation_payload(&dummy_context()).unwrap_err();
        assert!(err.starts_with("no_session_path"), "got {err}");
        // Invalid ref short-circuits before resolution.
        assert_eq!(tool_output(&dummy_context(), "has space"), Ok(None));
        // Valid ref, unresolvable pane: refusal, not a crash.
        let err = tool_output(&dummy_context(), "toolu_deadbeef").unwrap_err();
        assert!(err.starts_with("no_session_path"), "got {err}");
    }
}
