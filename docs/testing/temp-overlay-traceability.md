# Temporary Files/Git overlays: requirement-to-check traceability

Scope: commit 87ddc98 (overlays feature) + host-behavior test suites.
Every product requirement maps to at least one executable check and an
observed pass result. "Runtime" checks drove the real debug binary; "unit"
checks drive the real public interfaces inside node:test / cargo test.

## Requirements

| # | Requirement | Check | Result |
|---|-------------|-------|--------|
| R1 | Desktop: opening a temp Files overlay uses a pseudo workspace `__temp_files__` and never calls any workspace/session API | `desktop_temp_overlays.test.mjs` `openFiles opens the drawer behind the temp pseudo workspace without any workspace API call` asserts `apiCalls.length === 0` and serialized workspace `{__temp_files__, "temp files", folder}` | pass |
| R2 | Desktop: temp Git uses its own pseudo workspace `__temp_git__` and hides the other drawer first | `openGit uses its own pseudo workspace and hides the other drawer` | pass |
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
| R19 | Shared controller: 25 behavior tests cover open/retarget/minimize/restore/close, picker promise flow, restore bar, hint errors, double-resolution guards | `temp_overlay.test.mjs` (25 tests) | pass |
| R20 | TUI: Shift+F/Shift+G open a folder/repo prompt without creating a workspace/session | `temp_files_shortcut_opens_folder_prompt_without_workspace`, `temp_git_shortcut_opens_repo_prompt_without_workspace` | pass |
| R21 | TUI: prompt validates folder/repo and retargets the existing screen | `temp_files_prompt_validates_folder_and_retargets_explorer`, `temp_git_prompt_retargets_panel_without_workspace` | pass |
| R22 | TUI: in-screen plain G stages all (no shortcut conflict) | `git_screen_stage_all_moves_to_plain_g` | pass |
| R23 | TUI: help rows list both temporary overlays | `help_rows_list_temporary_overlays` | pass |
| R24 | Server: tree API serves directories-only responses for the picker | Runtime: `GET /api/file-browser/tree?...&dirs_only=true` on the built binary returned directory-only entries | pass |
| R25 | Server: new assets served with correct content | Runtime: `/assets/shared/temp-overlay.js`, `/assets/mobile/temp-overlays.js` → 200, refs present in `/assets/app-boot.js` and desktop bundle | pass |
| R26 | Status only lands on successful open (`open_files_screen_at`/`open_git_screen_at` return Result) | Covered by R21 prompt-validation tests asserting no status change on failure paths | pass |

## Verification runs

- `cargo test --lib`: 408/408 pass (includes 6 new TUI tests)
- `node --test src/assets/*.test.mjs`: 799/799 pass (25 controller, 11 desktop host, 12 mobile host, plus existing suites)
- `cargo fmt --check`: clean
- Runtime integration on debug binary (`127.0.0.1:18787 --session verify-temp`): login, asset 200s, dirs_only tree, bundle references all verified
- Code review: Approve, no blocking findings

## Gaps / non-goals

- Desktop picker widget is exercised via stub; its real DOM rendering is covered by existing picker tests in app_load/shared_actions suites
- Browser-level E2E (clicking real DOM) is out of scope; host behavior is pinned by the vm suites above
