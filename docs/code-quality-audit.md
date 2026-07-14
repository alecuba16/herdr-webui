# Code quality audit

Date: 2026-07-14
Scope: full `herdr-webui` repository, indexed with codebase-memory.

## Baseline

- Graph: 4,619 nodes and 18,134 edges before remediation.
- Large production files: `src/main.rs` (5,911 lines), `src/builtin_backend.rs` (3,981), desktop `core.js` (3,037), desktop `git_ui.js` (2,980).
- Main quality risks: duplicated desktop/mobile flows, mixed-responsibility modules, process/session linear scans, and backend-routing parity gaps.
- Baseline Rust tests: 191 passing.

## Remediated in this pass

- Added shared `normalizeOrder` in `src/assets/shared/core.js`; desktop, mobile, and shared search settings now use one implementation.
- Fixed mobile backend routing. HTTP requests now send `x-herdr-backend` when a backend target is selected. WebSocket URLs now send one correctly joined `backend=` query parameter alongside `session=`.
- Replaced process-tree PID deduplication and built-in session-name deduplication with `HashSet` membership.
- Cleared existing Clippy warnings and moved conflict tests after production items to restore warnings-as-errors validation.
- Added focused frontend coverage for shared normalization and mobile backend routing structure.

## Deferred risks

These require separate, reviewable refactors because they have larger blast radius:

- Split `src/main.rs` into auth, settings, TLS, session/workspace handlers, and terminal proxy modules.
- Replace the 22 agent-specific status functions in `src/builtin_backend.rs` with table-driven rules.
- Split desktop `core.js`, desktop `git_ui.js`, and mobile file-browser responsibilities into smaller feature modules.
- Unify duplicated desktop/mobile terminal refresh, worktree, and search flows where behavior is truly shared.
- Unify the server `ApiClient` and library `BackendClient` protocol implementations.
- Remove per-line allocation in `ContentMatcher::find` after adding Unicode-safe behavior tests and benchmarks.

## Validation

Passing after remediation:

- `node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs`
- `cargo fmt --check`
- `cargo clippy --target-dir target --all-targets -- -D warnings`
- `cargo test --target-dir target --quiet`
- `cargo build --release --target-dir target`
