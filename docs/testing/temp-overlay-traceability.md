# Temporary Files/Git overlays: requirement-to-check traceability

Scope: commit 87ddc98 (overlays feature) + the follow-up review pass
(coexistence, picker timeout, ephemeral cancel, shell-toggle fixes and
their behavioral tests). Every product requirement maps to at least one
executable check and an observed pass result. "Runtime" checks drove the
real debug binary; "unit" checks drive the real public interfaces inside
node:test / cargo test.

## Requirements

| # | Requirement | Check | Result |
|---|-------------|-------|--------|
| R1 | Desktop: opening a temp Files overlay uses a pseudo workspace `__temp_files__` and never calls any workspace/session API | `desktop_temp_overlays.test.mjs` `openFiles opens the drawer behind the temp pseudo workspace without any workspace API call` asserts `apiCalls.length === 0` and serialized workspace `{__temp_files__, "temp files", folder}` | pass |
| R2 | Desktop: temp Git uses its own pseudo workspace `__temp_git__` and cross-hides the main-shell files drawer (skipped while the files panel is temp-mounted — see R30) | `openGit uses its own pseudo workspace and cross-hides the other drawer only when it is not temp-mounted` | pass |
| R3 | Desktop: close forgets the pseudo workspace, clears suppression | `closeFiles forgets the pseudo workspace and clears suppression` (`forgetWorkspace("__temp_files__")`, flag false after) | pass |
| R4 | Desktop: reopen with a different folder tears down the old surface first | `reopen swaps the folder and forgets the old pseudo workspace first` | pass |
| R5 | Desktop: minimize/restore reuses the open drawer (no second open) | `toggle minimizes a visible overlay and restores it without reopening the drawer` | pass |
| R6 | Desktop: open failure surfaces in the hint and still closes cleanly | `a drawer open failure surfaces in the overlay hint and still tears down cleanly` | pass |
| R7 | Desktop: no folder argument falls back to current workspace path | `openFiles with no folder falls back to the current workspace path` (`/current/ws`) | pass |
| R8 | Desktop: separate modal ids per tool, registered in the DOM | `the modal lives under the temp overlay id prefix`, `the git overlay uses its own modal id` | pass |
| R9 | Mobile: fresh drawer instance per open, `currentWorkspaceCwd` pinned to the overlay folder | `openFiles builds a fresh file-browser instance pinned to the overlay folder`, `openGit builds a fresh git instance pinned to the overlay folder` | pass |
| R10 | Mobile: screen and tree callback namespaces rewritten to `HerdrMobileTempFiles`/`HerdrMobileTempFilesTree`, originals gone from markup, globals bound to the fresh instance | `the rendered markup rewrites the callback namespaces to the temp ones` | pass |
| R11 | Mobile: git markup rewritten to `HerdrMobileTempGit` and bound | `git markup is rewritten to the temp git namespace and bound` | pass |
| R12 | Mobile: closing drops the instance and unbinds all temp namespaces | `closing the overlay drops the instance and unbinds the namespaces` | pass |
| R13 | Mobile: reopen/folder swap creates a second fresh instance (old keeps its folder) | `reopen swaps the folder and creates a second fresh instance` | pass |
| R14 | Mobile: minimize/restore reuses the same instance | `toggle minimizes and restores without a second instance` | pass |
| R15 | Mobile: no-folder open falls back to the app default folder | `openFiles with no folder falls back to the app default folder` | pass |
| R16 | Mobile: folder picker requests directories only (`dirs_only=true`) and a selection retargets the overlay with a fresh instance | `the folder picker loads dirs-only entries and can select one` | pass |
| R17 | Mobile: picker errors render in the picker, overlay folder untouched | `picker errors surface in the picker and the overlay stays usable` | pass |
| R18 | Mobile: minimized overlays get a wired restore pill (controller contract) | `minimized overlays get a restore pill and restore on click` | pass |
| R19 | Shared controller: 35 behavior tests cover open/retarget/minimize/restore/close, picker promise flow, restore bar, hint errors, double-resolution guards, and the document-level Escape trap (R40-R41) | `temp_overlay.test.mjs` (35 tests) | pass |
| R20 | TUI: Shift+F/Shift+G open a folder/repo prompt without creating a workspace/session | `temp_files_shortcut_opens_folder_prompt_without_workspace`, `temp_git_shortcut_opens_repo_prompt_without_workspace` | pass |
| R21 | TUI: prompt validates folder/repo and retargets the existing screen | `temp_files_prompt_validates_folder_and_retargets_explorer`, `temp_git_prompt_retargets_panel_without_workspace` | pass |
| R22 | TUI: in-screen plain G stages all (no shortcut conflict) | `git_screen_stage_all_moves_to_plain_g` | pass |
| R23 | TUI: help rows list both temporary overlays | `help_rows_list_temporary_overlays` | pass |
| R24 | Server: tree API serves directories-only responses for the picker | Runtime: `GET /api/file-browser/tree?...&dirs_only=true` on the built binary returned directory-only entries | pass |
| R25 | Server: new assets served with correct content | Runtime: `/assets/shared/temp-overlay.js`, `/assets/mobile/temp-overlays.js` → 200, refs present in `/assets/app-boot.js` and desktop bundle | pass |
| R26 | Status only lands on successful open (`open_files_screen_at`/`open_git_screen_at` return Result) | `temp_overlay_open_failure_keeps_status_line_clean` asserts an API failure sets `error` and never the `temporary files:` status | pass |
| R27 | Desktop: a slow directory-picker session never drops a late Select click (poll timeout stops polling but does not resolve) | `the poll timeout gives up without discarding a late selection` drives 605 rAF ticks, asserts the pick stays pending, then a late select still resolves | pass |
| R28 | Desktop: picker closed without a select resolves empty and keeps the current folder | `closing the picker without a select keeps the current folder` | pass |
| R29 | Desktop: a second pick supersedes the pending one (first resolves `""`) | `a second pick supersedes the first pending one` | pass |
| R30 | Desktop: both temp overlays coexist: opening one never strips the other's panel (host skips cross-hide; drawers' `hide()` early-returns while temp-mounted) | `opening the git overlay never strips the files overlay panel`, `closing one overlay leaves the sibling overlay intact`, `panelInTempOverlay reports ancestry truthfully`, app_core `hide respects the temporary Files overlay...`, git_ui_behavior `hide keeps the git panel visible...` | pass |
| R31 | Desktop: the overlay Change-folder button drives the picker and retargets the surface | `the Change folder button retargets the surface through the picker` | pass |
| R32 | Desktop: main-UI shell toggles close a minimized temp overlay first so the drawer re-homes into the main shell; visible overlays and absent hosts are untouched | app_load `closing a minimized temporary overlay before the main shell opens the drawer`, `leaves an unminimized temporary overlay alone...`, `still opens the main drawers when HerdrTempOverlays is absent` | pass |
| R33 | TUI: Esc on the temp prompt leaves the app on the previous screen (ephemeral cancel) and a failed open rolls the screen switch back | `temp_files_shortcut_opens_folder_prompt_without_workspace` / `temp_git_shortcut_opens_repo_prompt_without_workspace` assert Terminal before and after Esc; `temp_overlay_open_failure_keeps_status_line_clean` also asserts `screen == Terminal` and the rolled-back explorer cwd | pass |
| R34 | Mobile: `toggleGit` minimizes/restores; both overlays coexist with independent folders/instances; `pickerUp` climbs one level; `pickerFilter` narrows rows; `closeFiles`/`closeGit` parity exports | `toggleGit opens, minimizes, and restores...`, `both overlays open at once...`, `pickerUp climbs one level...`, `pickerFilter narrows the rendered rows` | pass |
| R35 | Desktop picker exports the node-based `open(input)` entry the temp overlay host calls (shipped broken in 87ddc98: host called a missing export, Change-folder was dead in the browser) | picker suite `directory picker exposes the node-based open(input) entry the temp overlays use` | pass (fixed) |
| R36 | End to end against served bundles + real backend: both overlays open at once on different folders, Change-folder drives the real picker module into a subfolder, picker close keeps the folder, closing one overlay leaves the sibling mounted, zero workspace/session API calls | `scripts/e2e/temp-overlays-acceptance.mjs` via `scripts/e2e/run-temp-overlays-e2e.sh` (isolated config, fixture folders, loopback login) | pass |
| R37 | E2e suppression + lifecycle: while a surface is mounted the drawers' syncTerminalVisibility leaves the main shell style untouched; minimize/restore keeps the panel mounted in the overlay body with the folder intact (restore bar button wired); close detaches the panel (ephemeral cleanup) and reopen works; picker filter narrows through the real backend (`q=` search) and a filtered close keeps the folder | acceptance run sections 5-7 + 9 | pass |
| R38 | E2e non-repo: the git overlay opens on a folder without a git repo, stays open (git_ui.open resolves, status API hit with that cwd), panel stays mounted, closes cleanly | acceptance run section 8 | pass |
| R39 | Cross-module sweep: every member the hosts/drawers/render.js call on `HerdrTempOverlay`, `HerdrDirectoryPicker`, `HerdrFileBrowser`, `HerdrGitUi`, `HerdrTempOverlays`, `HerdrMobile*` resolves against a real export (audit after the picker `open` miss) | grep audit documented in the acceptance run's bundle-slice setup; no further missing exports found | pass |
| R40 | Escape closes a visible overlay through a document-capture trap with terminal-parity guards: already-consumed keys, editable targets, foreign modals, and minimized overlays are ignored | `temp_overlay.test.mjs` `Escape closes an open overlay through the document trap`, `Escape does nothing when no overlay is open`, `Escape is ignored when the key was already consumed (drawer paths win)`, `Escape is ignored while the overlay is minimized`, `Escape is ignored while an editable field has focus`, `Escape yields to a foreign modal stacked above the overlay` | pass |
| R41 | The visually topmost overlay owns Escape: DOM order (equal z-index) decides, raiseModal re-raises on open and restore, and registration order never matters | `Escape closes the DOM-topmost overlay when both are open`, `restore re-raises the modal above the other overlay and Esc closes it`, `closeTopmost closes the visible overlay and reports false with none` | pass |
| R42 | Terminal↔overlay Escape arbitration: a terminal stacked above a visible overlay yields the key, and a minimized or lower overlay does not steal it | `temp_terminal.test.mjs` `yields Escape when a temporary overlay is stacked above the terminal`, `keeps Escape when the overlay is minimized or stacked below` | pass |
| R43 | Desktop git_ui shortcut contract while temp-mounted: Esc closes the topmost overlay through the shared trap unless a foreign modal is open (never the dead in-panel confirm), the whole keyboard is released while the git overlay is minimized, per-tool `isToolMinimized` so files-minimized never releases git keys, and the legacy hide-confirm outside overlays is untouched | `git_ui/shortcuts.test.mjs` (6 tests) + `desktop_temp_overlays.test.mjs` `isToolMinimized reports per tool...` | pass |
| R44 | E2e Escape parity against the served bundles with real window→document capture order: Esc closes the DOM-topmost git overlay then files, a minimized overlay is never captured and a bare Esc with nothing visible is a no-op, the restored pill re-raises and owns Esc, and the open desktop picker wins the key | acceptance run section 10 (17 assertions) | pass |

## Verification runs

- `cargo test --lib`: 409/409 pass (includes the TUI temp tests with rollback and positive-path screen assertions)
- `node --test src/assets/*.test.mjs`: 818/818 pass (25 controller, 20 desktop host, 16 mobile host, 7 picker, plus app_load/app_core/git_ui_behavior guard and shell-toggle tests) plus `src/assets/desktop/git_ui/shortcuts.test.mjs` (6 Esc-contract tests)
- `cargo fmt --check`: clean
- Runtime integration on debug binary (`127.0.0.1:18787 --session verify-temp`): login, asset 200s, dirs_only tree, bundle references all verified; served bundles byte-checked against the sources for the coexistence guard, timeout fix, F6 fix, and mobile close exports
- E2E acceptance: `scripts/e2e/run-temp-overlays-e2e.sh` PASS (boots the real served bundle set in a vm, proxies fetch to the live backend with the login cookie; found and pinned the R35 picker export fix; sections 1-11 cover coexistence, picker navigate/select/filter/close, suppression, minimize/restore, ephemeral cleanup + reopen, non-repo git overlay, Escape parity, and zero workspace/session calls)
- Code review: Approve, no blocking findings

## Gaps / non-goals

- Browser-level E2E (clicking real DOM in a real browser engine) is still out of scope; the acceptance run drives the served bundles' real modules over a parentage-correct DOM stub, which caught the one integration bug the unit stubs masked
- The acceptance suite stubs the handful of app-core helpers the host closes over (`selectedOrDefaultWorkspace`, `shortcutLabel`, ...) instead of booting the whole desktop app bundle, matching the git-acceptance.mjs pattern
