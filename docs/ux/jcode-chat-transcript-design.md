# jcode chat transcript: design (reference herdr-web-ui model)

Goal: make the Chat lens show the real jcode conversation (not the empty
scrollback tail), and show the Chat|Terminal switch only when the pane's
agent has a supported transcript provider.

Reference: devswha/herdr-web-ui builds chat from agent-native session files
server-side (`server/conversation.ts`), never from the terminal buffer. We do
the same for jcode. Protocol 22 stays frozen: new HTTP route only (same
pattern the composer used with `POST /api/panes/{id}/submit`).

## 1. Source of truth: jcode journal — CORRECTED after live observation

jcode writes, per session:

- `~/.jcode/sessions/session_<name>_<ts>_<id>.journal.jsonl` — append-only
  journal of deltas. Each line: `{ "meta": {...}, "append_messages": [...] }`.
  `meta` holds `last_pid`, `working_dir`, `status`, `model`,
  `reasoning_effort`, `updated_at`, `short_name`, `parent_id`,
  `compaction`. `append_messages` entries: `{id, role: user|assistant,
  content: [{type: text|reasoning|tool_use|tool_result, ...}]}`.
- `session_*.json` — the FULL session snapshot (all messages), rewritten as
  a checkpoint.

**Rotation (validated live + in jcode source,
`crates/jcode-base/src/session/persistence.rs` + `session.rs:270`):** the
journal grows append-only only until 512 KiB (`MAX_SESSION_JOURNAL_BYTES =
512 * 1024`); at the next save past that limit jcode calls
`checkpoint_snapshot()` which rewrites the full `.json` snapshot and
**DELETES the journal**. This exact rotation was observed mid-validation:
this session's journal went 127 lines (~500 KB, full history since 13:05)
to 6 lines starting at the 13:14 turn. So:

- The journal alone is NOT a complete transcript once it rotates. The full
  history lives in the `.json` snapshot; the journal is the delta SINCE the
  last checkpoint.
- **Correct read model (matches jcode's own load path):** parse the snapshot
  `.json` (`messages` array, same StoredMessage shape) as the base, then
  replay the journal's `append_messages` on top. Snapshot and journal
  messages are disjoint by construction (the checkpoint resets the delta
  counter and deletes the journal), which the live rotation confirmed:
  0 of 20 post-rotation journal message ids existed in the 159-message
  snapshot.
- Incidence for the resolution/staleness step: after rotation the journal
  is tiny again, so stat-based generation checks must watch BOTH files
  (snapshot rewrite = full-generation change; journal delete+recreate =
  new generation for the delta stream).

The parser module therefore takes (snapshot messages, journal entries), not
journal lines alone. Torn-tail/skip handling stays journal-only.

## 2. Pane → session resolution (builtin backend)

Resolution order, all read-only, no newest-file fallback (reference rule:

a non-evidenced guess is worse than no chat):

1. **PID evidence (primary).** The builtin backend already probes the pane's
   process tree (`probe_live_process_agent` uses `child_pid` +
   `process_table()`). Collect the set of live PIDs under the pane's child.
   Scan sessions (snapshot or journal) whose `working_dir` canonical-equals
   the pane cwd and whose `last_pid` is in that PID set. Exactly one match
   wins; zero or many → continue.
   Validated caveat: `last_pid` can point at jcode's shared `serve` process,
   which daemonizes to PPID 1 and leaves the pane's process tree, so this
   step can legitimately miss. Never the only step.
2. **Live-PID + cwd + status fallback.** No process tree hit (mac
   wrapper, shell nesting, daemonized serve): sessions with matching
   `working_dir` and `last_pid` alive in the process table, filtered on
   `status == Active`. Status handling in Rust: parse as
   `serde_json::Value` and accept ONLY the string `"Active"` exactly;
   everything else counts as non-Active. Verified against jcode's
   `SessionStatus` enum (`crates/jcode-session-types/src/lib.rs:154`):
   `Active`, `Closed`, `Crashed { message }` plus `Reloaded`,
   `Compacted`, `RateLimited`, `Error { message }` — the extra
   variants are also object-or-non-Active and correctly rejected by
   the exact-string match, but they exist and a naive enum mirror
   would miss them. Matching on the raw Value avoids coupling to
   jcode's internal status type (no enum needed). Rationale (validated
   live, re-verified in round 6): unfiltered, this step returns
   AMBIGUOUS results because the shared daemon's PID is written into
   every session it hosts — of 21 same-cwd sessions, 3 carried the live
   daemon pid 21155 (two non-Active, one Active); both non-Active
   states are terminal. If exactly one Active session remains, it
   wins; zero or many → continue. Round-6 note: the round-2 prototype
   initially lacked this filter and FAILED live resolution
   (3 hits → ambiguous → `no_session_path`); adding the exact design
   step-2 filter made it pass again, proving the filter is
   load-bearing, not theoretical. In the live test the filter left
   exactly the one true session (`vole`, Active) and dropped a
   `Crashed` and a `Closed` session sharing the daemon PID.
3. **Recency tiebreak (last resort, evidenced).** If several Active sessions
   share the pid+cwd (two concurrent jcode clients on one daemon in the same
   repo), match the pane's visible tail text against each candidate's most
   recent assistant text (reference's bounded pane-text match). Exactly one
   substantial unique match wins. Never newest-mtime alone.
4. Else: `no_session_path` and the lens stays on scrollback mode with a
   "chat unavailable for this pane" hint.

Never select by mtime alone. Primary gate: the pane argv/OSC-9 `jcode`
label. Fallback for the first seconds of a pane (argv detection misses
under wrapper shells and OSC 9 has not fired yet): attempt resolution
whenever the pane cwd has ANY Active jcode session; the switch only
lights up on successful resolution, so a failed attempt is harmless.

Cache resolution per pane, keyed by (path, mtime_ns, size) of BOTH
files (snapshot and journal — rotation deletes and recreates the
journal, so a journal-only stat misses generation changes) and
revalidate on each conversation poll: in-place rewrites bump the
generation and invalidate the response `version` (reference:
`transcriptGeneration`).

**Measured costs (round 4, live store, 2559 sessions):** the cold evidence
index build (parse all snapshots for pid/cwd/status) costs ~600 ms — too
expensive per poll, but fine once at pane-resolution time. The per-poll budget
is covered by a stat-only revalidation sweep: ~17 ms to stat all 2565 files
and re-parse only the changed ones (live session: 2 ms; largest snapshot in
the store, 12 MiB: 34 ms). So the implementation MUST cache the evidence
index keyed by (path, mtime_ns, size) and re-stat per poll, not rebuild.
**Round-5 load validation (live, concurrent with an active agent session):**
running the cached strategy in a 0.5s loop for 15s while jcode actively
appended: sweep median 32 ms (p95 33 ms), live-session parse median 4.4 ms,
zero errors. Two concurrent readers hammering the snapshot during active
saving: 9,058 reads, 0 errors (atomic rename + hard-link bak hold under
reader concurrency). Worst-case turn visibility = poll interval (2 s) +
parse (<5 ms) — the 300 ms save-side lag was measured separately and adds
no buffering layer. The 2s poll budget holds with an order of magnitude of
headroom.

## 3. Turn parsing (`src/jcode_transcript.rs`, new module)

Pure function, unit-tested: `parse_jcode_transcript(snapshot_messages,
journal_entries) -> Vec<Turn>`.

- Replay each line's `append_messages` ON TOP OF the snapshot `messages`
  array (same StoredMessage shape; disjoint by construction after each
  checkpoint — validated live: 0 id overlap between the post-rotation
  journal and the 159-message snapshot).
  Validated shapes across the whole local store (8 journals, 127 messages,
  0 torn lines): user messages carry `content` as a block array only
  (`text` or `tool_result`, never mixed, never a bare string); `tool_use`
  pairs by `tool_use_id` with 38/39 matched in a live session (the
  unmatched one is the in-flight call — render pending); `is_error` exists
  on `tool_result`; `reasoning` blocks carry a `text` field.
- User turn: text parts joined; skip meta/system-ish entries (isMeta
  equivalents: none seen in jcode, but guard anyway).
- Assistant turn: adjacent assistant messages merge into one turn
  (reference `assistantTurn`); parts: `text`, `thinking` (collapsed),
  `tool_use` (name + brief input summary), with the matching `tool_result`
  folded in by id, `is_error` flagged.
- `compaction` in meta → a `compact` summary part (readable on demand).
  Validated shape: `{summary_text, covers_up_to_turn, original_turn_count,
  compacted_count}` — render `summary_text` only. Rendering decision
  (one choice, stated once): the SERVER emits compaction as a `compact`
  part and does NOT drop turns server-side; the CLIENT folds nothing —
  it renders the `compact` part as a collapsed summary widget and shows
  every turn the server sends. The "turns before `covers_up_to_turn`
  stay in the log" premise is NOT universally true: compact-only
  sessions with ZERO message records were observed (section 8), so the
  parser must tolerate a transcript whose only record is the
  compaction summary (render summary, zero turns) — covered by parser
  tests. `parent_id` (resume chains: 22 of 24 sessions with a parent)
  does NOT chain transcripts here — the journal of the resumed session
  already replays the full message list on append, so reading one
  journal is enough. Re-check when implementing: if a fresh resume
  starts with an empty journal, follow `parent_id` chains like the
  reference's `codexHistorySegments`.
  Executable check across all 24 sessions: only 8 journals exist; of them,
  4 are single-record files (3 compact-only with `parent_id: null` and a
  40-char `summary_text`, 1 with empty `append_messages`), and none of the
  8 journals carries a non-null `parent_id` — so resume chains were NOT
  observable locally. The compact-only journals show a second path:
  compaction can be the ONLY record, so the chat must render the summary
  even with zero message records, and the empty `herb` journal shows a
  zero-turn conversation is a legitimate state (render an empty chat, not
  an error). Both cases must be covered by parser tests.
- The `session_*.json` snapshots and `.bak` files (2384 of them, from
  crash-safe rewrites) must be excluded from journal scans: glob
  `*.journal.jsonl` only, and ignore `.bak`.

Validated live-update cadence (executable prototype run against this very
  session's journal): appends are message-granular (a record lands when a
  message completes or a tool_result returns; the file's `meta.updated_at`
  tracked within ~300ms of wall clock while working). A 2s lens poll is
  therefore sufficient to catch new records; no frame-level streaming is
  possible or needed.

Paging: v1 ships newest-page-only — last 200 turns (the reference
  caps at `MAX_TURNS = 100` in `transcript-records.ts:78`; we pick 200
  for jcode since snapshots parse cheaply at 34 ms), no `before`
  cursor. Justification: the largest snapshot in the store (12 MiB)
  parses in 34 ms (round 4), well inside the 2s poll budget; the
  reference uses a 16 MB tail window (`TRANSCRIPT_WINDOW_BYTES`,
  `conversation.ts:58`) precisely to bound reparsing cost, which our
  full-snapshot read avoids; add paging only if a real session renders
  slowly. The response keeps a `cursor: null` field so the wire shape
  is forward-compatible. When paging is added later, cursor = message
  id, NOT a byte offset: jcode message ids are globally unique
  (`message_<ts>_<nonce>`, validated), and byte offsets into the
  journal cannot survive rotation (journal deleted + recreated at each
  checkpoint). Generation invalidation must cover BOTH file identities
  — cursor = (snapshot generation, journal generation, message id),
  refused with 409 semantics when either generation changed.

## 4. HTTP route

`GET /api/panes/{pane_id}/conversation` (builtin backend only; external herdr
gets it later via its own RPC, passthrough-free for now).

Response (thin server, thick shaping — same SOLID call as the composer):

```json
{
  "source": "jcode-transcript",
  "turns": [ { "role": "user"|"assistant",
               "ts": "...", "end_ts": "...",
               "parts": [ {"kind":"text"|"thinking"|"tool"|"compact",
                            ... } ] } ],
  "cursor": "null in v1 (forward-compatible, see section 3 paging)",
  "model": "...", "reasoning_effort": null,
  "status": "Active",
  "version": "<etag-ish hash>"
}
```

Errors: `{error, code}` with codes `no_session_path`, `pane_not_found`,
`unsupported_agent`, `transcript_missing`. Note: no auth change — ride the
existing session-token middleware like every other /api route.

## 5. Frontend

- `lens.js` gains two modes. **Structured mode** (pane agent supported):
  poll `/conversation` every ~2s while the lens is open (and on pane change),
  render turns. **Scrollback mode** (today's behavior) stays the fallback for
  unsupported agents and resolution failures, including the alt-screen hint.
- Render per the existing lens aesthetic: user turns as accent-bold bubbles
  (the bubble pattern already exists — `.lens-turn-user > span` in
  `terminal.css:425`, right-aligned rounded panel; accent-bold color is
  the one rendering addition), assistant text plain, thinking collapsed,
  tool calls as one-line summaries expandable to output.
- The composer stays: submit keeps using `POST /api/panes/{id}/submit`; after
  a successful submit, force one conversation refresh so the user turn
  appears immediately. Optimistic pending bubble lifecycle (bounded, no
  leaks): on submit success, append a pending bubble keyed by the pane
  and the submitted text; remove it when (a) a poll response contains a
  user turn with the same text (match on the message text, not id — the
  id is not known at submit time), (b) the submit failed (show an error
  state instead), or (c) the pane changes or the lens closes (drop
  silently). Cap at ONE pending bubble per pane; a new submit replaces
  the old bubble. Queued messages show once jcode records them.

## 6. Chat toggle gating

The Chat|Terminal segmented control (`insertLensSwitch`) is currently
always-on. Change:

- Server: `pane_json`/`agent_json` gain a real `agent_session` value
  (today hardcoded null). **Wire shape, pinned once:**

  ```json
  agent_session: null
  | { "kind": "jcode",
     "resolvable": true,
     "session_id": "..." }
  | { "kind": "jcode",
     "resolvable": false,
     "reason": "no_session_path" | "ambiguous" }
  ```

  `null` = agent has no transcript provider at all (shell panes,
  unsupported agents). `resolvable` = provider exists but resolution
  succeeded/failed; `reason` drives the lens hint text. One shape, used
  by BOTH the webui frontend and the TUI. Validated: nothing in the
  webui Rust deserializes these JSONs into typed structs
  (`ClientShellAgent` is a separate protocol struct, never fed the
  pane_json stream), and the TUI parses snapshots per-field via
  `value_str`/`value_bool` helpers with no `deny_unknown_fields`, so
  additive fields are safe end to end.
- Frontend (verified against current code): `insertLensSwitch`
  (`src/assets/desktop/app_js/lens.js:289`) is currently always-on —
  it creates the control unconditionally and is called once from
  `bindings.js:700`. Add a NEW `HerdrLens.syncSwitchVisibility()`
  (function does not exist yet; note `lens_behavior.test.mjs:172` pins
  the HerdrLens export list, so the new export must be added there
  too), called from the existing `onPaneChanged` hook (verified: invoked
  from `connectTerminal` on every pane switch,
  `src/assets/desktop/app_js/terminal.js:165-166`) and after each
  snapshot: hide the switch unless `SUPPORTED_CHAT_AGENTS.has(agent)`
  AND `agent_session` is non-null, where the set starts as `{"jcode"}`
  (agent value from the pane row `name/display_agent/agent`, same
  resolution render.js already uses — verified at
  `render.js:838` `a.name || a.display_agent || a.agent ||
  a.terminal_id`). For a supported agent with `resolvable: false`, keep
  the switch visible (the user should see the hint) but the lens shows
  the refusal reason instead of turns. Unsupported pane → switch
  hidden, lens forced off.
- TUI parity: `Shortcut::Lens` (`src/tui/keys.rs`) gains the same guard;
  `TuiPane` (`src/tui/model.rs`) needs one new optional field parsed
  defensively (`value.get("agent_session")`), defaulted off when absent
  so old backends keep working. The TUI reads the same shape: kind via
  `agent_session.kind`, resolvable via `agent_session.resolvable`,
  reason via `agent_session.reason`.

## 7. Safety and scope

- Read-only on jcode's store: the server never writes `~/.jcode`.
- No dependency on jcode internals beyond the journal file format; jcode
  format changes show up as parse misses, not crashes (torn tail lines
  skipped, unknown parts ignored — reference behavior).
- No herdr wire-protocol change (protocol 22 frozen).
- Out of scope here: other agents (Claude/Codex stores), mobile-specific
  rendering, image blocks.

## 8. Executable validation evidence (2026-10-04)

Prototype (`~/.jcode/scratch/jcode_design_check.py`, design steps 2+3
implemented verbatim) run against the real live store:

- Parser: 8/8 journals parsed without error, including the compact-only
  and empty-message edge cases; the live session journal produced 11
  turns (5 user / 6 assistant) with 1 in-flight tool pending, matching
  the conversation observed in the pane.
- Resolution end to end: the ONE live jcode client process on this
  machine (pid 81170, cwd = this repo) resolved through the design's
  step ordering to `session_vole_*.journal.jsonl` — the correct, unique
  session (this very conversation). This exercises the real acceptance
  path: live process → cwd → journal → parsed turns.
- Constraint (honest limit): this machine had only one live jcode client,
  so the ambiguity rejection (two same-cwd live journals) could not be
  exercised against real data; it stays covered by synthetic tests in the
  implementation. Likewise no resume-chain journal existed to observe.

**Finding 1 (same round) — resolution ambiguity is REAL and fixed:**

- Extending the evidence index from journals to ~2500 snapshots exposed
  that cwd matching alone is massively ambiguous: 21 sessions share this
  repo's cwd. The live-pid filter narrows to 3 — and all 3 share the SAME
  pid 21155 (the shared daemon writes its own pid into every session it
  hosts). The original step 2 would have returned `no_session_path`.
- Disambiguation evidence found in the snapshots' `status` field: exactly
  one of the three was `Active`; the others were `Closed` and `Crashed`
  (a struct with a disconnect message). Design section 2 now filters on
  status == Active and adds an evidenced pane-text tiebreak as step 3.
- The corrected model was then re-run: semantic check PASSES (all original
  prompts recovered from snapshot + journal, 241 messages → 15 turns),
  all ~2500 sessions parse under the corrected model without error, and the
  status-filtered resolution picks the correct unique live session.

**Finding 2 (same round) — journal rotation invalidated the read model:**

- Re-running the semantic check against the same journal FAILED: the
  earlier user turns had vanished from the journal (127 lines → 6). The
  journal had crossed jcode's 512 KiB `MAX_SESSION_JOURNAL_BYTES` and
  `checkpoint_snapshot()` deleted it, moving full history into the
  `.json` snapshot (159 messages, all four original prompts present;
  0 id overlap with the fresh journal). This is exactly the rotation the
  current design would have hit in production chat use.
- Root cause confirmed in jcode source
  (`crates/jcode-base/src/session/persistence.rs`,
  `crates/jcode-base/src/session.rs:270`), not just inferred.
- Design corrected in section 1 and section 3: read model is snapshot
  base + journal delta replay, with generation checks on both files.
- The rotation also proves the resolution step must re-scan on every
  poll: after rotation the journal is new and tiny, and the snapshot
  carries the pid/cwd evidence too (snapshot has `last_pid`/`working_dir`
  top-level fields, same as journal meta).

## 9. Adversarial checks (round 3, live store + jcode source)

Third-round adversarial checks (all against live store + jcode source):

- **Torn snapshot reads: not possible by construction.** `write_json_fast`
  writes a tmp file then atomically renames (`jcode-storage/src/lib.rs`),
  and the old inode survives as `.bak` via hard link, so a reader always
  sees the old or new snapshot, never a partial one. Empirically
  hammered the live session snapshot for 10s (13,297 reads during active
  saving): 0 torn reads. Parser may parse snapshots directly with no
  retry loop.
- **Status divergence: cannot happen.** `metadata_requires_snapshot`
  (`session/journal.rs`) forces a full snapshot save whenever `status`
  changes, so snapshot and journal status always agree at rest (verified
  on the live session and on `dromedary`, a rotated session with both:
  Active/Active).
- **Non-message journal entries exist and must be skipped.** One live
  entry carried only `append_env_snapshots`/`append_replay_events`/
  `append_memory_injections` with no `append_messages`; the prototype
  skips it and produces zero empty turns.
- **`.bak`/tmp glob safety: clean.** 2385 `.bak` files and zero leftover
  `*.tmp.*` files; the index globs `*.json` and `*.journal.jsonl` only,
  which structurally cannot match `.bak`. Correction from re-check:
  every `.bak` on disk is a snapshot bak named `session_X.bak` (2,385
  observed, zero `session_X.journal.bak`), so the earlier claim about
  journal bak names was wrong — conclusion (glob safety) unchanged.
- **Compact-only sessions carry full resolution evidence** (working_dir +
  last_pid in their single journal line), so compaction never blocks
  resolution.

## 10. Validation plan

- Rust unit tests: parser fixtures (real shapes captured from the live
  journal, incl. tool fold, compaction, compact-only, torn tail,
  empty-message), resolution tests (unique PID, ambiguous cwd, dead
  pid, status filtering incl. object-shaped `Crashed`), route tests
  (error codes). Paging is v1-deferred: when added, tests cover
  message-id cursors and 409 on generation change.
- Frontend vm suite: lens structured mode, toggle gating on
  `agent_session` shape (null hides, resolvable false shows hint),
  fallback to scrollback on `no_session_path`, pending-bubble lifecycle
  (removed on matching poll text / pane change / lens close). Update
  `lens_behavior.test.mjs` export-list pin when adding
  `syncSwitchVisibility` to the HerdrLens surface.
- e2e: drive a real jcode pane in a builtin session, assert the chat shows
  turns within one poll and the switch is hidden on a shell pane.