# Codebase structure refactoring plan

Analysis session 2026-11-22. Seven parallel read-only analysts covered the Rust
backend server, Rust feature services, Rust TUI, desktop JS, mobile+shared JS,
CSS+HTML, and the protocol/API/test surface. Every finding below carries
file:line evidence in the source reports archived under
`~/.jcode/scratch/herdr-webui-refactor/` (worker-*.md). Scope approved by the
owner: all tiers (dedupe, file splits, cross-layout extractions).

## Architecture constraints any refactor must respect

- No ES modules: the frontend ships as Rust `concat!` bundles (`src/assets.rs:48-64`
  CSS, `:72-122` JS) served at fixed URLs and loaded sequentially by
  `app_boot.js`. Lazy feature CSS/JS loads via `HerdrLoadCss`/`HerdrLoadScript`
  (`desktop/app_js/render.js:640-698`).
- Moving/renaming files under `src/assets` is a 3-way coordinated change:
  `main.rs` asset routes (`:1521-1721`), `assets.rs` concat lists, and every
  `*.test.mjs` that reads sources by relative URL (`app_boot.test.mjs:12-50`).
- Desktop and mobile layouts never co-load (760px media query or stored
  preference, full reload on flip, `app_boot.js:135`). CSS source order is
  load-order dependent (documented race `modals.css:20-25`).
- `protocol.rs` mirrors the herdr 0.9.0-0.9.5 wire, version 22, consumed by both
  TUI and webui. Framing and message enums are a frozen contract.
- Route surface: ~55 API routes + ~90 asset routes + 3 WS endpoints, assembled in
  `main.rs:1430` with 5 merged sub-routers (file_browser, git_ui, lsp, notes,
  workspace_panes). CI gates: fmt, clippy `-D warnings`, cargo test,
  `node --test`, build.
- `docs/ux/desktop-shell-refactor-plan.md` is the signed-off UX architecture;
  code restructuring must not contradict it.

## Duplication map (weight-ordered)

```text
RUST BACKEND                RUST FEATURES               RUST TUI
main.rs 7616, 158 routes     builtin_backend.rs 13394    tui/mod.rs 9317
 session-routing x6 ~70L      (8200 = tests, ~5150 prod)   key-handler god fns
 home_dir dup service.rs      8 responsibilities          (git 477L, commit 440L)
 require_auth x47 ~200L       detection dispatch x23       PromptKind mirror enum
 error responses ~150-250L    porcelain parser x3          render/mod.rs 3797
 TLS args mac/systemd ~55L   git wrapper pairs x35        list render x10 ~350L
                              ~300L                       modal prologue x7 ~150L

DESKTOP JS 36,846            MOBILE+SHARED               CSS ~14,400
core.js 5259 (10 jobs)       lens near-clone ~900L        33 palette vars x2
workspace_panes.js 6413      composer/prompt_cards ~400L  3 modal systems
 (dragdrop ~950L)            terminal plumbing ~300L      6 spin + 3 pulse
api() wrapper x9 ~130L       backend state ~120L           keyframes
escapeHtml x5, el() diverge  settings flash/rollback ~150L .herdr-tree-row reimpl
                             events WS client ~80L        ~140 raw status hex
```

## Plan phases

### Phase 1: Rust dedupe (low risk, pure extraction)

1. Shared route helpers: auth guard + JSON error response for the 5
   sub-routers (`notes.rs:71-81`, `workspace_panes_store.rs:954-965` twins)
   and the `api_error` helper for main.rs handlers.
2. Session-routing resolver: collapse the 6 near-twins
   (`main.rs:1838-2003`) behind one resolver returning `(backend, session)`.
3. `home_dir()` dedupe (`main.rs:589` = `service.rs:445`) plus the
   settings-dir fallback triplication (`main.rs:1164/1180`,
   `backend_client.rs:580-598`) into a paths helper.
4. Protocol version single-source: drop `BUILTIN_TUI_PROTOCOL_VERSION`
   (`backend_client.rs:382`) in favor of `protocol::PROTOCOL_VERSION`.
5. TLS arg builders (`service.rs:781-860`): one per-mode descriptor.
6. git_ui route glue: generic wrapper for the ~35 blocking fn + async wrapper
   pairs (`log.rs:324/384` etc.).
7. builtin_detection registry: replace 21 per-agent imports
   (`builtin_backend.rs:15-45`) + 23-arm match (`:5010-5045`) with a
   registry table.
8. Porcelain-status + git-repo-root unification: one shared consumer for the
   three copies (`git_ui/mod.rs:557+1072`, `file_browser.rs:1637-1805`,
   `builtin_backend.rs:5092`).

### Phase 2: Rust god-file splits (test suite pins behavior)

9. `main.rs` -> `routes/` submodules by domain (auth, settings, workspace,
   worktree, panes, ws bridges); `app_router` stays the registration point.
10. `builtin_backend.rs` -> `builtin_backend/` folder: protocol, state,
    terminal, serialize, journal, detection dispatch, worktree; the 8200-line
    test module moves with its targets.
11. `tui/mod.rs` -> `app.rs` + `events/` + `refresh.rs` + `settings.rs` +
    `scrollback.rs`; `render/mod.rs` gains `render_list_panel` (~350L),
    `centered_window`, `render_modal`; text utils move to `tui/text.rs` to
    break the panels->render inversion.
12. Test splits: `src/tests.rs` (15644L) and `src/tui/tests/mod.rs` (17085L)
    by banner sections, shared fixtures to a common module first.

### Phase 3: Frontend shared-core extraction (desktop+mobile parity)

Sequenced low-risk-first per the mobile analysis:

13. Quick wins: purge stray `escapeHtml`/`escapeAttr`/`wsUrl` copies
    (`terminal.js:1636`, `notes.js:124`, `lens.js:72`, wsUrl x3); shared
    events WS client (`mobile/events.js` vs `core.js` FAST_REFRESH_EVENTS).
14. `api()` consolidation: delete the 8 fallback copies, one fallback in
    `shared/http.js`.
15. Mobile settings onto shared `HerdrSettingsConfirm`/`HerdrSettingsFeedback`
    (delete private flash/rollback ~150L).
16. Shared `backend_state.js` (backendEnabled, syncSessionBackendFromServer,
    ~120L).
17. Shared `prompt_cards.js` parser (composer/prompt_cards ~400L).
18. Shared tour driver with layout hooks (~200L).
19. Terminal socket layer (`wsUrl`, chunked sendInputData, paste takeover,
    resize-vs-reattach) on top of terminal_adapter (~300L).
20. Lens conversation model last, after test-coverage check (~900L): fetch/
    poll/partHtml/decisionHtml/DOM-sync pipeline into `shared/lens_model.js`
    with thin layout shells.
21. Desktop bundle splits: `core.js` -> state/settings/shortcuts-config/
    routing/session-manager/attention; `workspace_panes.js` dragdrop
    subsystem (~950L) first, then tree-model/sync/rail/render/lifecycle.

### Phase 4: CSS structure

22. `shared/palette.css`: the 33 duplicated palette vars, fix the `--danger`
    drift (`mobile/app.css:92` overrides tokens' dark value).
23. Keyframes onto `herdr-spin`/`herdr-pulse` in primitives (6 spin + 3
    pulse copies die).
24. `mobile/app.css` split into concat modules mirroring the desktop pattern
    (only `assets.rs:147` + `app_boot.js:58` change); mobile tree-row block
    drops in favor of `shared/file_tree.css` + a small mobile override file.
25. Raw status hex -> `--status-*` tokens across mobile/terminal/file_browser/
    login CSS (~140 sites, visual diff required).
26. git-ui modal unified onto shared modal classes (z-index 1100 semantics
    documented in `bindings.js:1023` must hold).

### Explicit non-goals

- `protocol.rs` framing + message enums: frozen wire mirror, leave alone.
- `backend_client.rs` request core: shared with the TUI wire, minimal churn.
- chat_lens/jcode_transcript/prompt_cards Rust layering: already correct.
- `tui/split.rs` vs `split_mode.rs`: clean data/logic separation.
- `tui/web_api.rs` (70 thin wrappers): acceptable as-is.
- builtin_detection per-agent modules stay functions; registry only.
- assets.rs serving layer: embedded bytes, split serves little.

## Sequencing and verification

Rounds run as parallel swarm lanes with disjoint file sets, coordinator merges
and verifies after each round:

- Round 1: Rust phases 1+2 items (1-8) in one cargo workspace; JS quick wins
  (13-14) + CSS palette/keyframes (22-23) in a second lane.
- Round 2: git_ui glue + detection registry (6-7) + test splits (12).
- Round 3: main.rs routes split (9), builtin_backend folder (10), tui/mod
  split (11).
- Round 4: frontend extractions 15-20.
- Round 5: desktop bundle splits (21) + CSS monolith split (24-26).

Verification per round: `cargo fmt --check`, `cargo clippy --all-targets --
-D warnings`, `cargo test --target-dir target`, `node --test
src/assets/*.test.mjs src/assets/desktop/git_ui/*.test.mjs`, `make build`.
Any behavior divergence (e.g. the three porcelain parsers differ in edge
cases) is reconciled deliberately inside the round that unifies them, with
the test suite as the referee.

## Open items deferred by design

- `JcodeDetectionVariant` removal (documented temporary in
  `builtin_detection/mod.rs:14-20`): separate ticket.
- `PromptKind` fallback (`tui/mod.rs:58`) needs a product decision before
  the enum unification; split keeps behavior identical.
- mobile/core.js fallback copies: keep until load order is guaranteed, then
  revisit.
- scripts/e2e CI smoke subset: proposal only, out of refactor scope.