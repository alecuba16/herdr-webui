# UI parity: desktop vs mobile vs TUI

State of the three frontends after the keyboard accessibility and
draggable-modal work on branch `fix_keyboard_shortucts`. The matrix records
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
| Content search with snippet expansion | Full | Full | Full |
| Git: changes, per-file diff, stage/discard | Full | Full (files + diff + actions; conflicts shown as a file section, no resolution UI) | Full (plus hunk staging via `H`) |
| Git: log, two-commit compare, file history | Full | No | Full |
| Git: branches (create, switch, delete) | Full | Full (bottom sheet) | Full |
| Git: stash (list, apply, drop) | Full | No | Full |
| Git: cleanup (worktree/repo cleanup scan) | Full | No | Full |
| Git: conflict resolution UI | Full | No (conflicted files listed only) | Full (conflicts panel) |
| Git: tag/reset/rebase actions | Full | No | Full |
| Notes panel | Full (right sidebar view) | Full (Notes screen) | No |
| Session manager (built-in/external session picker) | Full (overlay) | Full (Sessions screen with create/cleanup) | No |
| Directory/cwd picker | Full (directory_picker.js modal) | Full (directory_picker.js sheet) | No (paths typed in prompts) |
| Settings | Full (merged modal + sections rail + search) | Full (screen, rollback chips) | Partial (read-only overlay, theme cycle only) |
| Worktree create/open flows | Full | Full | Full (prompts) |
| Prompt/question cards for blocked agents | Full (draggable card) | Full (bottom sheet) | No (answered in-pane) |
| Keyboard: prefix chord system (Ctrl+B default) | Full | Partial (no prefix overlay; screen-based navigation) | Full |
| Keyboard: arrow/Enter navigation in search | Full (palette + sidebar search panel) | Full (input keydown handler) | Full (j/k + Enter) |
| Keyboard: Tab trap in modals | Full (static modals, git modals, directory picker, session manager) | n/a (no Tab trap; sheets close on backdrop) | n/a |
| Keyboard: Escape closes topmost overlay | Full (cascade incl. session manager, directory picker) | Full (sheets/modals) | Full (Esc backs out) |
| Draggable modals | Full (all desktop modals; disabled on bottom-sheet widths) | No (bottom sheets drag-handle to close, not move) | n/a |
| Keyboard shortcuts editor (remap) | Full | No | No |
| LSP/window-layout/layout settings | Full | No | No |

## Known intentional gaps

- Mobile git surface is status/changes/branches/commit only: log, stash,
  cleanup, tag/reset/rebase, and conflict resolution are desktop/TUI. The
  mobile Files screen covers browsing and editing.
- TUI has no notes panel, session manager, or directory picker: the
  terminal surface answers prompts by typing paths.
- TUI settings overlay is read-only by design; theme cycling is the one
  live control. Browser-local settings belong to the browser frontends.
- Draggable modals are a desktop pointer feature. Mobile equivalents are
  bottom sheets whose handle drag dismisses the sheet (modals.css turns
  backdrops into bottom sheets at <=640px), so the drag helper disables
  itself there.
- The TUI answers blocked-agent questions inside the pane itself; desktop
  renders the draggable prompt card, mobile renders a bottom sheet.

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
