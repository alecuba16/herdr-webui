# Code quality audit

## 2026-07-19 deep review update

Scope: full `herdr-webui` repository after `v0.2.68` local release work.

### Functionality map

- Rust HTTP/WebSocket shell: `src/main.rs` owns route wiring, auth/session settings, terminal proxy, app endpoints, static assets, and most integration tests.
- Built-in backend: `src/builtin_backend.rs` owns embedded session/workspace/tab/pane/agent state and protocol handling. `src/builtin_events.rs` publishes live events.
- Backend client/protocol: `src/backend_client.rs`, `src/protocol.rs`, `src/compat.rs` own external/built-in backend compatibility and typed request helpers.
- Git domain: Rust `src/git_ui/*.rs` owns branch, cleanup, conflict, diff, file, log, stash APIs. Desktop JS `src/assets/desktop/git_ui*.js` owns Git drawer UX.
- File domain: Rust `src/file_browser.rs` owns tree/file/search APIs. Shared JS `file_tree`, `file_content_search`, `editor`, `workspace_search` provide reusable UI helpers. Desktop/mobile wrappers adapt layout.
- Desktop shell: `src/assets/desktop/app_js/*` owns state, rendering, terminal, panel switcher, worktrees, shortcuts, bindings, and command/search UI.
- Mobile shell: `src/assets/mobile/*` owns mobile layout, terminal, file browser, settings, worktrees, attention notifications, and selector rail.
- CSS: shared tokens/helpers are in `shared/*.css`; desktop CSS is split by chrome/controls/workspaces/terminal/modals plus file/Git/search bundles; mobile remains one large layout bundle.
- Tests: JS asset tests cover boot/load/mobile/terminal/shared helpers. Rust tests cover HTTP routes, assets, backend behavior, TUI, terminal parsing.

### Remediated in this pass

- Removed dead desktop tab-strip helpers left after panels moved into the workspace card: `renderTabButton`, `tabHoverInfo`, `renameCurrentPanel`, unused worktree lookup helpers, and a shell-minimize alias.
- Fixed the `Show panel last update` setting so it is functional again in the active panel button and panel switcher menu, with test coverage.
- Removed an obsolete clipboard context menu DOM/CSS/handlers after copy/paste moved to keyboard-driven terminal actions.
- Removed an unused file-browser helper and verified no exact dead top-level production JS functions remain with the source scanner.

### Remaining risks and refactor targets

- Large mixed-responsibility modules still exist: `src/main.rs` ~5.9k lines, `src/builtin_backend.rs` ~4.1k, desktop `core.js` and `git_ui.js` ~3.2k each. Split by route/domain/state/render boundaries before adding more features.
- Desktop/mobile duplication remains real in file-browser search, terminal frame handling, route parsing, API helpers, worktree naming, and shared CSS rules. Move more pure helpers to `shared/*` only where behavior is identical.
- CSS has many intentional duplicated utility bodies and some duplicated file-tree/editor/content-search rules between desktop and mobile. Prefer shared CSS for exact common rules, with mobile/desktop files only overriding spacing/radius/layout.
- Asset bundling in `src/assets.rs` is explicit and safe, but it is verbose. A generated manifest would reduce missing-route risk if asset count keeps growing.
- Codebase-memory MCP indexing timed out during this review after two attempts, so source/static scans and prior audit data were used for graph-like coverage. Restore graph availability before the next architecture-sized refactor.

### Validation

Passing after remediation:

- `cargo fmt --check`
- `node --test src/assets/*.test.mjs`
- `cargo test --quiet`
- `cargo clippy --quiet --all-targets -- -D warnings`
- `git diff --check`

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
