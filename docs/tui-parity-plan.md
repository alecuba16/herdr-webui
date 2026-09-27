# TUI parity with the desktop WebUI

Status: implemented (phases 0-5 complete on branch `tui-parity`). This
document originally inventoried the desktop feature set, audited the TUI,
and laid out a modular implementation so each TUI subfeature lives in its
own module inside `src/tui/`. It is kept as the record of what was built;
the user-facing summary lives in `docs/features.md` (Terminal UI section).

Implementation notes beyond the plan text:

- Phase 4 reveal: the tree endpoint compacts single-child dirs at the top
  level, so `reveal_path` skips absent ancestors when their children are
  already visible instead of failing.
- Phase 4 new directory: no mkdir endpoint exists, so `A` writes a
  `.gitkeep` marker inside the new dir (documented deviation).
- Phase 4 replace: `Ctrl+H` opens the shared prompt; trailing `!`
  replaces all matches (the webui bar has separate one/all buttons).
- Phase 5 settings: prefix `s` (webui `settings: KeyS`) opens a read-only
  overlay with a theme cycle; the old TUI-only prefix-`s` stash binding
  moved aside, stash stays on `4` (webui `stash: Digit4`).

## Current state audit

The TUI already covers a meaningful share of the desktop feature set:

- Prefix state machine (`Ctrl+B`) mirroring the WebUI prefix overlay
  (`src/tui_keys.rs`), with Git view shortcuts mapped to the webui
  `DEFAULT_GIT_SHORTCUTS` keys.
- Terminal screen: workspace/agent navigation, attach, live output, input,
  paste, resize, detach (`src/tui.rs`, `src/tui_terminal.rs`).
- Files screen: lazy tree expansion, filter, preview, edit with save/reload
  guards, rename/delete (`src/tui_panels.rs` FileExplorer).
- Git screen: Changes/Log/Branches/Stash/History tabs with per-file diff, blame
  toggle, file history, commit/amend modal, stage/unstage/discard/stash,
  fetch/pull/push, branch switch/delete, stash apply/drop (`src/tui_panels.rs`
  GitPanel).
- HTTP API client for file browser and git routes (`src/tui_web_api.rs`).

### Confirmed TUI gaps vs desktop

Desktop shortcuts and features not present in the TUI today (verified against
`src/assets/desktop/app_js/core.js` `DEFAULT_WEBUI_SHORTCUTS`,
`src/assets/desktop/git_ui/shortcuts.js`, `docs/features.md`):

Panel/workspace management:

1. No `nextPanel`/`prevPanel` ([/] panel navigation) shortcut.
2. No `newWorkspace` (prefix `N`) or `openWorktrees` (prefix `W`) or
   `createWorktree` (prefix `T`) dialogs.
3. No `closeWorkspace` (prefix `Shift+X`), `removeWorktree`
   (prefix `Delete`/`Backspace`).
4. No workspace rename, no panel rename.
5. No search palette (prefix `/`).
6. No settings screen; no shortcut help overlay parity for the new keys.
7. No "close last panel closes workspace" guard parity (webui closes workspace
   via `workspace.close` when the last tab is closed).

   Closed: `Ctrl+B x` on the last tab of a workspace now sends
   `tab.close` followed by `workspace.close` (the built-in backend
   auto-drops emptied workspaces; the explicit close covers external
   backends, and a not-found answer is ignored).
8. No webui `sidebar` (KeyB), `focusNext`/`focusPrev` (`.`/`,`), or
   temporary terminal overlay shortcuts `tempTerminalToggle`/
   `tempTerminalPromote` (Shift+M/Shift+P).

   Closed in the gap-8 pass: prefix `Shift+B` collapses/expands the
   sidebar column (plain `b` stays git branches), prefix `.`/`,` walk
   the focus regions (sidebar workspaces -> agents -> main, wrapping),
   prefix `Shift+M` opens or re-focuses the temporary terminal (a tab
   labeled `temp` in a workspace labeled `temp`, the same labels the
   backend and webui use so `tab.promote` works), and prefix `Shift+P`
   promotes it into a workspace at the shell's live cwd via the built-in
   `tab.promote`. The TUI approximates the webui overlay with the temp
   tab; the old TUI-only prefix `P` push moved aside (the git screen
   keeps the in-screen `P`).

Git management gaps:

8. No Conflicts view (`/api/git-ui/conflicts`, `/api/git-ui/conflict-resolve`,
   `/api/git-ui/conflict-action`): `Use HEAD` / `Use parent` / `Use remote` /
   `Mark resolved` per file, and rebase continue/skip/abort.
9. No Cleanup view (`/api/git-ui/cleanup-scan`, `/api/git-ui/branch-delete`,
   `/api/git-ui/worktree-remove`, `/api/git-ui/worktree-prune`): multi-select
   repo scan with dry-run and confirm.
10. No stash diff preview (`/api/git-ui/stash-show`): stash split view with
    file tree and full stash diff.
11. No log actions: compare (single/two-commit), reset, rebase, tag, worktree
    from branch, load-more pagination, scope filters (all/branch/master+branch).

    Closed in the follow-up pass: single-commit compare (`Enter`, commit vs
    parent), `t` tag, `R` reset, `b` rebase, `w` worktree from branch, `+`
    load more, `s` scope cycle shipped in the git-log-actions pass; the
    remaining webui shift-click two-commit compare is now covered too:
    `Space` in the Log view marks commits for comparison (kept list capped
    at the last 2, webui `slice(-2)` semantics) and `c` with exactly two
    marked commits runs the pair compare (`git_compare`, newest = target,
    oldest = base, diff title `base..target`). With fewer than two marked,
    `c` keeps the commit-modal meaning, so the webui compare-button
    shortcut stays unclaimed.
12. No diff search (webui `Ctrl+F` in diff) and no side-by-side toggle.
13. No git directory picker / cwd change (webui `prefix I` opens the Git
    directory or branch dialog; yellow badge for foreign cwd).
14. No `apply-patch` / hunk editing (apply-patch exists as a route).

   Closed in the gap-14 pass: `J`/`K` walk the `@@` hunks of the
   Changes diff (wrapping, selected header highlighted) and `H` applies
   the webui hunk action through `/api/git-ui/apply-patch` — stage the
   hunk (`cached: true`) when the shown diff is working-tree scope,
   unstage it (`reverse + cached`) when staged, exactly one action per
   scope like the webui buttons. In-hunk content editing (webui hunk
   editor with hash-guard saves) stays a documented non-goal; the
   Files preview editor covers editing.
15. No branch creation prompt (`git_switch` with `create: true` already
    supported by the client).

File explorer gaps vs neovim-style:

16. No file content search integration (`/api/file-browser/content-search`,
    content-search/file): grep-style results grouped per file with jump-to-line.
17. No new-file/create-directory action.
18. No git status colors in tree entries (file browser route already returns
    status; needs parse + render).
19. No split-preview / multi-tab preview; single preview pane only.
20. No mark/selected file follow (neovim "reveal current file in tree").
21. No editor find/replace within preview (webui find bar with match-case and
    regex).
22. No markdown preview flip; TUI shows raw text (acceptable for TUI, may
    render markdown header outline instead).

    Closed in the gap-22 pass: the raw-source choice stays (a rendered
    markdown view is a browser concern), but `M` on the Files screen now
    toggles a markdown header outline of the open `.md`/`.markdown` preview
    (ATX headings `#`..`######`, fenced code blocks skipped, line numbers
    shown, `M` again returns to the source), the TUI counterpart of the
    webui eye toggle between rendered preview and source.

Terminal parity (documented as out of scope in `docs/features.md` line 100):
layout mutation, copy/search scrollback, mouse/touch, worktree dialogs
(superseded by this plan), configurable keymaps, notification integrations.
The first five are terminal-rendering-level concerns and stay out of scope for
keyboard parity work; configurable keymaps are noted as future work.

## Target module layout

Move the flat `src/tui*.rs` files into a `src/tui/` folder, one module per
subfeature, keeping `tui.rs` as the root `mod.rs` (screens dispatch, shared
app state) and `tui_panels.rs` split by feature:

```
src/tui/
  mod.rs              ← current tui.rs: TuiApp, screens, dispatch, prompts
  keys.rs             ← current tui_keys.rs + new shortcuts
  model.rs            ← current tui_model.rs
  render/             ← current tui_render.rs split by screen
    mod.rs
    sidebar.rs
    terminal.rs
    files.rs
    git/…
  theme.rs            ← current tui_theme.rs
  terminal/           ← tui_terminal.rs + tui_input.rs + tui_terminal_tests.rs
    mod.rs
    input.rs
    output.rs
  web_api.rs          ← current tui_web_api.rs + new endpoints
  panels/             ← current tui_panels.rs split by feature
    mod.rs
    files/explorer.rs        FileExplorer (tree, filter, preview, edit)
    files/editor.rs          find/replace in preview, dirty guards
    files/content_search.rs  /api/file-browser/content-search integration
    git/changes.rs           status list + diff + blame + hunk actions
    git/log.rs               log list + commit actions + compare/reset/tag
    git/branches.rs          branch list/switch/create/delete
    git/stash.rs             stash list + stash-show diff
    git/conflicts.rs         conflicts list + resolve actions
    git/cleanup.rs           cleanup scan + multi-select + confirm
    git/cwd.rs               git directory picker (prompt) + cwd badge state
  workspace/          ← NEW panel/workspace management
    mod.rs             create/rename/close workspace, panel nav, tab guards
    worktrees.rs      worktree list/create dialog, remove, promote
  search.rs           ← NEW search palette (workspaces, panels, agents, files,
                        folders, content) reusing files/content_search.rs
  settings.rs         ← NEW minimal settings view (read-only at first:
                        api base, theme mode, refresh interval)
  tests/              ← tui_tests.rs, tui_terminal_tests.rs moved here
```

Rules for the split (mechanical, no behavior change):

- Keep all public paths importable as `crate::tui::...` so `src/bin/herdr-webui-tui.rs`
  and the e2e test module in `src/main.rs` keep compiling with a sed-level
  path fix (`herdr_webui::tui` stays the entry, `herdr_webui::tui_panels`
  re-export shim if needed to avoid breaking main.rs tests).
- `TuiApp` stays the single owner of `snapshot`, `file_explorer`, `git_panel`;
  subfeature modules get `&mut` accessors or free functions taking
  `&mut TuiApp`, never new parallel state structs.
- Each phase lands as its own commit with `cargo test` green and the
  e2e module in `src/main.rs` (`tui_parity_e2e_tests`) extended.
- Update `docs/features.md` "Terminal UI" section per phase and the
  `help_rows()` overlay in `keys.rs`.

## Implementation phases

### Phase 0 — modular restructure (no feature work)

1. `git mv` the tui files into the layout above; fix `use` paths; add re-export
   shims (`crate::tui_panels` → `crate::tui::panels` etc. or plain path fix).
2. Keep module visibility `pub` only at `crate::tui` boundary.
3. `cargo test`, `cargo clippy`, e2e smoke via `scripts/e2e/acceptance.mjs`
   (terminal core) and a manual `herdr-webui-tui --summary` run.
4. Commit: "tui: split flat modules into src/tui/ per-feature folders".

### Phase 1 — panel/workspace management shortcuts (gap 1-4, 7)

New shortcuts in `keys.rs` + dispatch in `tui/mod.rs`, backed by
`backend_client` methods that already exist:

| Desktop default | TUI key | Action |
| --- | --- | --- |
| prefix `]` / `[` | next/prev panel | select next/prev tab in selected workspace |
| prefix `N` | new workspace | prompt for path → `client.create_workspace(path)` → focus it |
| prefix `W` | worktrees | worktree list modal for selected workspace/repo |
| prefix `T` | create worktree | prompt base branch + path → `client.create_worktree*` |
| prefix `X` | close panel | existing close-tab logic |
| prefix `Shift+X` | close workspace | confirm prompt → `workspace.close` |
| prefix `Delete`/`Backspace` | remove worktree | confirm → `worktree.remove` (blocked on built-in → surface error) |
| prefix `r` | rename panel | prompt → `tab.rename` |
| prefix `Shift+R` | rename workspace | prompt → `workspace.rename` |

Also: closing the last tab in a workspace calls `workspace.close` (webui
parity guard); failed removes surface backend errors in the status line.

New module `src/tui/workspace/mod.rs` holds the prompt flows and
`worktrees.rs` the worktree dialog state machine (list → select → action).

### Phase 2 — search palette (gap 5)

New module `src/tui/search.rs`:

- prefix `/` opens palette: single-line query, up/down selection, Enter opens
  target, Esc closes.
- Sections mirror the desktop palette: workspaces (`ws`), panels (`pn`),
  agents (`ag`) local over snapshot; files/folders via
  `/api/file-browser/tree?q=`; content via the content-search module from
  Phase 4.
- Selection targets a concrete pane/workspace (desktop rule: navigation always
  targets a concrete panel when one is available).
- Reuses `FileExplorer` preview open for file hits.

### Phase 3 — git management parity (gaps 8-15)

Extend `panels/git/` modules; add client methods in `web_api.rs` for the
missing routes: `conflicts`, `conflict_resolve`, `conflict_action`,
`cleanup_scan`, `cleanup delete` (branch-delete/worktree-remove/prune),
`stash_show`, `log` (with limit/scope/path args), `reset`, `rebase`, `tag`,
`apply_patch`, `git_file` read/write (hunk edit), `switch` with create.

- Conflicts view (new `GitView::Conflicts`): file list with per-file `o`
  (ours/HEAD), `p` (parent), `r` (remote), `m` (mark resolved); rebase
  continue/skip/abort actions when state is rebase.
- Cleanup view (new `GitView::Cleanup`): scan root prompt (default from
  exploration dir), repo → branches/worktrees nested list, space toggles
  selection, `x` opens confirm modal, runs deletes through the API.
- Stash view upgrade: split layout, stash list on the left, selected stash
  diff on the right via `stash-show` (file tree optional; full diff first).
- Log view actions: `c` compare with parent (read-only diff), `t` tag prompt,
  `R` reset prompt (soft/mixed/hard confirm), `b` rebase prompt, `w`
  worktree-from-branch prompt, `Load more` via `+` key, scope cycling with
  `s`, file-scoped log from file browser "show history".
- Diff search: `/` inside Changes opens incremental search over diff lines
  with `n`/`N` next/prev and highlight; side-by-side stays out of scope for
  the TUI (line-based rendering), documented as such.
- Git cwd picker: prefix `I` opens path prompt; when git cwd != workspace cwd
  show badge line in the git header (yellow).
- Branch creation: in Branches view `c` prompts for a new branch name →
  `git_switch(create: true)`.

### Phase 4 — neovim-style file explorer (gaps 16-21)

Extend `panels/files/`:

- Content search: `/` opens the query prompt; results grouped per file with
  matched lines; Enter jumps to file and line (preview opens at line with a
  highlight); `+`/`-` load more groups/lines; match-case toggle `A`, regex `X`.
- New file: `a` prompts name → write empty file via `file_write` (hash guard
  flow) → open in preview; `A` prompts directory name.
- Git status colors in tree entries: parse the existing tree payload status
  fields; red deleted, yellow modified, green added, propagate to parents
  (webui parity priority red > yellow > green). Theme-aware.
- Reveal current file: prefix `F`… reserved. Use `w` in files screen to
  reveal the git-panel selected file in the tree, expanding ancestors.
- Editor find/replace: in edit mode `Ctrl+F` opens find bar (incremental,
  match-case `A`, regex `X`), Enter next, `Shift+Enter` prev, in edit mode
  `Ctrl+R` conflicts with reload → find-replace bar uses `Ctrl+H` for replace
  one/all (prompt flow), matching webui editor behavior where possible.
- Markdown files: keep raw source (TUI-appropriate); optional future: outline
  view.

  Shipped: `M` toggles the header outline of the open markdown preview
  (level-indented markers, line numbers) and back to the source.
- Split panes/multi-tab preview: out of scope for this pass (terminal cell
  budget); preview switching via `Tab` within Files screen to cycle recently
  opened files (cheap approximation, documented).

### Phase 5 — help overlay, settings screen, docs, tests

- `help_rows()` regenerated to cover all new keys per screen.
- Settings screen: prefix `S` shows API base, theme mode, refresh interval,
  exploration default dir; read-only display plus theme toggle for now.
- Update `docs/features.md` Terminal UI section: replace the "Remaining TUI
  gaps" line with the new covered list and what stays out (layout mutation,
  copy/search scrollback, mouse, notifications, configurable keymaps,
  side-by-side diffs, split panes).
- Extend `tui_parity_e2e_tests` in `src/main.rs` covering: workspace
  create/rename/close via prompts, panel nav, worktree list dialog, search
  palette open/select, conflicts resolve flow, stash-show diff, log load-more,
  content search jump-to-line, git status colors parse, new file flow.
- Manual smoke: `make build` then `herdr-webui-tui` against a live session,
  walk every shortcut in the help overlay.

## Order and dependency rationale

- Phase 0 first: the user asked for modular structure; all later phases build
  inside it.
- Phase 1 before 2-4: workspace/panel management is the shell every other
  screen hangs from, and it is pure `backend_client` work with no new API.
- Phase 3 before 4: git gaps are bigger and the web API client extensions
  (content-search style pagination) are shared with Phase 4.
- Phase 2 (search palette) reuses Phase 4's content search, so it lands after
  or together with Phase 4; skeleton can land in Phase 1 window.

## Non-goals (documented desktop gaps that stay TUI-out-of-scope)

Known key-map deviations from `DEFAULT_WEBUI_SHORTCUTS` /
`DEFAULT_GIT_SHORTCUTS` (all others match or moved aside with the change
noted in code):

- `focusTerminal: KeyF` — webui-only DOM focus (xterm surface); the TUI
  terminal always owns the keyboard, so no parity key exists. Prefix `f`
  keeps the TUI-era Files screen (the webui has no files shortcut).
- `stageAll: KeyG` — plain `g` was already the TUI git-screen shortcut
  from before the parity work, so stage-all lives on `Shift+G`.
- `sidebar: KeyB` — plain `b` stays git branches; sidebar collapse is
  `Shift+B`.
- `settings: KeyS`, `stash: Digit4` — the old TUI-only prefix-`s` stash
  moved aside; stash keeps `4`.
- `help: Shift+Slash` (webui) maps to prefix `?`/`0` in the TUI.
- `nextWorkspace: KeyJ`/`prevWorkspace: KeyK` match the prefix table; the
  git screen reuses `J`/`K` for the hunk cursor (in-screen, no prefix).

Out-of-scope features:

- Side-by-side diff rendering, split editor panes (cell-width budget).
- Mouse support, copy/search over terminal scrollback, layout mutation,
  notification integrations, configurable keymap recording.
- Markdown rendered preview, Mermaid.
- External Herdr-only flows (the TUI targets the built-in backend path).