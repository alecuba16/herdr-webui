# UI parity: desktop vs mobile vs TUI

State of the three frontends after the keyboard accessibility,
draggable-modal, and git log workbench work. The matrix records
what each surface ships and the deliberate gaps. A gap listed here is a
known difference, not a bug filed against the desktop build.

## Legend

- Full: the feature is present and usable.
- Partial: the feature exists with reduced scope.
- No: the surface does not ship the feature.

## Feature matrix

| Feature | Desktop | Mobile | TUI |
| --- | --- | --- | --- |
| Workspace tabs/panes, agents, attach | Full | Full | Full |
| Terminal renderer, themes, scrollback follow/Tail | Full | Full | Full (ratatui) |
| Chat lens transcript view | Full | Full | Full |
| Search palette (prefix `/`) | Full (modal, keyboard-first) | Full (screen, keyboard handler on input) | Full |
| Recent workspaces (server-persisted) | Full (palette section, per-row remove, clear) | Full (Worktrees screen, per-entry open/remove, clear) | Full (palette, `Ctrl+X` remove, `Ctrl+Shift+X` clear) |
| File browser (tree, preview, edit, find/replace) | Full | Full (without find/replace bar; per-platform editor) | Full (edit buffer, Ctrl-F/Ctrl-H) |
| Content search with snippet expansion | Full (↑/↓ context arrows per match) | Full (Alt+arrows expand context) | Partial (matched lines with context and `+` load more; no per-match context arrows) |
| Git: changes, per-file diff, stage/discard | Full | Full (files + diff + actions; stage-all toggle, amend commit, pull/push/fetch; conflicts shown as a file section, no resolution UI) | Full (plus hunk staging via `H`) |
| Git: log, two-commit compare, file history | Full | No | Full |
| Git: branches (create, switch, delete) | Full | Full (bottom sheet + inline delete) | Full |
| Git: remote ops (push, pull, fetch) | Full (drawer status buttons) | Full (Git screen buttons, confirm-gated) | Full (in-screen `P` push, `p` pull, `f` fetch) |
| Git: stash (list, apply, drop) | Full | No | Full |
| Git: cleanup (worktree/repo cleanup scan) | Full | No | Full |
| Git: conflict resolution UI | Full | No (conflicted files listed only) | Full (conflicts panel) |
| Git: tag/reset/rebase actions | Full | No | Full |
| Notes panel | Full (right sidebar view) | Full (Notes screen) | No |
| Session manager (built-in/external session picker) | Full (overlay; prefix `Shift+U` or footer button) | Full (Sessions screen with create/cleanup) | Full (Shift+P overlay: switch, launch, close, cleanup, create, reload) |
| Directory/cwd picker | Full (directory_picker.js modal) | Full (directory_picker.js sheet) | No (paths typed in prompts) |
| Settings | Full (merged modal + sections rail + search) | Full (screen, rollback chips) | Partial (read-only overlay, theme cycle only) |
| Worktree create/open flows | Full | Full | Full (prefix `N` folder-path prompts; prefix `W` browsable worktree overlay with type-to-filter) |
| Prompt/question cards for blocked agents | Full (draggable card) | Full (bottom sheet) | No (answered in-pane) |
| Keyboard: prefix chord system (Ctrl+B default) | Full | Partial (no prefix overlay; screen-based navigation) | Full |
| Keyboard: arrow/Enter navigation in search | Full (palette + sidebar search panel) | Full (input keydown handler) | Full (j/k + Enter) |
| Keyboard: Tab trap in modals | Full (static modals, git modals, directory picker, session manager) | n/a (no Tab trap; sheets close on backdrop) | n/a |
| Keyboard: Escape closes topmost overlay | Full (cascade incl. session manager, directory picker) | Full (sheets/modals) | Full (Esc backs out) |
| Draggable modals | Full (all desktop modals; disabled on bottom-sheet widths) | No (bottom sheets drag-handle to close, not move) | n/a |
| LSP diagnostics under editor | Full (opt-in, per-language, hover/completion proxy) | Full (opt-in toggle, list under editor) | No |
| Chat composer (per-pane drafts) | Full | Full (docks in lens, Keys toolbar) | Full |
| Terminal image protocol (Kitty graphics) | Full (Ghostty core inline; wterm placeholder) | Full (same adapter) | No (Kitty/Sixel payloads skipped) |
| Attention sounds, browser notifications, alert card | Full | Full (sound + notifications, volume/scope) | No |
| No-sleep control | Full (header dropdown) | Full (Energy section) | No |
| Theme customizer + density | Full (customizer, 10 pickers, profiles, density) | Partial (auto/dark/light select, no customizer or density) | Partial (dark/light/system cycle via `t`) |
| Shortcut hint toasts | Full | No | No |
| Agent next/prev chords | Full (prefix `A` / `Shift+A`) | Partial (tap-to-select only) | Full (prefix `a`/`A`) |
| Search Actions section | Full (HerdrActionRegistry) | Full (mobileActionCandidates) | No |
| Edit locked/read-only files | Full (lock toggle flips editable back and forth) | Partial (readonly only for truncated/binary/markdown) | Partial (dirty guard blocks switching; no lock toggle) |
| Stuck-working dismiss | Full | Full | No |
| Connection-state banner | Partial (footer backend status) | Full (header dot + retry banner) | Partial (footer status, inflight spinner) |
| Temporary terminal overlay | No (removed) | No (removed) | No (removed) |
| Keyboard shortcuts editor (remap) | Full | No | No |
| LSP/layout settings sections | Full (per-language LSP scan, Layout, Window layout, Git UI sections) | Partial (LSP diagnostics toggle + Layout mode section; no window-layout or per-language LSP scan) | No |

Rows the audit verified as accurate stay unchanged: workspace tabs/panes
and agents, search palette, recent workspaces, file browser and editor
find/replace, the Git surface split (mobile keeps status, commit, branches,
remote ops; log, stash, cleanup, conflicts, tag/reset/rebase stay
desktop/TUI), notes, prompt cards, the keyboard contract matrix rows,
and draggable modals.

## Known intentional gaps

- Mobile git surface is status/changes/branches/commit plus the core
  remote ops (stage-all, amend, pull/push/fetch, branch delete): log,
  stash, cleanup, tag/reset/rebase, and conflict resolution stay
  desktop/TUI. The mobile Files screen covers browsing and editing.
- TUI has no notes panel or directory picker: the terminal surface
  answers prompts by typing paths. The session manager is the
  Shift+P overlay (HTTP surface, same endpoints as the webui).
- TUI settings overlay is read-only by design; theme cycling is the one
  live control. Browser-local settings belong to the browser frontends.
- Draggable modals are a desktop pointer feature. Mobile equivalents are
  bottom sheets whose handle drag dismisses the sheet (modals.css turns
  backdrops into bottom sheets at <=640px), so the drag helper disables
  itself there.
- The TUI answers blocked-agent questions inside the pane itself; desktop
  renders the draggable prompt card, mobile renders a bottom sheet.
- Desktop-only: pane split/maximize/move-tab/F10 pane menu, the shortcut
  remap editor, the theme customizer with named profiles plus the density
  toggle, shortcut hint toasts, the Window layout settings section, the
  Git UI settings section, the git drawer status-split pull/push flow
  with force modes, the in-diff hunk content editor with conflict-block
  controls, the per-language LSP scan with hover/completion/definition/
  formatting proxy, and the file lock toggle.
- Desktop and mobile, missing from the TUI: notes, prompt/question cards,
  attention sounds and browser notifications and the alert card,
  stuck-working dismiss, no-sleep control, Kitty graphics rendering,
  the search Actions section, and LSP diagnostics under the editor.
- Desktop and TUI, missing from mobile: the deeper Git views (log,
  compare, file history, blame, stash, cleanup, tag/reset/rebase, conflict
  resolution, hunk staging, diff search), editor find/replace, agent
  next/prev chords, and the user lock toggle for files.
- Mobile has no unique feature: every mobile surface has a desktop
  counterpart. The TUI adds no unique feature (its Shift+P session
  manager and Shift+S/Shift+R renames all have desktop chords now). The
  temporary terminal overlay and its promote flow are removed from every
  surface.

## Keyboard contract (desktop)

- Search palette (modal): arrows move, Enter opens, Alt+F/Alt+D file/folder
  scope, Alt+1/2/3 toggle sections, Alt+C/Alt+R match-case/regex,
  Alt+arrows expand snippet context, Esc closes. Tab trap active.
- Sidebar search panel: same contract as the palette, scoped to the
  selected workspace; Esc clears the query first, then collapses the
  sidebar.
- Modals: Escape closes the topmost (pane menu, directory picker, session
  manager, question, worktree create/open, workspace create, palette,
  settings). Tab is trapped inside any open modal, including git-ui
  modals and the directory picker.
- Session manager and directory picker were added to the Escape cascade
  and Tab trap as part of this work.
- Focus restore: opener-side modals (settings, worktree create/open,
  workspace create, search palette, directory picker, question card)
  record the focused element on open and hand focus back on close, so
  keyboard users do not fall to body after Esc. The session manager is
  excluded (auto-open owns the keyboard) and the picker restores to its
  Browse button when opened from one.
- Focus indicators: every interactive surface keeps a visible ring on
  :focus-visible (desktop uses --focus-ring box-shadow, mobile uses
  --ring outline). No control ships outline: none without a
  replacement indicator.
- Action inventory: every desktop click action is either a native
  button/anchor/input or a div/span carrying role=button (or
  treeitem/option) plus tabindex=0 and an Enter/Space keydown twin
  (delegated for spans, inline for tree rows). The live probe walks the
  shell, git drawer, and settings modal and fails on any clickable
  element a keyboard cannot reach.
- Context menus open from the keyboard: the Menu key or `Shift+F10` on
  file browser rows, git file rows, and git log rows opens the same menu
  right-click does. The git sync buttons (pull/push/fetch, cleanup tab,
  stash actions, conflict resolution) all carry remappable prefix chords
  and toasts with the configured key.
- Remaining pointer gestures without chords: pane divider drag, sidebar
  resize drag, worktree popover chips, theme auto-cycle triple-click,
  workspace reorder drag. Each has a keyboard alternate (arrow-key pane
  resize via F10 menu actions, sidebar arrow keys, rail cycle chord,
  theme dropdown) or is a pure pointer gesture.

## Shortcut parity notes (TUI chord table)

- The TUI prefix table now mirrors the desktop `DEFAULT_WEBUI_SHORTCUTS`
  and `DEFAULT_GIT_SHORTCUTS` chord for chord: `G` stage-all, `i`
  focus-file (previously unbound; the cwd picker keeps `Shift+I`), and
  the 5s prefix arm window matches the desktop prefix overlay timeout.
- `Shift+P` opens the TUI session manager. The desktop's default chord is
  prefix then `Shift+U` (remappable), so the surfaces meet in the middle:
  both have a chord plus a click entry.
- Pane-grid chords (`D`/`Shift+D` split, `E` close pane, `M` move tab
  to next pane, `Shift+M` maximize, `F10` pane menu) are
  N/A-by-architecture in the TUI: it renders one pane at a time, so
  there is no grid to split, maximize, or menu. The webui keeps them
  for the desktop pane grid only.
