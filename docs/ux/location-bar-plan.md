# Location bar: workspace-scoped folder, worktree, and branch switching

Plan for the desktop WebUI refactor that puts a location bar above the
workspace panes. It shows the selected workspace/worktree path, and for git
repositories also the worktree and branch, all switchable in place. It
consolidates three existing surfaces (the Git drawer's worktree/branch
chips, the Git drawer's folder picker button, and the Git branch modal) into
one place. Analysis session 2026-10-30.

Desktop first. Mobile follows in a separate phase once desktop ships and
stabilizes.

## Signed-off decisions (2026-10-30)

1. **One bar, above the panes.** The bar lives in the `main` region above
   `#workspacePanes`, scoped to the selected workspace. Three shapes:
   - Git repo on a plain checkout (master or any single checkout): path
     chip, branch chip. Branch chip opens the branch popover.
   - Git repo in a worktree: path chip, worktree chip, branch chip. Both
     chips open their popovers (change worktree, change branch).
   - Plain folder: path chip only. Click opens the directory picker.
2. **Single branch UI.** The bar's branch popover (filter, local/remote
   sections, load-more, delete-on-hover, create) replaces the Git branch
   modal that the `b` shortcut opens today. The `b` shortcut re-targets the
   bar's popover.
3. **Bar owns its render.** Independent desktop shell module with its own
   signature-based render sync called from `render()`. The Git drawer's
   render pipeline stays untouched.
4. **Folder change semantics.** Picking a folder from the bar: if another
   open workspace already lives in that folder, switch to it. Otherwise
   open or create one, following `openWorkspaceHere()` logic (worktree rows
   go through `/api/worktrees/open`, plain folders through workspace create
   plus recents record).
5. **Creation options live in the git case only.** Both the worktree and
   branch selectors expose creation: new branch stays in the same
   workspace; new worktree switches to it (working dir, git file explorer,
   and panes follow the new worktree), while panels open in the old
   workspace stay open in the old workspace.
6. **File explorer UP clamps.** The file explorer's UP navigation always
   stops at the folder assigned to the workspace. The
   `fileBrowserAllowParent` option (setting row, options field, shared
   helper, desktop and mobile readers) is removed entirely.
7. **Explorer follows the bar.** When the bar switches the workspace folder
   (worktree or plain folder change), the file explorer reloads its tree
   rooted at the new cwd. Branch-only changes do not reload the explorer.
8. **Picker is the existing interactive one.** The bar's folder selector is
   `HerdrDirectoryPicker` (tree, search, git status colors on entries,
   Home and Select actions), not a text input. It already colors entries by
   git status when expanding into git paths; verification only.

Non-goals: mobile UI (separate phase), backend protocol changes (the
existing endpoints cover all bar actions), touch layout of the bar.

## Current surfaces (what moves, what dies)

| Surface today | Fate |
|---|---|
| `git-ui-subtitle` chips (`branch_list.js` `renderGitLocationSelector`, rendered by `diff_view.js` in `renderSide`) | Removed from the drawer. Chip and popover logic is copied as-is into the bar module. |
| `git-ui-path-title` (`diff_view.js` `renderDiffLayoutSideToggle`) plus `openCwdPicker()` in `git_ui.js` | Removed. The bar's path chip owns folder switching. |
| Git branch modal (`openBranchModal`, `loadBranchModalCwd`, `applyBranchModalCwd`, `closeBranchModal`, `gitUiBranchCwd` markup in `git_ui/modals.js`) | Removed (decision 2). `b` opens the bar's branch popover instead. |
| `returnToWorkspaceCwd` (the return action shown when the Git view cwd differs from the workspace folder) | Removed. Divergence sources (drawer folder picker, branch modal cwd input, drawer worktree pick) all die with the bar owning these flows. |
| Branch popover handlers (`openBranchList`, `branchListFilter`, `loadMoreBranches`, `switchFromBranchList`, `deleteFromBranchList`) | Copied to the bar with a namespace swap, then removed from `git_ui.js`. |
| Worktree popover handlers (`openWorktreeList`, `selectWorktree`, `createWorktreeFromSelector`) | Copied to the bar (select routes through the folder-change flow), then removed from `git_ui.js`. |
| Directory picker as folder selector | Reused as-is for the bar's path chip. |
| `openWorkspaceHere()` (`file_browser.js:1334`) | Extracted to a shell-level helper. The bar and the file browser context menu both call it. |
| `createWorktreeFromSelectedBranch` (log view context menu) | Stays. Different surface, same create modal. |
| Branch create via `/api/git-ui/switch` with `create: true, base` | Reused as-is for the bar's new-branch action. |

## Architecture

New module `src/assets/desktop/app_js/location_bar.js`, an independent
desktop shell module in the family of `right_sidebar.js` and
`workspace_panes.js`:

- Own state: workspace id, cwd, branch, worktree name, is-git flag, and
  the open popover (branch, worktree, or none).
- Own render: `HerdrLocationBar.sync()` called from `render()` in
  `render.js`, with a signature check (workspace id, cwd, branch, popover
  state) so polls do not repaint the bar. Popover state changes call
  `sync()` themselves.
- Mount: static container in `app.html` inside `main`, above
  `#workspacePanes`: `<div class="location-bar" id="locationBar" hidden>`.
  The bar hides when no workspace is selected or `workspacePath()` is
  empty.
- Data source: the bar never fetches a full git status. It reads the
  cached status the rail prober already warms every poll
  (`probeWorkspaceStatus` in `git_ui.js`, backed by
  `/api/git-ui/rail-status`, answers `{cwd, branch, state,
  not_git_repository}`). If git_ui is not loaded or the branch is unknown,
  the bar renders the path chip plus a disabled branch chip. git_ui stays
  lazy-loadable.
- Actions:
  - Path chip opens `HerdrDirectoryPicker.openInput` on a hidden input
    with an after-select callback running the folder-change flow.
  - Worktree chip opens the worktree popover (copied from
    `renderWorktreeList`): rows plus a create-worktree action. Selecting a
    row routes through the folder-change flow.
  - Branch chip opens the branch popover (copied from `renderBranchList`):
    filter, local and remote sections, load-more, delete-on-hover, plus
    new-branch and new-worktree actions. Switch posts
    `/api/git-ui/switch` with `{cwd, branch}`. New branch posts
    `/api/git-ui/switch` with `{cwd, branch, create: true, base}` and stays
    in the same workspace. New worktree opens
    `openWorktreeCreateFromGitBranch(cwd, branch)`.
- Popover dismissal: document-level click listener with a containment
  check, same pattern as the drawer's `eventInsideBranchList`.
- CSS: the popover contents keep the `git-ui-` class names so all existing
  popover CSS in `git_ui/layout.css` is reused with zero new rules. The
  git-ui stylesheet is loaded by the bar module itself (or the bar's
  container rules go into an always-loaded app css file) so the bar renders
  correctly even when git_ui was never opened. The bar container gets a
  thin `.location-bar` rule next to `.workspace-panes` in `panes.css`.

Why its own module: the bar needs branch and worktree data but must render
on shell polls with the drawer closed, and git_ui must stay lazy. Own state
plus own sync keeps shell polls cheap and keeps the bar auditable in
isolation.

## Folder-change flow (extracted `openWorkspaceHere`)

```
bar picks folder F (directory picker, worktree popover row)
  1. if an open workspace has workspacePath == F: go(that workspace)   [focus existing]
  2. else if /api/worktrees?cwd=F lists a row with path == F:
       POST /api/worktrees/open {path} -> navigateToOpenedWorkspace
  3. else POST /api/workspaces {label, cwd} -> record recent -> navigateToOpenedWorkspace
  4. after navigation: file explorer, if open, reloads its tree rooted at the new cwd
```

Notes:

- `/api/worktrees/open` already focuses an open workspace for a checkout
  instead of duplicating it. Step 1 covers plain folders where no worktree
  row exists but another open workspace sits on the folder.
- The helper lives at shell level (its own `app_js/open_folder_flow.js` or
  inside `core.js`; pick at implementation, concat order after `core.js`).
  `file_browser.js` `openWorkspaceHere` calls the shared helper instead of
  holding its own copy.
- The explorer-follow step uses the existing open/activateState semantics
  (`HerdrFileBrowser.open(workspace, {forceOpen: true})` when the files
  shell mode is active for the new workspace).
- Worktree create from the bar uses the existing create modal
  (`openWorktreeCreateFromGitBranch`), whose submit navigates with
  `go(workspaceId, tabId, paneId)`. Panels in the old workspace stay open:
  navigation switches focus, it does not close anything.

## Phases

Phases 1-5 are desktop only. Phase 6 (mobile) is a separate effort.

### Phase 1: Bar skeleton and data wiring

- `app.html`: add the `#locationBar` container inside `main`, above
  `#workspacePanes`.
- New module `app_js/location_bar.js`: `sync()` with signature skip, three
  chip shapes (git checkout, git worktree, plain folder), hidden without a
  selected workspace or path.
- Wire `render()` in `render.js` to call `HerdrLocationBar.sync()` next to
  `syncFileWorkspaceToggle()`, and the workspace switch path (`go()` in
  `core.js`) to repaint immediately.
- `assets.rs`: add the module to the `DESKTOP_JS` concat after
  `workspace_panes.js` and before `render.js`. Container CSS into the
  `DESKTOP_CSS` concat.
- Data: rail status cache read, disabled branch chip when the branch is
  unknown, no full status fetch, no blocking of shell render.

### Phase 2: Folder switching

- Extract `openWorkspaceHere` to the shell-level folder-change helper.
- Path chip opens the directory picker with an after-select callback into
  the helper.
- Explorer follow per decision 7.
- Verify picker git colors are intact on git paths (shared picker, test
  coverage already exists in `directory_picker.test.mjs`).

### Phase 2b: Remove the drawer's folder surfaces

The bar owns folder switching from here on. Two folder selectors alive at
once invite drift, so the drawer's folder surfaces die now. The drawer's
branch and worktree chips stay until phases 3 and 4 move them.

- Remove `git-ui-path-title` from `renderDiffLayoutSideToggle` and
  `openCwdPicker()` from `git_ui.js`.
- Remove the subtitle's path-notice (the differs span and the return
  button) plus `returnToWorkspaceCwd()`.
- Remove the side-bottom head's return-to-workspace button; if the head
  empties out entirely, drop the head wrapper.
- Retarget the e2e script and the pinned tests. Update docs.

### Phase 3: Branch switching

- Copy the branch popover renderers from `branch_list.js` into the bar
  module, namespace swapped, `git-ui-` classes kept.
- Branch chip opens the popover; switch posts `/api/git-ui/switch` with
  `{cwd, branch}`; keep the confirm dialog and the delete guards (remote
  rows and the current branch refused).
- New branch action: `/api/git-ui/switch` with `{cwd, branch, create: true,
  base}`; stays in the same workspace; popover refreshes after.
- `b` re-targets the bar popover; shortcut help text updated.
- Then remove from the drawer: the branch chip, the copied branch
  handlers, the branch modal and its markup, and the modal's pinned tests
  retargeted.

### Phase 4: Worktree switching and creation

- Copy the worktree popover into the bar module. Rows from
  `/api/worktrees?cwd=`; create action opens
  `openWorktreeCreateFromGitBranch(cwd, branch)`.
- Selecting a row routes through the folder-change flow with the row's
  checkout path. Old workspace panels stay open (decision 5).
- Worktree create navigation is unchanged (`go` with the created
  workspace, tab, and pane).
- The worktree chip renders only when the selected workspace is a linked
  worktree (`workspace.worktree.is_linked_worktree === true`).
- Then remove from the drawer: the worktree chip, the copied worktree
  handlers, the subtitle wrapper itself (nothing renders it anymore), and
  the dead popover CSS that the bar does not reuse.

### Phase 5: Settings cleanup and removal sweep

- Remove the "File browser parent folders" setting row and the
  `options.fileBrowserAllowParent` field: markup and ids list in
  `core.js`, the onchange binding in `bindings.js`, the default and
  normalize entries in `core.js`.
- Remove `fileBrowserParentFoldersEnabled()` from
  `shared/workspace_search.js` and both readers (desktop and mobile
  `file_browser.js`).
- `canGoUp()`/`goUp()` lose their escape clause: UP moves within the tree
  only, never above the workspace cwd.
- Sweep leftover state keys (`branchList`, `worktreeList`, `branchModal`)
  from git_ui state and render if any survive phases 3 and 4.
- Update `app_core.test.mjs` localStorage fixtures (six sites carry the
  key), any `canGoUp` pins, and the full removal test pass.
- Docs: `docs/technical-details.md` (folder picker UX, Git UI structure),
  `docs/features.md` if it names the modal or path title,
  `docs/release-notes.md` Unreleased entry covering the bar, the removals,
  the setting removal, and the explorer clamp.

### Phase 6: Mobile

Separate effort. The mobile file browser already loses
`parentFoldersEnabled` in phase 5 through the shared helper. A mobile
location bar is designed against the mobile shell layout, not ported.

## Ordered todo list

The todo tool holds the live plan. This list is the durable copy.

### Phase 1: Bar skeleton and data wiring
- [ ] 1.1 `app.html`: add `<div class="location-bar" id="locationBar" hidden>` inside `main`, above `#workspacePanes`.
- [ ] 1.2 `app_js/location_bar.js`: module with `sync()`, signature skip, three chip shapes, hidden state.
- [ ] 1.3 `render.js`: call `HerdrLocationBar.sync()` next to `syncFileWorkspaceToggle()`; `go()` in `core.js` repaints the bar on workspace switch.
- [ ] 1.4 `assets.rs`: module into `DESKTOP_JS` after `workspace_panes.js`; `.location-bar` container CSS into `DESKTOP_CSS`; popover CSS load strategy for the drawer-closed case.
- [ ] 1.5 Data: read rail-status cache; disabled branch chip when branch unknown; git_ui stays lazy.
- [ ] 1.6 Tests: new `src/assets/location_bar.test.mjs` (signature skip, chip shapes, hidden state); `app_load.test.mjs` pins for the new concat and HTML.
- [ ] 1.7 Verify: `node --test src/assets/location_bar.test.mjs src/assets/app_load.test.mjs`.

### Phase 2: Folder switching
- [ ] 2.1 Extract `openWorkspaceHere` from `file_browser.js` to the shell-level folder-change helper (focus-or-create semantics preserved).
- [ ] 2.2 Path chip opens `HerdrDirectoryPicker` with after-select into the helper.
- [ ] 2.3 Explorer follow after folder navigation; branch-only changes do not reload.
- [ ] 2.4 Verify picker git colors on git paths (run `directory_picker.test.mjs`).
- [ ] 2.5 Tests: folder-change flow tests (mock go, worktrees, workspaces, recents); file browser pinned tests updated.
- [ ] 2.6 Verify: `node --test src/assets/*.test.mjs`.

### Phase 2b: Remove the drawer's folder surfaces
- [x] 2b.1 Remove `git-ui-path-title` and `openCwdPicker()`; drop the side-bottom head if it empties.
- [x] 2b.2 Remove the subtitle path-notice and `returnToWorkspaceCwd()`.
- [x] 2b.3 Retarget `scripts/e2e/cwd-picker-acceptance.mjs` and the `app_load.test.mjs` pins (~7391-7415) to the bar.
- [x] 2b.4 Docs: `docs/technical-details.md` folder picker UX and Git UI structure.
- [x] 2b.5 Verify: full frontend suite plus manual smoke of the drawer (branch and worktree chips still work).

### Phase 3: Branch switching
- [x] 3.1 Copy branch popover renderers into the bar module (namespace swap, `git-ui-` classes kept).
- [x] 3.2 Branch chip opens the popover; switch posts `/api/git-ui/switch` `{cwd, branch}`; confirm and delete guards kept.
- [x] 3.3 New branch: `/api/git-ui/switch` `{cwd, branch, create: true, base}`, same workspace, popover refresh after.
- [x] 3.4 `b` shortcut re-target plus help text (`git_ui/shortcuts.js`, `showGitKeyboardHelp`).
- [x] 3.5 Remove the drawer's branch chip, copied handlers, branch modal and markup (`modals.js` `gitUiBranchCwd`), modal CSS.
- [x] 3.6 Tests: popover, switch, create tests in `location_bar.test.mjs`; shortcut and modal pins retargeted (`app_load.test.mjs`, `keyboard-guards-audit-desktop.mjs` ~444, `git_ui_behavior.test.mjs`).
- [x] 3.7 Verify: full frontend suite plus manual smoke of branch switching and creation.

### Phase 4: Worktree switching and creation
- [x] 4.1 Copy the worktree popover into the bar module; rows from `/api/worktrees?cwd=`; create opens `openWorktreeCreateFromGitBranch(cwd, branch)`.
- [x] 4.2 Row select routes through the folder-change flow; old workspace panels stay open.
- [x] 4.3 Worktree create navigation unchanged (`go` with workspace, tab, pane).
- [x] 4.4 Worktree chip renders only for linked worktrees.
- [x] 4.5 Remove the drawer's worktree chip, copied handlers, the subtitle wrapper, and dead CSS the bar does not reuse.
- [x] 4.6 Tests: worktree popover tests (list load, select-switch, create prefill); `git_ui_behavior.test.mjs` moved tests re-homed.
- [x] 4.7 Verify: full frontend suite plus manual smoke (switch worktree from the bar, old workspace panes intact).

### Phase 5: Settings cleanup and removal sweep
- [x] 5.1 Remove the "File browser parent folders" setting row and `options.fileBrowserAllowParent` (markup, ids list, binding, default, normalize).
- [x] 5.2 Remove `fileBrowserParentFoldersEnabled()` from `shared/workspace_search.js` and both file-browser readers; UP clamps to the workspace cwd.
- [x] 5.3 Sweep leftover git_ui state keys (`branchList`, `worktreeList`, `branchModal`) and render references.
- [x] 5.4 Update `app_core.test.mjs` fixtures (six sites) and `canGoUp` pins.
- [x] 5.5 Docs: technical-details, features.md if relevant, release-notes Unreleased entry.
- [x] 5.6 Verify: full frontend suite, `cargo fmt --check`, `cargo clippy --all-targets`, manual smoke (UP from a workspace root does nothing, UP within the tree works).

### Phase 6: Mobile
- [ ] 6.1 Design the mobile location bar against the mobile shell layout (separate doc/phase).

## Acceptance criteria

Desktop ships when all hold:

1. The bar renders above `#workspacePanes` for every selected workspace
   with a path: path chip always; branch chip for git repos (disabled when
   the branch is unknown); worktree chip for linked worktrees.
2. Branch and worktree chips open popovers copied from the drawer, with
   filter, load-more, delete guards, and create actions included.
3. Folder change (picker, worktree row, worktree create) lands on an open
   workspace when one lives on that folder; otherwise opens or creates one.
   The file explorer follows the new cwd. Old workspace panels stay open.
4. File explorer UP never goes above the workspace cwd, and the
   parent-folders setting is gone from the settings modal and storage
   normalization.
5. `b` opens the bar's branch popover; the branch modal is gone; shortcut
   help reflects it.
6. The Git drawer keeps its status sections, stash, commit, and sync
   flows with no folder, branch, or worktree selector left in it.
7. Full frontend suite green; `cargo fmt --check` and `cargo clippy
   --all-targets` green; the phase 5 manual smoke list passes.
