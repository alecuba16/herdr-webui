# Code quality audit

Date: 2026-08-17
Scope: full `herdr-webui` repository, indexed with codebase-memory.

> **Note**: This is an updated revision of the original audit (2026-07-14). The
> graph was re-indexed and metrics reflect the current codebase at v0.2.91.

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

These require separate, reviewable refactors because they have larger blast
radius:

- Split `src/main.rs` (6,381 lines) into auth, settings, TLS, session/workspace
  handlers, and terminal proxy modules.
- Replace the 22 agent-specific status functions in `src/builtin_backend.rs`
  (5,832 lines) with table-driven rules.
- Split desktop `git_ui.js` (3,626 lines) and mobile file-browser
  responsibilities into smaller feature modules.
- Unify duplicated desktop/mobile terminal refresh, worktree, and search flows
  where behavior is truly shared.
- Unify the server `ApiClient` and library `BackendClient` protocol
  implementations.
- Remove per-line allocation in `ContentMatcher::find` after adding
  Unicode-safe behavior tests and benchmarks.

## Validation

Passing after remediation:

- `node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs`
- `cargo fmt --check`
- `cargo clippy --target-dir target --all-targets -- -D warnings`
- `cargo test --target-dir target --quiet`
- `cargo build --release --target-dir target`
