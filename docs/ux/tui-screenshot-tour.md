# TUI functionality screenshot tour

37 screenshots of the real `herdr-webui-tui` binary driving a real backend
session over an isolated temporary example repo. Files live in
`~/Downloads/screenshots/`, indexed by `README.md` there.

The TUI is a client: it needs a running `herdr-webui` built-in backend
session. The tour uses session `screenshots` on `127.0.0.1:8811` with a temp
repo ("Aurora Demo") so nothing touches real workspaces.

All shots come from one big iTerm2 window (dark theme), reused across
states including tab create/switch/close.

| Shot | State |
| --- | --- |
| `01-terminal-claude-agent.png` | Terminal screen, claude agent workspace selected, blocked permission dialog in the pane tail |
| `02-help-overlay.png` | `?` overlay listing all prefix shortcuts |
| `03-help-filter.png` | Help overlay with the filter box typed (`file`) |
| `04-prefix-hint.png` | `Ctrl+B` armed: footer shows the prefix hint, waiting for the shortcut key |
| `05-palette.png` | Prefix `/` search palette with a live query (`aurora`) |
| `06-git-changes.png` | Git changes list: staged/unstaged/untracked files with the diff pane |
| `07-git-changes-staged-diff.png` | Staged diff for `docs/architecture.md` selected |
| `08-git-hunk.png` | Hunk cursor (`J`) inside the loaded diff |
| `09-git-commit.png` | Commit message modal with the message typed |
| `10-git-log.png` | Log view with commit history |
| `11-git-branches.png` | Branches view listing feature branches |
| `12-git-stash.png` | Stash view with the `wip: filter wiring` entry |
| `13-git-file-history.png` | File history for the selected file |
| `14-git-conflicts.png` | Conflicts view (no merge in progress state) |
| `15-git-cleanup.png` | Cleanup view (untracked files, delete/prune actions) |
| `16-git-changes-diff-selected.png` | Working-tree diff for `config/settings.toml` |
| `17-worktree-browser.png` | Prefix `W` worktree browser overlay |
| `18-settings.png` | Prefix `s` settings overlay |
| `19-files-tree.png` | Prefix `f` file explorer tree |
| `20-files-preview.png` | File preview (`README.md`) with syntax coloring |
| `21-files-filter.png` | Files filter bar typed (`arch`) |
| `22-files-search-results.png` | Content search results grouped by file |
| `23-files-markdown-outline.png` | Markdown outline toggle (`M`) on `docs/architecture.md` |
| `24-files-edit.png` | In-place editor (`e`) over the preview |
| `25-files-edit-find.png` | Editor find bar (Ctrl-F) with query and matches |
| `26-terminal-aurora-shell.png` | aurora-demo workspace, shell pane with seeded output |
| `27-attach-mode.png` | Attach mode: typed input goes to the pane PTY |
| `28-composer.png` | Chat composer over the selected pane |
| `29-prompt-card.png` | Prompt card over the claude pane's blocked question with option cursor |
| `30-sidebar-collapsed.png` | Prefix `B` collapsed sidebar, full-width pane |
| `31-tab-created.png` | New `scratch` tab created, tab bar shows all tabs |
| `32-tab-switched-build.png` | View lands on the build tab after a tab closes |
| `33-tab-closed.png` | Another tab closed, view on the logs tab with live scanner output |
| `34-quit-confirm.png` | `q` quit confirmation overlay |
| `35-terminal-aurora-logs.png` | aurora-demo workspace, live scanner log tail |
| `36-cli-summary.png` | `--summary` one-line session summary |
| `37-cli-once.png` | `--once` full text snapshot mode |

## Known gaps

- No light-theme, blame, or chat-lens shots: those states need extra seeding
  (light TUI launch, blame-enabled diff, transcript-backed pane) that the
  session did not provide.
- Tab switching between plain (non-agent) panes is not reachable through the
  palette `Panel` navigation: it falls through to the workspace's active tab.
  The tour shows switching via tab close + backend refocus instead.

## Regeneration

There is no single `run.sh`. Regenerate manually with the helpers in
`scripts/e2e/tui_screenshots/`:

1. `make_example_repo.sh` builds the fake repo (commits, branches, stash,
   staged/unstaged/untracked changes, fake `claude` agent script).
2. Boot the backend: `herdr-webui --https off --backend-mode builtin --session screenshots --bind 127.0.0.1:8811`.
3. `control_client.py` creates workspaces/tabs/panes; `send_pane_input.py`
   seeds pane content over the terminal socket (bincode varint protocol).
4. Launch the TUI in iTerm2 tab 4 with explicit sockets, then drive keys with
   `tui_send.py` (AppleScript `write text` + `ASCII character` control bytes).
5. `capture.sh` finds the iTerm window and runs `screencapture -x -l <id>`.
6. Animated GIF: two-pass ffmpeg (`palettegen`/`paletteuse`, 960px, 1.2s per
   frame over a concat list of the 37 PNGs) produces `00-tui-tour.gif`.

Driving happens through iTerm2 AppleScript, so regeneration needs macOS with
Accessibility and Screen Recording permissions granted.