# Swarm architecture and performance review

Date: 2026-10-13. Branch `improvements`. Method: five read-only analyst
agents (rust-arch, js-desktop, js-mobile, tui-parity, perf) plus
coordinator spot checks; every item below was cross-verified against
direct code reads. No edits were made during the analysis phase.

## Verdict

The backend is in good shape where it was already refactored
(`git_ui/`, `file_browser.rs`, `builtin_detection/`, `tui/panels/`):
routes + socket_dispatch share one validation path, git parsing is
server-owned, and the TUI consumes the same HTTP API as the browsers.
Two god-modules remain (`main.rs` 6,565 ln, `builtin_backend.rs`
10,012 ln of which ~4,600 are inline tests), and the web clients still
carry logic that the backend either already owns (duplicate parsers)
or should own (rail probing, per-workspace filtering, derived maps).

## Move browser logic to Rust (ranked)

| # | Item | Now | Rust target | Risk |
|---|---|---|---|---|
| M1 | Blame parsing | desktop/git_ui/diff_render.js:32 | `/api/git-ui/blame` return `authors` map (Rust mirror exists at tui/panels/git/parse.rs:22) | low |
| M2 | Log-row legacy parser | desktop/git_ui/log.js:88-135,295 | delete JS fallback, `/api/git-ui/log` rows are authoritative | low |
| M3 | Rail git status probing | desktop/git_ui.js:1384 | fold per-workspace status into `/api/session-snapshot` | medium |
| M4 | Snapshot per-workspace filtering + derived maps | mobile/app.js:986, desktop core.js finishRefresh | backend returns filtered tabs/panes + workspacesById | low |
| M5 | Recent-workspaces isOpen + worktree enrichment | mobile/worktrees.js:45-75,157-223; desktop worktrees.js:171-241 | `/api/recent-workspaces` and `/api/worktrees` return enriched rows | low |
| M6 | Hunk patch rebuild | desktop/git_ui.js:1341 | `/api/git-ui/apply-patch` accepts file+chunk index, rebuilds patch server-side | medium |
| M7 | Side-by-side diff pairing | desktop/git_ui/diff_render.js:101-135; mobile/git.js:317 | `/api/git-ui/diff` pre-paired rows option | medium |
| M8 | Diff search match counts | desktop/git_ui/diff_search.js | `q=` param on `/api/git-ui/diff` for counts; highlight stays client-side | low |
| M9 | Prompt-card parser | desktop/app_js/prompt_cards.js:64 vs tui/prompt_cards.rs:117 | expose `/api/panes/{id}/prompt` from server tail | medium |
| M10 | Lens prompt-line segmentation | desktop/app_js/lens.js:80 vs tui/lens.rs:143 | extend chat_lens.rs, expose lines endpoint | medium |
| M11 | Markdown outline for web | TUI-only (tui/panels/files/mod.rs:628) | `/api/file-browser/outline` (new web feature, parity win) | low |
| M12 | File kind/size formatting | shared/file_tree.js:204, shared/file_icons.js | tree entries gain `kind`; formatting single-source | low |

Deliberately kept client-side: search palette scoring, find-in-file in
the editor (latency-local), DOM rendering, icon glyph mapping.

## Performance wins (ranked, perf agent)

| # | Issue | Where | Effort |
|---|---|---|---|
| P1 | No Cache-Control/ETag on 70+ embedded assets (re-download MBs per reload) | assets.rs:508 | S |
| P2 | Agent detection recomputed per poll (64KB tail copy + ps per pane) instead of serving cached `last_agent_state` | builtin_backend.rs:3025 | M |
| P3 | git status = 5-6 sequential spawns, ls-remote can block | git_ui/mod.rs:847 | M |
| P4 | PTY output cloned per subscriber per chunk | builtin_backend.rs:2343 | S |
| P5 | ContentMatcher per-line allocation (audit item, confirmed at file_browser.rs:464) | file_browser.rs | S |
| P6 | Scrollback: byte-at-a-time trim, full-copy attach, tail re-decode | builtin_backend.rs:2319-2347 | M |
| P7 | /api/sessions spawns `herdr --version` every call | main.rs:209,2499 | S |
| P8 | Snapshot enrichment: N serial worktree IPCs + double clone | main.rs:3425 | S |
| P9 | Events WS unbounded channel per client | main.rs:5572 | S |
| P10 | App boot loads 25+ scripts sequentially | app_boot.js:49 | S |

## Structure (rust-arch agent)

- Split `main.rs` into `web/` tree: cli, config, session, auth,
  settings, sessions_api, workspaces, worktrees, terminal ws. Router
  composes per-domain routers.
- Split `builtin_backend.rs`: state, dispatch, terminal runtime, osc,
  env, process, status (table-driven `AgentSpec` replacing ~26
  `detect_*_status` fns), git helpers; move ~4,600 inline test lines to
  `tests/`.
- Dedup `connect_local_stream` x3 and `builtin_socket_paths` x2 into
  one helper each.
- ApiClient/BackendClient unification already landed; remaining gap
  is the event-subscribe prologue in ApiClient.

## Frontend dedup (js-mobile agent)

- `escapeHtml` x4, `pathBasename` x5, session-backend localStorage
  helpers (~50 ln) duplicated mobile/desktop, editorOptions identical
  copies, search field-extraction helpers prefix-cloned.
- CSS: spinner keyframes x7 across files, 2 inconsistent
  prefers-reduced-motion blocks, ~8 dead selector groups in
  mobile/app.css, monolithic 2,129-line mobile CSS.
- Mobile terminal lacks desktop reconnect backoff (reattach storm
  risk); fetch-in-render in git screen; render-time mutation breaks
  worktrees innerHTML memo.

## TUI parity (tui-parity agent)

- TUI structure is sound; hotspots are tui/mod.rs (3,838) and
  render/mod.rs (2,396, screen split never done).
- Both TUI and web duplicate: prompt-card parse, lens segmentation,
  find-in-file semantics, file-tree status parse. Typed response
  structs (open docs item) remain the largest structural win: handlers
  build `json!` literals, all three clients re-parse untyped.
- Docs drift: technical-details.md and tui-backend-api.md still
  describe the pre-split flat tui file layout.