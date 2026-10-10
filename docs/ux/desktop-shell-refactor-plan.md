# Desktop shell refactor: Zed-style layout

Plan for restructuring the desktop WebUI shell: right sidebar for files/git,
center region of tabbed panes with splits, tabs draggable between panes.
Analysis session 2026-10-08. This doc records the signed-off decisions, the
target architecture, and the phased implementation order. Mockups m1-m6 below
are the visual contract for each state.

## Signed-off decisions (2026-10-08)

1. **Temp machinery dies.** Delete temporary terminal modals
   (`shared/temp_terminal.js`), temp Files/Git overlays
   (`desktop/app_js/temp_overlays.js`, `shared/temp_overlay.js`), promote
   flows, and every related code path and test. Terminals are real backend
   tabs in panes; nothing opens in a modal.
2. **Git model split.** Right sidebar owns the status sections
   (staged/unstaged/untracked) and the stash list. Center pane tabs own
   per-file diffs, log, history, and comparisons. Clicking a file in the
   sidebar opens or focuses its diff tab in the center.
3. **Persistence.** Pane tree and tab layout persist in localStorage per
   workspace, same pattern as `workspace_shell.js` shell mode today.
4. **Shortcuts, layered.** Plain chords for the common four: split right,
   split down, close pane, move tab to next pane. Cmd/Ctrl+K chord prefix for
   the rare rest: resize, maximize, tab order.

Non-goals: left sidebar keeps its role (workspaces, agents, session footer).
Backend protocol stays as-is; panes reuse the existing client-owned pane/tab
surface model (`protocol.rs`).

## Target architecture

Three fixed regions:

- **Left sidebar** (unchanged): workspaces, agents, session footer.
- **Center**: binary pane tree. Splits horizontal and vertical, resizable
  dividers, per-pane tab strip. Tab kinds: `terminal` (one backend tab, its
  composer and lens travel with it), `editor` (one file, CodeMirror, dirty
  drafts), `git-diff` / `git-log` / `git-history` (center git views).
- **Right sidebar**: icon rail (files, git, search) + one content column.
  Files column = file tree only (`shared/file_tree.js`). Git column = today's
  `git-ui-side` status sections plus stash. Nothing opens inside the sidebar;
  every open action lands in a center pane tab.

State module `workspace_panes.js` owns the pane tree
(`{root: {dir, sizes, children}}`), tab identity, active pane, and
persistence. Git/file status caches stay workspace-keyed singletons shared
between sidebar and tabs; selections are per-tab.

## Migration map

| Today | Becomes |
|---|---|
| `#shellModeGroup` header buttons | Right sidebar rail + collapse toggle |
| `workspace_shell.js` mode swap | Right sidebar selection + collapse |
| `#terminalShell` | Terminal tab content inside a pane |
| `panel_switcher.js` dropdown | Terminal tabs in pane strips; `+` creates backend tab |
| temp terminal/overlay modals | Deleted (decision 1) |
| `file_browser.js` side tree | Right sidebar Files column |
| `file_browser.js` main + editor | Editor tabs in panes |
| `git_ui.js` `renderSide()` | Right sidebar Git column (status + stash) |
| `git_ui.js` `renderMain()` views | Center tabs: diff, log, history (decision 2) |

## Phases

1. **Foundation**: pane tree state + render, 4-column grid, right sidebar
   shell with rail, center renders one pane with a tab strip holding the
   existing terminal. Rail buttons drive the existing shell modes as a
   stopgap. Parity checkpoint: everything works as today.
2. **Right sidebar**: extract file tree and git side into the columns, delete
   `#gitUiPanel` / `#fileBrowserPanel` as main-area surfaces.
3. **Tab kinds**: editor tabs, git view tabs. Delete temp terminal/overlay
   machinery (decision 1).
4. **Splits + interactions**: split commands, resize handles, tab drag
   between panes, shortcuts per decision 4, persistence per decision 3.
5. **Cleanup**: remove `shellModeGroup`, `workspaceShellRestore`, dead CSS,
   migrate storage keys, update pinned tests and e2e scripts, refresh help
   text and docs.

## Mockups

### m1: default, right sidebar Files

```
┌─────────────────────┬───────────────────────────────────────────────────────┬──┬─────────────────────────────────┐
│ ◉ herdr       ●     │ ● zsh ✕   ● main.rs ✕   ● api.rs ✕       [+] [⊞] [⋮]  │  │  FILES                       ⟳ ⌕│
│ webui v0.9 · ok     ┼───────────────────────────────────────────────────────┼  │  ~/code/webui                   │
│                     │ $ cargo build                                         │▤ │─────────────────────────────────│
│ WORKSPACES          │    Compiling webui v0.9.0                             │▔ │  ▾ src                          │
│ ▾ ● webui      2    │                                                       │⎇ │    ▸ assets                     │
│   ▸ ● main     1    │    Finished in 2.4s                                   │  │    ● main.rs    M               │
│ ▸ ● api        3    │                                                       │⌕ │    ● api.rs     M               │
│ ▸ ● docs       1    │                                                       │  │    ▸ git_ui                     │
│                     │                                                       │  │  ▾ docs                         │
│ AGENTS              │                                                       │  │    ▾ ux                         │
│ ● claude   RUN      │                                                       │  │      plan.md                    │
│ ● jcode   WORK      │                                                       │  │  ● README.md                    │
│ ● pi      IDLE      │                                                       │  │  ● Cargo.toml                   │
│                     │                                                       │  │  ● test.rs     A                │
│╶───────────────────╴│                                                       │  │                                 │
│ ● session           │                                                       │  │                                 │
│ herdr v0.9.107      │                                                       │  │                                 │
│ backend · claude    │                                                       │  │                                 │
│                     │                                                       │  │                                 │
│                     │ > ▏ send to agent · ⏎ submit                          │  │                                 │
└─────────────────────┴───────────────────────────────────────────────────────┴──┴─────────────────────────────────┘
  left sidebar            center: one pane, tab strip + content                rail  right sidebar (files)
```

Tab strip controls: `+` new tab (kind-aware), `⊞` split menu (right/down),
`⋮` pane menu (split, close, maximize). Composer belongs to the active
terminal tab.

### m2: right sidebar Git

```
┌─────────────────────┬───────────────────────────────────────────────────────┬──┬─────────────────────────────────┐
│ ◉ herdr       ●     │ ● zsh ✕   ● main.rs ✕   ● api.rs ✕       [+] [⊞] [⋮]  │  │  GIT                          ⟳ │
│ webui v0.9 · ok     ┼───────────────────────────────────────────────────────┼  │  ⎇ feature/login ▾  ↩           │
│                     │ $ git status                                          │▤ │─────────────────────────────────│
│ WORKSPACES          │ On branch feature/login                               │  │  changes · log · stash · ⌫      │
│ ▾ ● webui      2    │ Changes not staged:                                   │⎇ │─────────────────────────────────│
│   ▸ ● main     1    │   modified: api.rs                                    │▔ │  STAGED (2)                     │
│ ▸ ● api        3    │                                                       │⌕ │  M  api.rs                      │
│ ▸ ● docs       1    │                                                       │  │  M  main.rs                     │
│                     │                                                       │  │  UNSTAGED (1)                   │
│ AGENTS              │                                                       │  │  M  docs/plan.md                │
│ ● claude   RUN      │                                                       │  │  UNTRACKED (1)                  │
│ ● jcode   WORK      │                                                       │  │  ?  tmp/notes.txt               │
│ ● pi      IDLE      │                                                       │  │─────────────────────────────────│
│                     │                                                       │  │  [Commit] [Pull] [Push]         │
│╶───────────────────╴│                                                       │  │  draft text kept                │
│ ● session           │                                                       │  │                                 │
│ herdr v0.9.107      │                                                       │  │                                 │
│ backend · claude    │                                                       │  │                                 │
│                     │ > ▏ send to agent · ⏎ submit                          │  │                                 │
└─────────────────────┴───────────────────────────────────────────────────────┴──┴─────────────────────────────────┘
```

Center untouched by the sidebar switch: terminal keeps running, files stay
open. Clicking a status file opens/updates its diff tab in the center.

### m3: vertical split, tab dragged between panes

```
┌─────────────────────┬───────────────────────────┬───────────────────────────┬──┬─────────────────────────────────┐
│ ◉ herdr       ●     │ ● zsh ✕              [+]  │ ● api.rs ✕       [+] [⋮]  │  │  FILES                       ⟳ ⌕│
│ webui v0.9 · ok     ┼───────────────────────────┼───────────────────────────┼  │  ~/code/webui                   │
│                     │ $ cargo test              │  12  fn handler() {       │▤ │─────────────────────────────────│
│ WORKSPACES          │ running 12 tests          │  13    serve();           │▔ │  ▾ src                          │
│ ▾ ● webui      2    │ test result: ok           │  14  }                    │⎇ │    ▸ assets                     │
│   ▸ ● main     1    │                           │                           │  │    ● main.rs    M               │
│ ▸ ● api        3    │                           │                           │⌕ │    ● api.rs     M               │
│ ▸ ● docs       1    │                           │                           │  │    ▸ git_ui                     │
│                     │                           │                           │  │  ▾ docs                         │
│ AGENTS              │                           │                           │  │    ▾ ux                         │
│ ● claude   RUN      │                           │                           │  │      plan.md                    │
│ ● jcode   WORK      │                           ↔                           │  │  ● README.md                    │
│ ● pi      IDLE      │                           │                           │  │  ● Cargo.toml                   │
│                     │                           │                           │  │  ● test.rs     A                │
│╶───────────────────╴│                           │                           │  │                                 │
│ ● session           │                           │                           │  │                                 │
│ herdr v0.9.107      │                           │                           │  │                                 │
│ backend · claude    │                           │                           │  │                                 │
│                     │                           │                           │  │                                 │
│                     │                           │                           │  │                                 │
└─────────────────────┴───────────────────────────┴───────────────────────────┴──┴─────────────────────────────────┘
```

`↔` is the live resize handle. Tabs drag between panes with an insertion
caret; drop on empty strip area = append. Replaces temp terminals: another
terminal is split + terminal tab.

### m4: horizontal split

```
┌─────────────────────┬───────────────────────────────────────────────────────┬──┬─────────────────────────────────┐
│ ◉ herdr       ●     │ ● main.rs ✕   ● api.rs ✕                 [+] [⊞] [⋮]  │  │  FILES                       ⟳ ⌕│
│ webui v0.9 · ok     ┼───────────────────────────────────────────────────────┼  │  ~/code/webui                   │
│                     │  12  fn main() {                                      │▤ │─────────────────────────────────│
│ WORKSPACES          │  13    serve();                                       │▔ │  ▾ src                          │
│ ▾ ● webui      2    │  14  }                                                │⎇ │    ▸ assets                     │
│   ▸ ● main     1    │                                                       │  │    ● main.rs    M               │
│ ▸ ● api        3    │                                                       │⌕ │    ● api.rs     M               │
│ ▸ ● docs       1    │                                                       │  │    ▸ git_ui                     │
│                     │                                                       │  │  ▾ docs                         │
│ AGENTS              ┼──────────────────────── ⋀ drag ───────────────────────┼  │    ▾ ux                         │
│ ● claude   RUN      │ ● zsh ✕   ● Temp.notes ✕                     [+] [⋮]  │  │      plan.md                    │
│ ● jcode   WORK      ┼───────────────────────────────────────────────────────┼  │  ● README.md                    │
│ ● pi      IDLE      │ $ tail -f logs                                        │  │  ● Cargo.toml                   │
│                     │ …                                                     │  │  ● test.rs     A                │
│╶───────────────────╴│                                                       │  │                                 │
│ ● session           │                                                       │  │                                 │
│ herdr v0.9.107      │                                                       │  │                                 │
│ backend · claude    │                                                       │  │                                 │
│                     ┼───────────────────────────────────────────────────────┼  │                                 │
│                     │ > ▏ send to agent · ⏎ submit                          │  │                                 │
└─────────────────────┴───────────────────────────────────────────────────────┴──┴─────────────────────────────────┘
```

Composer sits under the pane holding the focused terminal tab.

### m5: full split tree, git diff as center tab

```
┌─────────────────────┬───────────────────────────────────────────────────────┬──┬─────────────────────────────────┐
│ ◉ herdr       ●     │ ● main.rs ✕                                  [+] [⋮]  │  │  GIT                          ⟳ │
│ webui v0.9 · ok     ┼───────────────────────────────────────────────────────┼  │  ⎇ feature/login ▾  ↩           │
│                     │  12  fn main() {                                      │▤ │─────────────────────────────────│
│ WORKSPACES          │  13    serve();                                       │  │  changes · log · stash · ⌫      │
│ ▾ ● webui      2    │  14  }                                                │⎇ │─────────────────────────────────│
│   ▸ ● main     1    │                                                       │▔ │  STAGED (2)                     │
│ ▸ ● api        3    │                                                       │⌕ │  M  api.rs                      │
│ ▸ ● docs       1   │                                                       │  │  M  main.rs                     │
│                     ┼───────────────── ⋀ drag ──┼───────────────────────────┼  │  UNSTAGED (1)                   │
│ AGENTS              │ ● zsh ✕               [+] │ ⎇ changes ✕           [+] │  │  M  docs/plan.md                │
│ ● claude   RUN      ┼───────────────────────────┼───────────────────────────┼  │  UNTRACKED (1)                  │
│ ● jcode   WORK      │ $ cargo build             │ Δ src/api.rs        M     │  │  ?  tmp/notes.txt               │
│ ● pi      IDLE      │    Finished in 2.4s       │ @@ -12,4 +12,6 @@         │  │─────────────────────────────────│
│                     │                           │   fn handler() {          │  │  [Commit] [Pull] [Push]         │
│╶───────────────────╴│                           │ -   old_call()            │  │  draft text kept                │
│ ● session           │                           │ +   new_call(ctx)         │  │                                 │
│ herdr v0.9.107      │                           │ +   // draft kept         │  │  diff layout: split ▾           │
│ backend · claude    │                           │   }                       │  │                                 │
│                     ┼───────────────────────────┼                           │  │                                 │
│                     │ > ▏ ⏎ submit              │                           │  │                                 │
└─────────────────────┴───────────────────────────┴───────────────────────────┴──┴─────────────────────────────────┘
```

Top: editor. Bottom split: terminal left, git diff tab right. Sidebar and
tab share one status fetch; selections per tab.

### m6: right sidebar collapsed to rail

```
┌─────────────────────┬───────────────────────────────────────────────────────┬─────────────────────────────────┼──┐
│ ◉ herdr       ●     │ ● zsh ✕   ● main.rs ✕   ● api.rs ✕                    │                    [+] [⊞] [⋮]  │  │
│ webui v0.9 · ok     ┼───────────────────────────────────────────────────────┼─────────────────────────────────┼  │
│                     │ $ cargo build                                         │                                 │▤ │
│ WORKSPACES          │    Finished in 2.4s                                   │                                 │  │
│ ▾ ● webui      2    │                                                       │                                 │⎇ │
│   ▸ ● main     1    │                                                       │                                 │  │
│ ▸ ● api        3    │                                                       │                                 │⌕ │
│ ▸ ● docs       1    │                                                       │                                 │  │
│                     │                                                       │                                 │  │
│ AGENTS              │                                                       │                                 │  │
│ ● claude   RUN      │                                                       │                                 │  │
│ ● jcode   WORK      │                                                       │                                 │  │
│ ● pi      IDLE      │                                                       │                                 │  │
│                     │                                                       │                                 │  │
│╶───────────────────╴│                                                       │                                 │  │
│ ● session           │                                                       │                                 │  │
│ herdr v0.9.107      │                                                       │                                 │  │
│ backend · claude    │                                                       │                                 │  │
│                     │                                                       │                                 │  │
│                     │ > ▏ send to agent · ⏎ submit                          │                                 │  │
└─────────────────────┴───────────────────────────────────────────────────────┴─────────────────────────────────┼──┘
```

Same toggle contract as the left sidebar today. Git icon keeps its status
tint.

## Phase 3b design: editor tabs (2026-10-08)

Implementation design for "editor tabs, git view tabs" in phase 3, produced
after the post-3a recon. Scope of this subphase is the editor half; git view
tabs (diff/log/history) land as 3c.

### What dies, what stays

`file_browser.js` keeps the side tree only: workspace-keyed state cache
(cwd/root/home/path/entries/children/expanded/loading/selected/gitStatus/
filter), the tree render + callbacks, refresh, git status, and the access
error path. The main surface dies: the open-file tab strip
(`renderOpenFileTabs`, `singleTab`), the `state.files` list, `state.split`,
the tab context menu, split toggle, and the in-browser `state.contentSearch`
(the unified workspace search owns content search via
`shared/file_content_search.js`/`workspace_search.js`; desktop file_browser's
copy has no external callers).

`hostSideOnly`, `releaseToCenter`, and the rehost dance die with the main
surface: nothing opens in the sidebar anymore, every file open lands in a
center pane tab. The Files rail toggle becomes purely open-or-collapse.

### Editor tab state

`workspace_panes.js` owns tab identity. Editor tabs are `editor:<path>`
(one tab per file). Terminal tabs keep backend `tab_id` identity. Pane
tree shape unchanged in this subphase (`{kind:"pane", tabs:[...],
active:"..."}`), so Phase 4 splits and drag reuse the same identity model.

Per-file editor state (content, draft, dirty, editing, hash, preview mode,
lsp) moves out of `state.files` into a workspace-keyed editor registry in
file_browser.js (`HerdrFileBrowser.editorFor(wsKey, path)`) backed by the
existing `editorCache` Map (keyed `${wsKey}|${path}`) so CodeMirror
instances survive tab switches. Selection is per-tab by construction: the
active tab's file is the mounted editor.

Tab strip: editor tabs render from the registry (basename label + dirty
dot, tooltip = full path, close button with dirty confirm). The strip is
part of `renderWorkspacePanes()`, which already re-renders on every
`render()` pass via core.js:4118 / render.js:95. `+` stays terminal-only
until Phase 4's kind-aware menu.

### Mount flow

The pane content slot hosts one editor container per tab
(`pane-editor-${hashId(path)}`), created with createElement (same
no-innerHTML contract as the pane skeleton) and moved in by reference;
`mountPaneTabContent` mounts the terminal for terminal tabs, the editor
container for editor tabs. Only the active tab's editor is in the DOM.
Inactive editor tabs keep their cached CodeMirror node in `editorCache`.

Dirty confirm on close reuses the existing wording. Save (Cmd/Ctrl+S),
lock, markdown preview toggle, find-in-file (Cmd/Ctrl+F), goto-line, the
partial preview offer, and LSP diagnostics keep working per tab: the
toolbar moves with the editor into the pane container and the A6
external-change watcher iterates the registry instead of `state.files`.

### Open routing

`HerdrFileBrowser.open` (rail click) keeps opening the hosted tree.
`openAt(path, {kind:"file"})`, search palette results, git_ui's
showInExplorer, and content-search match clicks call a new
`HerdrFileBrowser.openEditorTab(path)` that ensures the tab exists in the
active pane and activates it, never touching the sidebar. `openAt` for
`kind:"dir"` keeps steering the tree.

### Lazy-load boundary

file_browser.js stays a lazily-loaded feature. Pane strips must render
editor tabs even while file_browser.js is unloaded, so the tab identity
lives in workspace_panes.js (persisted with the pane tree) and strips
render placeholder labels from tab metadata; clicking a placeholder
triggers `ensureFileBrowserLoaded()` then the real open. Editor state
fills in when the module loads.

### Test migration

app_load pins at 1532-1535 (rehost/release contract) flip to negative
guards (the machinery is gone); the open-file tab strip pins (1619/1649/
1695) move to the pane strip contract (labels from the pane module,
dirty dot, close with confirm). The app_core file-browser cluster moves
with the surface: tree behavior tests stay against file_browser.js, editor
behavior tests (mounts, drafts, dirty, reuse) move to the pane tab flow.
workspace_panes tests keep pinning the createElement skeleton contract.
Rust pins: none (confirmed zero file-browser pins in Rust tests).

## Phase 3c design: git view tabs (2026-10-08)

Implementation design for the git half of phase 3. Decision 2 splits the
git surface: the right sidebar column keeps the status side (`renderSide`:
head, branch/worktree actions, view toggle row, file sections, stash list,
layout toggle), and every main view (`renderMain`) becomes a center pane
tab. `releaseToCenter` and the whole rehost dance die here.

### Git tab identity

Tab id namespace: `git:<view-key>` where view-key is one of
- `changes` — working-tree diff (all files or per-file focus via `?file=`)
- `log`, `stash`, `cleanup`, `conflicts` — the main views
- `history@<path>` — file history
- `diff@<path>` — a single file's focused diff
- `compare@<base>..<target>` — commit/selection compares

One tab per view-key per workspace (pane tree is already per-workspace),
so clicking another status file reuses the same `changes` tab and moves
its focus, matching "opens or updates its diff tab" in m2. The side
toggle row (`changes · log · stash · ⌫`) switches the center git tab
instead of the panel's own `view.tab`; sidebar never releases.

### Per-view state, shared status

git_ui's `state.cache[workspaceKey]` view object stays the single
per-workspace git state (status, diff data, log state, stash state,
commit draft, navigation stack). The center tab identity maps to fields on
that view (`view.file`, `view.tab`, `view.mode`, `compareBase/Target`), so
no state duplication: activating a git tab sets those fields and renders
`renderMain` into the tab's container; the sidebar's status sections and
the active diff share one status fetch (m5 contract). The workspace view
cache entry persists across tab close only for the status side; main-view
state (log scroll, selected stash) is cheap to refetch on reopen.

### Mount flow

`renderWorkspacePanes` gains a third tab kind renderer. Git tabs mount a
`section.pane-git-container` (createElement contract, same rule as editor
containers) into the pane content slot. The git panel is NOT moved into
the pane: git_ui keeps `#gitUiPanel` hosted in the sidebar, and
`renderMain` output goes into the active git tab's container
(`git_ui.mountInto(containerId)`); the terminal parking rule extends to
git tabs (same `mountPaneTabContent` branch). Inactive git tab containers
keep their DOM (scroll survives tab switches) but get `display: none`.

### Sidebar interaction changes

- `HerdrGitUi.tab(id)` → opens/activates the git center tab for that view.
- `selectFile` (status row click) → focuses `diff@<path>` inside the
  changes tab (or opens it) and activates that tab.
- Stash list clicks keep their view-local state but ride the `stash` tab.
- `showChangesList` / `latestChanges` → activates the `changes` tab.
- `openFileHistory` (file browser context menu) → opens the
  `history@<path>` tab.
- Esc semantics: one stack pop per press inside git tabs (existing
  navigation stack), closing the tab only at the changes root.

### What dies

`rightSidebarReleaseToCenter`, `panelIsHosted` release branch,
`rehostSide` option, the `hostedResult === "legacy"` center fallback
render of the full surface (`renderSide + renderMain` in one panel), and
`syncTerminalVisibility`'s legacy branch. The git panel in the center area
ceases to exist: hosted is the only desktop surface.

### Lazy-load boundary

Same contract as editor tabs: strip renders git tab placeholders (label
from tab id) while git_ui.js is unloaded; clicking one runs
`ensureGitUiLoaded()` then the real open. Persistence rides the existing
pane tree storage, so git tabs survive reload with placeholder labels
until the module loads.

### Test migration

git_ui_behavior tests (53) boot the legacy full-surface harness without
HerdrRightSidebar: they migrate to hosted-render assertions via a
HerdrRightSidebar stub (the fallback path dies with the center surface).
app_load rehost pins flip to negative guards
(like the file browser did). desktop_right_sidebar `releaseToCenter` tests
delete with the function. workspace_panes tests gain the git tab strip
contract (kind renderer, activation, close, placeholder). app_core pane
harness gains a HerdrGitUi stub for cross-module assertions. Rust pins:
none expected (git_ui is client-only).

### Implementation status (2026-10-08)

Landed exactly as designed, plus three coherence fixes live validation
surfaced:

- The hosted drawer with no git tab renders the side alone (3b rail
  click parity); a status-row or toggle click opens the center tab on
  demand. Without this the fallback crammed the full diff into the
  319px sidebar column.
- `syncPaneTabFromView()` heals the strip when an internal state flip
  invalidates the active tab (refresh dropping an emptied stash view,
  `markNoGitRepository`, folder switch in `resetGitViewForCwd`):
  `openGitTab` of the view's real key; no-op on terminal/editor
  sessions. `compareCommits` routes through its own compare tab like
  `showHistoryCommit` already did.
- The file browser History menu item lazy-loads git_ui via
  `window.HerdrShowFileHistory` (render.js wraps `ensureGitUiLoaded`):
  pre-3c the item silently no-opped when the Git drawer had never
  opened, and the history view being a first-class center tab made the
  gap user-visible.

Validation: JS 885/0, cargo 1035/0, live CDP batteries git-smoke 12/12,
persist 4/4, entry 2/2, hist 1/1, pane 9/9, pane-extended 9/9,
activation 13/13, plus rail/stash-heal/non-git/stashFile coherence
probes all green.


## Phase 4 design: split panes (2026-10-08)

Implementation design for "Splits + interactions" per decisions 3 and 4.
Recon basis: 7f8365e tree (Phase 3c complete).

### Scope

Split commands (right/down), resize handles, close pane, move tab to
next pane, shortcuts, persistence of the pane tree. Tab drag between
panes was listed under this phase in the overview; it moves to Phase 5
cleanup-and-polish territory only if it lands cleanly — the insertion
caret needs its own live probe battery. Decision: drag ships in 4 if
timebox allows, otherwise the strip stays click-to-move via the move
command.

### Pane tree model

`panesStateFor` roots become a real tree:

```
{kind:"pane", tabs:[...], active:"..."}              // leaf
{kind:"row"|"column", sizes:[a,b], children:[...]}    // split node
```

Leaves keep today's contract verbatim (tabs array, active pointer,
placeholder seeding, terminal sync). Split nodes carry `sizes` as flex
grow numbers (not percentages) so resizing is one number edit plus a
render; `sizes` length always equals children length. The recursive
renderer walks the tree; `paneRoot()` keeps returning the root node, and
every helper that today assumes a leaf (`paneTabs`, `paneActiveTab`,
`syncTerminalTabsIntoTree`, `paneTabsForTree`) gains a walk: leaf
helpers operate on the active leaf, sync runs per-leaf. The active
*pane* pointer (which leaf owns the strip highlight and receives new
tabs) is a new tree-level `root.activePaneId`; leaves get stable
`paneId`s ("p1", "p2", ...).

### What stays a singleton (hard constraint)

Exactly one live terminal surface exists (`#terminalShell`, one wterm
instance, one backend pane attach). Splits therefore never put two
terminal tabs in different leaves: the leaf holding the route terminal
tab (`state.tab`) is the terminal leaf; all other leaves are
editor/git-only. This is enforced at split/move time, not render time:
`splitPane(dir)` clones the active leaf's *non-terminal* tabs into the
new leaf and keeps the terminal in place, and `moveTabToNextPane`
refuses to move a terminal tab (documented in the shortcut help). The
Route→leaf mapping: `state.tab` names the terminal tab; the leaf whose
tabs contain it is the terminal leaf. Same invariant for the composer
and lens: they render relative to `#terminalShell`'s offset parent and
follow it.

### Render and mount changes

`renderWorkspacePanes` builds `.pane-row`/`.pane-column` split
containers (createElement contract, never innerHTML on containers
holding live nodes) with `.pane-divider` handles between children.
Leaves keep `.workspace-pane` > `.pane-tab-strip` + `.pane-content`.
`mountPaneTabContent` takes the leaf element; `file_browser.js:430` and
`git_ui.js:567` (`document.querySelector("#workspacePanes
.workspace-pane")`) change to `querySelectorAll` + the leaf whose
paneId matches the target tab's pane. The strip render stays
signature-gated per leaf. Dividers: flex-basis grows via
pointer-dragging, stored back into `sizes` on pointerup, persisted with
the tree.

CSS: `.pane-row`/`.pane-column` are flex containers with
`min-width:0;min-height:0` children; `.pane-divider` is the 6px live
handle with the col-resize/row-resize cursor.

### Commands

- `splitPaneRight()` / `splitPaneDown()`: wrap the active leaf in a
  row/column split node. The new sibling leaf starts empty: the strip
  `+` stays terminal-only (existing behavior), so opening content there
  goes through the sidebar (file tree click, git status row) landing in
  the focused leaf. Per the singleton constraint the terminal never
  moves to the new leaf.
- `closeActivePane()`: closes the active leaf; tabs die with it (editor
  tabs run the dirty confirm per tab, git tabs close silently), the
  sibling is promoted (its parent split node is replaced by the
  sibling). The root never closes below one leaf.
- `moveActiveTabToNextPane()`: active tab id moves to the next leaf in
  tree order (wraps); pointer follows; the moved-to leaf activates.
- Resize: drag handles only. `Cmd/Ctrl+K` chord resize commands are
  Phase 5 polish if the handles prove insufficient.

### Shortcuts (decision 4)

Plain chords in `webuiShortcuts` (user-configurable, prefix Ctrl+B by
default like the rest): `splitRight` ("KeyD"), `splitDown`
("Shift+KeyD"), `closePane` ("KeyE"), `moveTabNextPane` ("KeyM"). All
four no-op on editable/terminal targets per the existing
`editableShortcutTarget` guard. Help modal rows update in core.js's
shortcut list. The `◫`/`⊟` strip buttons enable and call the same
commands; the third control (`[+]` stays terminal-new-tab) is
unchanged.

### Persistence (decision 3)

The tree persists in the existing `WORKSPACE_PANES_STORAGE_KEY`
localStorage blob (it already holds the root object; split nodes are a
superset of the leaf shape, so no migration is needed — old blobs are
valid trees). `activePaneId` persists; tab ids and per-leaf actives
persist as today. The boot heal extends: if the stored active pane id
is missing, the first leaf wins.

### Interaction guardrails

- The right sidebar host and git drawer keep reading the *active leaf*
  (its active tab) for `paneNonTerminalTabActive()`-style checks — all
  existing call sites keep semantics (they ask about the strip the
  user is looking at).
- `syncPaneTabFromView` heals within the active leaf only.
- Terminal sync (`syncTerminalTabsIntoTree`) runs per-leaf; the route
  terminal tab joins its own leaf's strip; a leaf without a terminal
  tab renders no terminal entries (it can still hold editor/git tabs).
- The composer/lens/`fitTerminalSurface` pipeline is untouched: the
  shell ResizeObserver already fires when the terminal leaf resizes
  (split resize, divider drag), so refits ride the existing observer.

### Tests

workspace_panes.test.mjs: tree helpers (split creation, sizes
invariant, close-promote-sibling, move-tab wrap), render walk with the
createElement DOM stub (no innerHTML on split containers), persistence
round-trip with split nodes, terminal singleton guard (split refuses
to clone terminal; move refuses terminal). app_load.test.mjs pins:
strip buttons enabled + wired, shortcut entries registered,
per-leaf mount contract for file_browser/git_ui querySelectorAll
change. Live CDP battery (new `split3d.mjs`-style probes): split right
twice → three leaves with dividers, editor tab in second leaf, active
pointer, drag a divider (synthetic pointer events) → sizes persist
across reload, close middle pane → siblings merge, move tab command →
tab lands in next leaf, shortcut triggers, terminal still alive and
fitting in its leaf, git tab opens in the focused leaf.

### Out of scope here

Tab drag between panes (insertion caret) unless it lands cleanly;
`[⋮]` per-pane menu (Phase 5 kind-aware menu); maximize pane; storage
key migration (Phase 5); `shellModeGroup` deletion (Phase 5).

### As built (2026-10-08)

Deviations from the design above, found during implementation:

- `splitActivePane` wraps the active leaf with a **fresh empty sibling**
  (not a clone of non-terminal tabs): the strip `+` stays
  terminal-only and sidebar opens land in the focused leaf anyway, so a
  clone would only duplicate strip state for no user-visible gain.
- Terminal singleton is enforced at **mount time** on top of split/move
  time: `mountPaneTabContent` parks `#terminalShell` only when *no*
  leaf holds a terminal tab (`shellHostsTerminal`), so a non-terminal
  leaf never steals the shell from the leaf that still hosts it. A
  `nodeWithin`/`rescueLiveSurfaces` pass lifts the shell and editor/git
  containers into `#workspacePanes` before a render drops an abandoned
  subtree, because getElementById orphans nodes inside detached DOM.
- Split node ids are **path-based** (`split-<kind>-<i>` joined with `/`)
  rather than stable slot ids: nested splits at the same index never
  collide, and reconciliation stays id-keyed.
- `closeActivePane` promotes the sibling via `findSplitSlot`, which
  returns the slot holding the **split node itself** ({holder:"root"} or
  the grandparent children array + index). An earlier version returned
  the children array and indexOf'd the split's children inside it, which
  wrote the sibling into the wrong slot on every nested close (caught by
  the live split battery, unit tests only exercised the root-split case).
- Tab drag between panes did not land: click-to-move via the move
  command ships in 4, the insertion caret stays Phase 5.

Validation: JS 890/0, cargo 1035/0, live CDP batteries split-smoke 7/7,
git-smoke 12/12, pane 9/9, pane-extended 9/9, entry 2/2, activation
13/13, persist 5/5, hist 1/1 all green on the rebuilt binary.


## Phase 5 design + as built: cleanup and deferred features (2026-10-09)

Scope per the phase list: remove the panel switcher remnant, add the
deferred interactions (maximize, kind-aware pane menu, tab drag with
insertion caret), slim the shell, refresh help text. Recon basis:
a48ce6d tree (Phase 4 complete).

### Panel switcher removal (5-2a)

`panel_switcher.js` dies in full: the four label helpers
(`isDefaultPanelTitle`, `panelNumberLabel`, `panelVisibleLabel`,
`panelRenameInitialLabel`) move into `workspace_panes.js` beside the
strip, and the rest (`panelTooltip`, `canClosePanel`, `renderPanelField`,
`togglePanelMenu`, the panel field, the `panelCloseMode` setting) goes
with the file. Every reference in render/bindings/core/app.html/CSS is
removed. `assets.rs` drops the script tag. The pane strip is now the
only tab surface.

### Maximize pane (5-2b)

`maximizeActivePane()` stores the active leaf id in the pane state
entry (`maximizedPaneId`) and syncs `root.activePaneId` to the
maximized leaf; `paneIsMaximized()` reads it back. `renderWorkspacePanes`
splits `treeRoot` (persisted tree) from `root` (effective root: the
maximized leaf or the tree), so the maximized render reuses the flat
single-pane path keyed by the maximized leaf's paneId. The maximize
does not mutate the tree, so restore is a pointer drop.
`cleanupAbandonedLayout` runs against the effective root always: a
maximize parks the dropped split DOM with the live-surface rescue and
reconciliation rebuilds it on restore. `closeActivePane` clears a
maximize that targets the closing leaf. Shortcut: Shift+M (toggle).
Persistence rides the existing blob; no migration.

### Kind-aware pane menu (5-2c)

Every strip gets a `[⋮]` control (`paneMenuControlHtml`).
`paneMenuItemsFor(leaf, root)` is kind-aware: split right/down always;
maximize and close only when the tree holds more than one leaf;
move-file-to-next-pane only for editor tabs; rename only for terminal
tabs (via `paneTerminalTabById`). `togglePaneMenu(paneId)` builds the
menu on `document.body` positioned from the button rect; Esc closes
(it is the first branch of the bindings keydown chain), a capture-phase
mousedown outside closes, and re-toggling the same pane closes.
Shortcut: F10 opens for the active pane; the dispatch resolves the
button through `activePaneElement()` (there is no `.workspace-pane.active`
DOM class). CSS `.pane-menu`/`.pane-menu-item` in panes.css.

### Tab drag with insertion caret (5-2d)

Editor and git tab buttons are `draggable`; terminal tabs refuse (the
terminal is a singleton backend tab). `paneDropIndexAt` computes the
drop slot from tab midpoint rects; `paneDropCaretAt` renders a
`.pane-drop-caret` marker; `paneStripDragOver` prevents default, sets
dropEffect=move, and stores the drop index on the strip dataset;
`paneStripDrop` calls `movePaneTabTo(tabId, targetPaneId, index)`,
which handles same-leaf reorder and cross-leaf splice/insert/activate
(focusLeaf on the target, reopen so the surface lands in the new
leaf). `wirePaneStripDrag` wires the strip once per render with a
`typeof strip.addEventListener` guard so the standalone harness fake
DOM (which lacks addEventListener) keeps working.

### Shell slim and help text (5-2e)

`hideWorkspaceShellSurfaces` had zero callers and dies; the rail mode
machinery stays because right_sidebar.js still consumes it. Storage key
audit: every `herdr-web-*` key is live, so the storage key migration
guessed in the phase list was unnecessary and no migration shipped.
Help text: the stale "Panels/Tabs" row is replaced by a "Panes" row,
and six pane shortcut rows (D, Shift+D, E, M, Shift+M, F10) join the
shortcut help, with the two new entries also in the shortcut settings
groups.

### Validation

JS 895/0 (workspace_panes.test.mjs gained maximize round-trip,
maximize refusal and stale-id heal, kind-aware menu items, menu toggle
dispatch, source pins for the menu/drag markup, movePaneTabTo
cross-leaf/reorder/refusals), cargo 1035/0, build green. Live CDP
battery on the rebuilt binary: phase5-smoke 24/24, split-smoke 7/7,
git-smoke 12/12, pane 9/9, pane-extended 9/9, entry 2/2, hist 1/1,
activation 13/13, persist 5/5, plus the hist3c2 openFileHistory dump
probing the menu action chain. The battery runs against an isolated
`--session smoke` backend over a wsroot fixture repo.

Deviation found during the battery: none of the deferred features
needed a design change. The two live failures that kicked off the deep
debug were environmental, not code: the worktree `.git` gitfile had a
corrupted first byte (repaired), and the smoke backend's first-listed
workspace pointed at the project worktree instead of the fixture
wsroot, so the git drawer rendered the wrong repo. Recreating the
workspace with the wsroot cwd fixed the probes.

### Post-battery edge fixes (2026-10-09)

A second edge battery over the committed tree found three real defects,
all fixed in `workspace_panes.js`:

1. Splitting from a maximized pane mutated the hidden tree with no
   visible change. `splitActivePane` now clears the stored maximize
   (`maximizedPaneId = null`) before splitting, so the new sibling
   joins the restored layout.
2. The pane menu Rename opened no input: the rename branch in the old
   `renderTabButton` (uncalled since the pane strip took over tab
   rendering, but still shipped in the bundle) is unreachable, so the
   strip's `paneTabButtonHtml` gained an editing branch rendering
   `.tab-rename-input` when `state.editingTab` matches, wired to the
   existing `tabRenameKey`/`commitTabRename` handlers.
3. Editor and git tabs pushed into the tree by `paneEnsureEditorTab`/
   `paneEnsureGitTab` did not render in the strip when their drawer was
   closed (the drawer render path gates on `state.open`). Both now
   save and render immediately after pushing a new tab id.

Re-validated on the fixed binary: the full battery above plus the edge
battery (11 checks: nested tree menu retarget, rename flow, editor tab
move via menu and `movePaneTabTo` drop index, maximize flat render,
split-from-maximized restore, close-maximized-leaf restore, size
round-trip) all pass, node 895/0 and cargo 1035/0 unchanged.
