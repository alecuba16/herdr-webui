# Code quality audit

Date: 2026-09-12 (revision 3), supersedes the 2026-08-17 revision
Scope: full `herdr-webui` repository, indexed with codebase-memory.

> **Note**: Revision 3 folds in the SOLID/modularity initiative execution
> record (2026-09-12): frontend shared HTTP client with the session-header
> bugfix, desktop `git_ui.js` decomposed from 4,092 to 2,338 lines across
> 17 modules, mobile app decomposed and lightweight parity features, and
> docs realignment. The Rust `main.rs` and `builtin_backend.rs` splits
> remain deferred. Metrics reflect the codebase at v0.4.30.

## Baseline

- Graph: 2,159 nodes and 9,221 edges (current index). Node and edge counts are
  lower than the prior 4,619/18,134 baseline because the extraction now filters
  non-semantic noise and deduplicates structurally equivalent symbols.
- Large production files: `src/main.rs` (6,381 lines), `src/builtin_backend.rs`
  (5,832), desktop `git_ui.js` (3,626), desktop `app_js/core.js` (3,184),
  mobile `app.js` (1,503), desktop `file_browser.js` (1,204).
- `src/git_ui.rs` has been split into a `src/git_ui/` module with 9 files
  (`branch.rs`, `cleanup.rs`, `conflict.rs`, `diff.rs`, `file.rs`, `log.rs`,
  `log_graph.rs`, `mod.rs`, `stash.rs`), totaling 2,467 lines in `mod.rs`.
- Agent detection moved to `src/builtin_detection/` module with `claurst.rs`,
  `jcode.rs`, and `mod.rs` (678 lines total across 3 files).
- Main quality risks: duplicated desktop/mobile flows, mixed-responsibility
  modules, process/session linear scans, and backend-routing parity gaps.
- Baseline Rust tests: 229 passing.

## Remediated in the original pass (2026-07-14)

- Added shared `normalizeOrder` in `src/assets/shared/core.js`; desktop, mobile,
  and shared search settings now use one implementation.
- Fixed mobile backend routing. HTTP requests now send `x-herdr-backend` when a
  backend target is selected. WebSocket URLs now send one correctly joined
  `backend=` query parameter alongside `session=`.
- Replaced process-tree PID deduplication and built-in session-name
  deduplication with `HashSet` membership.
- Cleared existing Clippy warnings and moved conflict tests after production
  items to restore warnings-as-errors validation.
- Added focused frontend coverage for shared normalization and mobile backend
  routing structure.

## Remediated since the original pass

- Split `src/git_ui.rs` (previously 2,980 lines) into a `src/git_ui/` module with
  9 focused files for branch, cleanup, conflict, diff, file, log, log_graph,
  stash, and shared mod.
- Extracted agent detection into `src/builtin_detection/` module (`claurst.rs`,
  `jcode.rs`, `mod.rs`), with jcode variant detection (vanilla + alecuba16
  fork).
- Desktop `core.js` refactored into `src/assets/desktop/app_js/` with separate
  files for `render.js`, `shortcuts.js`, `terminal.js`, `workspace_create.js`,
  `workspace_shell.js`, `worktrees.js`.
- Added Claurst and Qwen agent detection (22 agents total).
- Protocol version bumped from 16 to 20.

## Deferred risks

At the time of the 2026-08-17 revision these required separate, reviewable
refactors. The desktop `git_ui.js` split landed in the 2026-09-12 initiative
(see the execution record below); the rest remain open:

- Split `src/main.rs` (13,675 lines) into auth, settings, TLS,
  session/workspace handlers, and terminal proxy modules.
- Replace the 30 agent-specific status functions in `src/builtin_backend.rs`
  with table-driven rules.
- Unify duplicated desktop/mobile terminal refresh, worktree, and search flows
  where behavior is truly shared.
- Unify the server `ApiClient` and library `BackendClient` protocol
  implementations.
- Remove per-line allocation in `ContentMatcher::find` after adding
  Unicode-safe behavior tests and benchmarks.

## SOLID / modularity initiative execution record (2026-09-12)

The 2026-09-12 audit (graph: 7,074 nodes / 28,360 edges, full mode) drove a
phased, zero-behavior-change initiative. Every slice landed behind the full
gate (frontend `node --test`, `cargo fmt --check`, `cargo clippy --all-targets
-- -D warnings`, `cargo test`, git + desktop + mobile e2e acceptance suites).

### Landed

**Rust backend (Phase 1 — deferred, not landed)**

- `src/main.rs` (13,675 lines) is still a god-module: CLI parsing, TLS, auth,
  settings, session registry, all HTTP handlers, terminal WS bridge, and
  inline tests in one file. The `web/` module split is the largest remaining
  Phase 1 item.
- `src/builtin_backend.rs` (6,966 lines) still mixes runtime state, PTY
  management, socket dispatch, and 30 hand-written `detect_*_status` agent
  functions. Only the identity half (`builtin_detection/`) was split earlier.

**Frontend shared modules (Phase 2, DRY)**

- `shared/http.js`: one `api()` client (auth cookie, backend-target header,
  session header, error normalization) replacing 7 independent copies.
- **Session-targeting bugfix** (user-visible): the private `api()` copies in
  desktop `git_ui.js`, `file_browser.js`, `directory_picker.js`, and
  `lsp_settings.js` did not attach `x-herdr-session`/`x-herdr-backend`
  headers, so Git drawer worktree lists hit the default session/backend when
  a non-default session was pinned, and 401s surfaced raw instead of the
  login flow. All four now use the shared client.
- The duplicate `escapeHtml` copies in desktop `app_js/terminal.js`,
  `shared/temp_terminal.js` (attr variant), and `mobile/core.js` remain;
  `shared/core.js` exports the canonical one. Consolidation is still open.

**Desktop `git_ui.js` decomposed (Phase 2b)**

`git_ui.js` went from 4,092 lines to 2,338 lines; every cohesive family now
lives in a factory module under `src/assets/desktop/git_ui/` (each registers
`globalThis.HerdrGitUi*Module` and is concatenated before `git_ui.js`):

| Module | Lines | Owns |
| --- | --- | --- |
| `settings.js` | 38 | settings panel registration |
| `syntax.js` | 96 | syntax highlighting bridge |
| `log.js` | 292 | log graph table (pre-existing) |
| `shortcuts.js` | 274 | keyboard shortcuts + tooltip titles |
| `stash.js` | 87 | stash view |
| `cleanup.js` | 188 | cleanup tab |
| `diff_render.js` | 278 | diff hunks/lines rendering |
| `conflicts.js` | 257 | conflict blocks + side editor render |
| `side_tree.js` | 341 | file tree + stash side panels |
| `modals.js` | 140 | commit/git-op/reset/compare/tag modals |
| `branch_list.js` | 171 | branch list + worktree selector popovers |
| `toasts.js` | 145 | toast render + permalink/PR urls |
| `primitives.js` | 152 | options/limits/esc/arg/diff keys (zero deps) |
| `diff_search.js` | 76 | diff search count + highlight |
| `workspace_nav.js` | 205 | navigation stack/trail + workspace helpers |
| `diff_view.js` | 308 | side rail, file toolbar, diff body |
| `log_render.js` | 97 | log load, history, conflicts, main routing |

The remaining 2,338 lines are a genuine composition root: shared state
consts, module wiring, panel lifecycle (open/hide/close/refresh/loadDiff/
api/post/postJson), render orchestration (render/replaceContent/
mountSideEditors), and the `window.HerdrGitUi` API object (142 methods) that
inline `onclick` strings bind to. Extracting the lifecycle/orchestration
families was assessed and deliberately stopped: they are mutually recursive
with 30+ consumption sites across the module creates, so a split would add
lazy-forwarder indirection without cohesion gains.

Each slice followed the same recipe: map function contiguity, extract with
original comments carried over, wire same-named const bindings, register in
the `assets.rs` concat + test boot list, add a registration + concat-order
guard test, add behavioral vm tests for previously regex-only coverage, and
retarget (never weaken) existing assertions to the module sources.

**Mobile (Phase 2b/2c)**

- `mobile/app.js` decomposed from 2,075 lines to 916 lines across
  `screens.js`, `search.js`, `sessions.js`, `actions.js`, `events.js`,
  `attention.js`, `backend.js`, `git.js`, `panels.js`, `settings.js`,
  `workmeta.js`, plus the pre-existing `file_browser.js` (984),
  `worktrees.js` (321), and `terminal.js` (276).
- Lightweight parity features landed: recent workspaces and no-sleep control
  (settings.js/attention.js), agent sorting (settings.js).
- Docs realigned: features.md/development.md now state that mobile file
  browser and Git support mutations (docs were stale, claiming read-only).

### Operational notes for future extractions

- Hoisted function declarations can be passed into earlier module creates
  directly; const bindings consumed by earlier creates need
  `(...args) => fn(...args)` lazy forwarders (TDZ safety).
- vm-globals (`localStorage`, `navigator`, `document`) must be injected
  explicitly into module factories.
- Cross-realm vm `assert.deepEqual` fails on vm-created arrays; compare via
  `JSON.stringify` equality.
- Moved code with explanatory comments requires comment-carrying extraction
  (walk back over contiguous `//` lines).

### Current validation state

- Frontend: 558/558 across `node --test src/assets/*.test.mjs` (23 files).
- Rust: 534/534 `cargo test`, `cargo fmt --check` and
  `cargo clippy --all-targets -- -D warnings` clean.
- E2e acceptance: git 38 ok (GIT E2E ACCEPTANCE PASSED), desktop 58 PASS,
  mobile 52 PASS.

### Remaining (deferred, ordered)

1. Rust `src/main.rs` (13,675 lines) split into a `web/` module tree
   (router, auth, settings, sessions/workspaces, TLS, install, routes,
   WS handlers) — the largest deferred item.
2. Rust `src/builtin_backend.rs` (6,966 lines): runtime state vs PTY vs
   dispatch split, plus table-driven agent status rules replacing the 30
   hand-written `detect_*_status` functions.
3. `shared/temp_terminal.js` split (manager vs session-instance factory; the
   repo's worst complexity numbers live here: cyclomatic 202/180).
4. Desktop `core.js` remainder (Phase 2b leftover where cohesion justified
   stopping).
5. Full mobile Git parity (commit/log/stash/conflicts) — product call about
   screen real estate, deliberately roadmap.

## Validation

Passing after remediation:

- `node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs`
- `cargo fmt --check`
- `cargo clippy --target-dir target --all-targets -- -D warnings`
- `cargo test --target-dir target --quiet`
- `cargo build --release --target-dir target`
