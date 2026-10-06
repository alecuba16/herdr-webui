# TUI screenshots

Every screen of `herdr-webui-tui`, captured from a real binary attached to a
real built-in backend session over a demo repo. All shots come from one
iTerm2 window in dark theme. The animated GIF (`screens/tui/00-tui-tour.gif`)
walks the whole tour.

Keyboard model: `Ctrl+B` arms the prefix, then a shortcut key fires. `?`
opens the help overlay, `/` the search palette.

## Terminal and navigation

| Shot | What it shows |
| --- | --- |
| ![terminal with claude agent](screens/tui/01-terminal-claude-agent.png) | Terminal screen: workspace sidebar, agent rows with status, and a blocked Claude permission dialog in the pane tail. |
| ![aurora shell](screens/tui/26-terminal-aurora-shell.png) | Shell tab of a demo workspace with normal prompt output. |
| ![aurora logs](screens/tui/35-terminal-aurora-logs.png) | Logs tab with a live scanner log tail ticking. |
| ![attach mode](screens/tui/27-attach-mode.png) | Attach mode: the pane owns input, footer shows attach hints, typed keys go to the PTY. |
| ![sidebar collapsed](screens/tui/30-sidebar-collapsed.png) | Sidebar collapsed: the pane takes the full width. |
| ![palette](screens/tui/05-palette.png) | Search palette with a live query and result rows for workspaces and panels. |

## Overlays and prompts

| Shot | What it shows |
| --- | --- |
| ![help overlay](screens/tui/02-help-overlay.png) | Help overlay listing every prefix shortcut. |
| ![help filter](screens/tui/03-help-filter.png) | Help overlay filter box narrowing rows as you type. |
| ![prefix hint](screens/tui/04-prefix-hint.png) | Prefix armed: footer shows the hint and waits for the next key. |
| ![composer](screens/tui/28-composer.png) | Chat composer prompt over the selected pane. |
| ![prompt card](screens/tui/29-prompt-card.png) | Prompt card answering an agent's blocked question with an option cursor. |
| ![quit confirm](screens/tui/34-quit-confirm.png) | Quit confirmation with y/n keys. |
| ![worktree browser](screens/tui/17-worktree-browser.png) | Worktree browser overlay with filter and open hints. |
| ![settings](screens/tui/18-settings.png) | Settings overlay. |

## Git screens

`Ctrl+B g` opens the git screen; `Tab` cycles views.

| Shot | What it shows |
| --- | --- |
| ![git changes](screens/tui/06-git-changes.png) | Changes list (staged, unstaged, untracked) with the diff pane. |
| ![staged diff](screens/tui/07-git-changes-staged-diff.png) | Staged diff of `docs/architecture.md`. |
| ![hunk cursor](screens/tui/08-git-hunk.png) | Hunk cursor inside the loaded diff. |
| ![diff selected](screens/tui/16-git-changes-diff-selected.png) | Working-tree diff for the selected file. |
| ![commit prompt](screens/tui/09-git-commit.png) | Commit message prompt with the message typed. |
| ![git log](screens/tui/10-git-log.png) | Commit history log view. |
| ![branches](screens/tui/11-git-branches.png) | Branch list with feature branches. |
| ![stash](screens/tui/12-git-stash.png) | Stash view with one entry. |
| ![file history](screens/tui/13-git-file-history.png) | File history for the selected file. |
| ![conflicts](screens/tui/14-git-conflicts.png) | Conflicts view (no merge in progress). |
| ![cleanup](screens/tui/15-git-cleanup.png) | Cleanup view: untracked files and prune actions. |

## Files screens

`Ctrl+B f` opens the file explorer.

| Shot | What it shows |
| --- | --- |
| ![files tree](screens/tui/19-files-tree.png) | File tree of the repo root. |
| ![files preview](screens/tui/20-files-preview.png) | Preview of `README.md` with syntax coloring. |
| ![files filter](screens/tui/21-files-filter.png) | Filter bar narrowing the tree as you type. |
| ![search results](screens/tui/22-files-search-results.png) | Content search results grouped by file. |
| ![markdown outline](screens/tui/23-files-markdown-outline.png) | Markdown outline panel toggled on a preview. |
| ![edit mode](screens/tui/24-files-edit.png) | In-place editor over the preview. |
| ![find bar](screens/tui/25-files-edit-find.png) | Editor find bar with query and matches. |

## Tabs

| Shot | What it shows |
| --- | --- |
| ![tab created](screens/tui/31-tab-created.png) | A new `scratch` tab created; the tab bar lists all tabs. |
| ![tab switched](screens/tui/32-tab-switched-build.png) | After closing a tab the view lands on the build tab with cargo output. |
| ![tab closed](screens/tui/33-tab-closed.png) | Another tab closed; the view lands on the logs tab. |

## CLI one-shot modes

| Shot | What it shows |
| --- | --- |
| ![cli summary](screens/tui/36-cli-summary.png) | `herdr-webui-tui --summary`: one-line backend/session summary. |
| ![cli once](screens/tui/37-cli-once.png) | `herdr-webui-tui --once`: full text snapshot without entering the UI. |

## Notes

- The two CLI shots use the default light terminal profile; the TUI shots
  use `--theme dark`.
- Tab switching between plain (non-agent) panes is not reachable through the
  palette today; the shots show switching via tab close and backend refocus.
- See [tui-shortcuts.md](tui-shortcuts.md) for the full key reference and
  [tui-screenshot-tour.md](ux/tui-screenshot-tour.md) for how the tour was
  produced and how to regenerate it.