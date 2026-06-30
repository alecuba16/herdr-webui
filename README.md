# Herdr WebUI

Standalone browser UI for an official Herdr backend session.

`herdr-webui` is not a Herdr fork and does not ship the Herdr terminal multiplexer. It connects to a running Herdr backend through Herdr's JSON API socket and direct terminal attach socket, then exposes workspace navigation, agent status, and terminal attach in a local web app.

## Requirements

- Rust toolchain for local builds.
- Git CLI for worktree features.
- Official Herdr binary available as `herdr` in `PATH`, or set `HERDR_WEB_HERDR_BIN`.

Compatibility:

| WebUI | Herdr | Protocol | Status | Notes |
| --- | --- | --- | --- | --- |
| `0.1.0` | `0.7.1` | `14` | Current | Unifies workspace/worktree opening, enriches workspace cwd metadata from backend pane data, restores Settings search, and reduces browser CPU/memory load for terminal output, large paste, no-sleep polling, and large Git diffs. |
| `0.0.57` | `0.7.1` | `14` | Tested | Fixes worktree creation source handling, adds optional base-branch pull, improves worktree deletion, Git directory loading, directory picker navigation, and terminal scroll follow controls. |
| `0.0.49` | `0.7.1` | `14` | Tested | Adds file browser/editor, shared file trees, CodeMirror editing, large Git change-set placeholders, browser notifications, themed favicons, and local snapshot versioning. |
| `0.0.46` | `0.7.1` | `14` | Tested | Adds configurable WebUI/Git prefix shortcuts, keeps Git drawer keyboard input isolated, and raises Rust line coverage above 70%. |
| `0.0.45` | `0.7.1` | `14` | Tested | Improves embedded Git UI navigation with Escape handling, all-changes return behavior, split frontend assets, scoped file history controls, keyboard-owned drawer input, and per-file large diff loading. |
| `0.0.45` | `0.7.0` | `14` | Minimum supported | Uses WebUI's legacy existing-branch worktree fallback when needed. |

Newer Herdr builds may work when protocol stays compatible, but WebUI reports them as untested.

## Build

```sh
make build
```

Binary output:

```text
target/release/herdr-webui
```

Runtime version:

- Local builds report `snapshot-<shortsha>`.
- GitHub Actions tag builds report the release tag.
- `Cargo.toml` keeps the next static WebUI SemVer for package metadata; product version still comes from `build.rs` and is exposed by `herdr-webui --version` and `/api/versions`.

## Run Locally

Start Herdr separately:

```sh
herdr server
```

Run WebUI without login on loopback:

```sh
make run-web-local
```

Open:

```text
http://127.0.0.1:8787
```

Use a specific Herdr binary when WebUI launches backend sessions:

```sh
HERDR_WEB_HERDR_BIN=/opt/homebrew/bin/herdr make run-web-local
```

## CLI

```text
herdr-webui [--verbose] [--bind HOST:PORT] [--session NAME] [--api-socket PATH] [--client-socket PATH]
herdr-webui --version
herdr-webui install-mac [--verbose] [--bind HOST:PORT] [--session NAME]
herdr-webui update-mac [--verbose]
herdr-webui install-linux [--bind HOST:PORT] [--session NAME]
herdr-webui update-linux
herdr-webui start-mac | start [--verbose]
herdr-webui stop-mac | stop [--verbose]
herdr-webui restart-mac | restart [--verbose]
herdr-webui start-linux | start
herdr-webui stop-linux | stop
herdr-webui restart-linux | restart
herdr-webui uninstall-mac [--verbose]
herdr-webui uninstall-linux
```

Use `--verbose`, `-v`, or `HERDR_WEB_VERBOSE=1` with macOS service commands to print LaunchAgent diagnostics, including UID/EUID, launchctl domain, service target, plist path, and launchctl stderr.

## Project Layout

- `Cargo.toml`: Rust crate manifest for `herdr-webui`.
- `src/main.rs`: WebUI server, auth, JSON proxy, WebSockets, terminal bridge, install helpers.
- `src/assets.rs`: embedded frontend asset responses.
- `src/compat.rs`: backend compatibility checks.
- `src/file_browser.rs`: authenticated file-browser API for trees, file read/write, rename, and delete.
- `src/protocol.rs`: Herdr direct terminal attach wire types and frame codec.
- `src/service.rs`: OS service helpers.
- `src/assets/`: embedded HTML/CSS/JS and frontend tests.
- `src/assets/desktop/`: desktop UI bundle chunks and desktop-only CSS.
- `src/assets/desktop/app_css/`: desktop shell CSS modules concatenated into `/assets/desktop/app.css`.
- `src/assets/desktop/app_js/`: desktop shell JS modules concatenated into `/assets/desktop/app.js`.
- `src/assets/desktop/file_browser.js` and `src/assets/desktop/file_browser.css`: desktop file explorer and editor shell.
- `src/assets/desktop/git_ui/`: embedded Git UI modules for settings, syntax highlighting, log actions, drawer shell CSS, diff CSS, log CSS, and layout CSS.
- `src/assets/icons/`: SVG icons served as static assets and referenced from CSS/markup.
- `src/assets/mobile/`: mobile UI bundle chunks and mobile-only CSS.
- `src/assets/shared/`: browser helpers shared by desktop and mobile bundles.
- `src/assets/shared/file_tree.js` and `src/assets/shared/editor.js`: shared file-tree renderer and lightweight editor abstraction.
- `src/assets/vendor/codemirror_entry.mjs`: CodeMirror bundle source entry; `src/assets/vendor/codemirror.bundle.js` is the checked-in generated browser bundle.
- `.github/workflows/webui-ci.yml`: WebUI CI.
- `.github/workflows/webui-release.yml`: WebUI release builds for `v0.0.*` tags.
- `Makefile`: local build, run, install, update, uninstall commands.

The Rust binary embeds frontend assets with `include_str!`, so release artifacts do not need external static files next to the binary.

## Frontend Notes

- Desktop and mobile UI are embedded vanilla HTML/CSS/JS assets. The main shell has no frontend build step; the optional CodeMirror editor bundle is generated from `src/assets/vendor/codemirror_entry.mjs` and checked in.
- Desktop shell and Git UI assets are split into plain JS/CSS modules and concatenated by `src/assets.rs`; public URLs stay `/assets/desktop/app.js`, `/assets/desktop/app.css`, `/assets/desktop/git-ui.js`, and `/assets/desktop/git-ui.css`.
- Desktop terminal output is frame-batched in the browser so bursts of WebSocket terminal frames are coalesced before xterm rendering. Pending frames are flushed before reconnect or close to avoid dropping final output.
- Large terminal paste input is chunked with WebSocket backpressure instead of being sent as one very large browser frame.
- Prefer moving behavior out of inline handlers into delegated JS listeners and shared CSS classes when touching UI code.
- SVG icons should live under `src/assets/icons/` and be referenced from CSS or markup, not embedded inline in JS templates.

TODO:

- Evaluate a small progressive templating layer, with `petite-vue` as the leading option, to reduce inline JavaScript and string-template complexity.
- Keep the migration incremental if adopted: start with isolated islands such as settings, modals, sidebar workspace rows, and Git file lists.
- Avoid adding a heavier framework unless it removes more code than it adds. `jQuery` is not expected to help much here because the main pain is templating/state, not DOM selection.

## Authentication

Server access settings are stored in `~/.config/herdr-webui/webui-settings.json` and can be edited from WebUI Settings:

- Bind address, for example `127.0.0.1:8787` or `0.0.0.0:8787`.
- Username.
- Password.
- Localhost auth bypass.
- No-sleep Auto cooldown.

Non-localhost binds require both username and password. WebUI rejects `0.0.0.0` or any other non-loopback bind until both credentials are configured.

## Sessions

By default, WebUI targets Herdr's default session sockets.

Use a named session:

```sh
target/release/herdr-webui --session work --bind 127.0.0.1:8787
```

When Herdr is offline, WebUI shows a session manager. It can launch Herdr using `HERDR_WEB_HERDR_BIN` or `herdr` from `PATH`, retry connection, reset workspaces, or close the current Herdr session.

If `--session NAME` is supplied, launched Herdr processes receive `HERDR_SESSION=NAME`.

## WebUI Features

The browser UI provides workspace navigation, top panel tabs, agent status, terminal attach, Git views, file browsing/editing, and local-only convenience settings stored in browser storage.

Sidebar:

- Use the vertical divider between the sidebar and terminal to hide or show the workspace/agents sidebar.
- The collapsed state is stored in browser `localStorage`.
- When collapsed, the sidebar shows compact agent counters for blocked, working, idle, and done agents.
- The header exposes compact Search, Theme, No-sleep, Worktree, New workspace, Git, and Files controls.
- The footer shows the Herdr brand, current session, shortcut help, and settings.
- Theme colors are browser-local and expose shared accent variables used by shell controls and the embedded Git UI.
- No-sleep supports Off, Auto, 1 hour, 2 hours, 4 hours, and Infinite from a compact dropdown.
- No-sleep status polling is adaptive: WebUI does not keep polling while no-sleep is Off and the server is healthy. Active modes and transient errors still retry so the control stays accurate without idle browser/network churn.

Settings:

- The Settings modal includes a `Search settings` field in the header.
- Settings search filters grouped settings sections and individual option rows locally in the browser.
- Opening Settings clears the previous search, refreshes option values, reloads server settings, and focuses the search box.

Panels:

- The selected workspace or worktree is pinned at the top of the workspace list.
- The selected row includes compact actions for worktree creation, opening, closing, and removal.
- The current panel selector lives inside the selected workspace/worktree row and supports switching panels, creating a panel, renaming a panel, and closing a panel.
- WebUI subscribes to `pane.closed`, `pane.exited`, and `tab.closed`, clears stale terminal selection immediately, and auto-closes exited panes before switching to the next available panel.

Worktrees:

- With Herdr `0.7.1` and newer, WebUI uses Herdr's native `worktree.create` support for existing local branches and deferred Git work.
- With Herdr `0.7.0`, WebUI keeps a legacy fallback for creating a checkout from an existing branch when a checkout path is supplied.
- WebUI subscribes to `worktree.created`, `worktree.opened`, and `worktree.removed` and refreshes workspace/agent state quickly after these events.
- `worktree.removed` events from Herdr `0.7.1` may include a workspace snapshot. This is additive; WebUI refreshes from the backend state instead of relying only on the event payload.
- Linked worktree cards use the branch name as the main title and show a custom worktree label as a small label chip when one exists.
- Agent rows prefer the linked worktree custom label, so running agents are easier to scan across many branches.
- Worktree groups avoid duplicate repo headers when the parent workspace card is already visible.
- Removing a linked worktree is available from the worktree actions and from the keyboard prefix `Delete` shortcut.

File browser:

- Desktop workspaces and linked worktrees include a file explorer opened from the sidebar Files button. Git, Files, and terminal views are mutually exclusive foreground modes.
- The desktop explorer uses the authenticated `/api/file-browser/*` routes to list files, preview text files, edit and save files with a hash guard, rename entries, and delete files or folders with confirmation.
- Folders are lazy-loaded and default collapsed. Double-click a folder to enter it as the current root. The `...` row goes to the parent within the current browser root.
- Enable `File browser parent folders` in Settings to allow the `...` row at the workspace/worktree root to move above that directory.
- Single-clicking a file opens it by replacing the currently selected preview pane. Shift-click or right-click `Open in split` opens another split pane.
- File preview panes include close buttons. Closing a dirty edited file asks for confirmation.
- Right-click a file or folder for contextual actions: open, open in split, enter folder, rename, delete, and copy path.
- File tree indentation is configurable with `Tree indentation` in Settings and is shared with Git file trees.
- Mobile includes a Files tab for browsing and previewing files.

Git UI:

- Desktop workspaces and linked worktrees include an embedded Git drawer opened from the sidebar Git button.
- Mobile includes a Git tab for the selected workspace or worktree with grouped status lists.
- The desktop drawer is embedded in the WebUI binary; it uses the system `git` CLI through Rust API routes and does not require a separate Node, React, or Vite runtime.
- When the drawer is hidden, WebUI blanks the drawer DOM and invalidates pending renders to reduce browser work.
- The drawer shows worktree actions, grouped file status, staged/unstaged/untracked/conflicted files, commit form, log, stash list, file history, conflicts, blame, hunk editing, and side-by-side diffs.
- File lists are shown as a collapsible folder tree with file-level line counts. Settings can switch the file list to filename-only mode with the full path in the tooltip.
- Right-click a file for actions such as stash, discard, stage, or unstage. Section-level bulk actions stage or unstage grouped files with confirmation.
- Commit drafts are stored in browser `localStorage` per workspace/worktree/ref.
- Large diffs are protected by browser-local Git UI limits. In large change sets, the all-changes view shows GitHub-like file shells and each file body has a `Load diff` button that fetches that file on demand. Individual files over 500 diff lines also show a per-file `Load diff` placeholder. In selected-file view, the configured line limit can still hide very large renders until you explicitly load them. After explicit load, very large files render a safe preview of complete change groups first and offer `Render full diff` for the complete DOM-heavy view. Set the line-limit setting to `0` to disable the selected-file line limit.
- Hunk stage/unstage and block restore actions are disabled in large-diff preview mode so hidden lines are not mutated accidentally. Render the full diff to enable those actions.
- Diffs support per-file collapse, collapse/show all, visual change grouping, inline word highlights, context expansion, hunk stage/unstage/restore actions, and per-file blame from the Changes file view.
- Syntax highlighting is embedded and modular for common project files including JSON, YAML, Python, Java, Rust, Go, JavaScript, TypeScript, CSS, Kotlin, shell, Makefiles, and HTML.
- Side-by-side hunk editing lets you edit current hunk text, save back to the working tree with a hash guard, and refresh the diff.
- The branch pill opens a branch switch modal. Remote branch selection creates a local branch from the remote base.
- The log view supports click commit selection and shift-click two-commit comparison. Select one commit to compare it with current working-tree changes, reset soft/hard, or rebase commits after the selected commit onto `main`/`master`.
- File history can show a read-only temporary commit diff or jump to the matching commit in the log.
- When the desktop Git drawer is visible, it owns keyboard input so keystrokes are not sent to the background terminal. `Esc` returns from nested Git views to the all-changes list; on the all-changes list it asks before hiding Git UI; in the commit editor it asks before leaving and saves the draft locally.
- The shortcuts window includes an editor for WebUI and Git prefix shortcuts. Recording a shortcut that duplicates another WebUI or Git shortcut is blocked and reported.
- Desktop Git shortcuts use the same configured WebUI prefix (`Ctrl+B` by default) while the drawer is focused. Defaults avoid the global WebUI prefix keys: prefix then `1` changes list, `2`/`C` commit, `3`/`L` log, `4` stash, `R` refresh, `G` stage or unstage all, `Y` stage focused/selected file, `U` unstage focused/selected file, `D` discard focused/selected file, `Z` stash focused/selected file, `H` selected-file history, `M` selected-file blame, `E` edit selected file, `O` current compare, `V` branch switch, `I` focus file list, `0` show Git shortcut help. `Enter` or `Space` activate focused file and folder rows without prefix.
- Stashes can be listed, applied, popped, dropped with confirmation, or created from all changes or a single file.
- Mutating/destructive operations are guarded: discard, hard reset, rebase, stash drop, and section bulk changes require confirmation; backend paths and refs are validated before running Git.
- Git API routes cover status, diff, compare, branches, log, blame, file read/write, file history, stashes, conflicts, stage, unstage, discard, stash, switch, reset, rebase, commit, apply-patch, and conflict actions.

Panel and workspace close:

- Closing the last panel in a workspace closes the workspace with Herdr's `workspace.close` API instead of calling `tab.close`, because Herdr rejects closing the last tab.
- Closing a workspace or linked worktree uses `workspace.close` to close all panels in that workspace.
- Closing a normal non-last panel still uses `tab.close`.
- When Herdr reports `pane.exited`, WebUI closes that pane through Herdr's `pane.close` API and switches away from it after refresh.

Panel tab activity:

- Enable `Show panel last update` in Settings under `Agents and alerts`.
- When enabled, top panel tabs show the last WebUI-observed update age next to the tab label.
- Activity is tracked locally in the browser from tab, pane, and agent list changes.
- Labels use coarse buckets to avoid constant recalculation: `<1m`, exact minute values such as `5m ago`, `>1h`, and `>1d`.
- WebUI does not poll a timer to update these labels continuously. Labels refresh when WebUI renders after normal refreshes or Herdr events.
- The timestamp is not persisted by Herdr and is not a backend audit timestamp. Reloading the page starts local tracking again.

Agent sorting:

- Configure in Settings under `Agents and alerts` with the `Agent sorting` dropdown.
- `Default order` shows agents in Herdr's natural order.
- `Attention (blocked first)` sorts blocked agents first, then idle agents, done agents, unknown agents, ignored working agents, and working agents.
- `Attention (working first)` keeps blocked agents first, then working agents, ignored working agents, unknown agents, and done/idle agents.

Stuck working agents:

- Enable `Ignore stuck working agents` in Settings under `Agents and alerts`.
- When enabled, working agents that appear stuck can be locally dismissed with a `Dismiss` button.
- Dismissed agents show as `ignored` and do not trigger attention sounds.
- Dismissals clear automatically when Herdr reports a status change via `pane.agent_status_changed` events, or after a configurable timeout (`Ignore stuck working for` minutes).
- Dismissals are stored in browser `localStorage` and are local-only overrides, not backend truth mutations.

Parent workspace close with linked worktrees:

- Configure in Settings under `Agents and alerts` with the `Parent workspace close` dropdown.
- `Close panels only` (default): closes all panes in the parent workspace via the Herdr API. Linked worktrees keep running. The last pane is blocked by Herdr's confirmation guard, so the parent workspace stays with an idle shell.
- `Full close + re-open worktrees`: closes the parent workspace entirely. Herdr cascades the close to all linked worktrees, stopping their processes. WebUI then re-opens each linked worktree via the `worktree.open` API. Re-opened worktrees start with fresh shells; running processes are lost.

Terminal paste:

- Pasted text is sanitized before reaching the terminal. Newlines (`\r\n`, `\r`, `\n`) are converted to spaces, and trailing spaces are trimmed.
- This prevents pasted multiline text from auto-submitting terminal input via implicit Enter.
- Both desktop and mobile terminals capture paste events in the capture phase before xterm or native handlers process them.
- Desktop paste sends small input directly and chunks larger paste payloads into bounded frames with WebSocket backpressure, reducing browser main-thread stalls from large clipboard pastes.

Terminal rendering performance:

- Desktop terminal output from Herdr is queued and coalesced once per animation frame before being written to xterm.
- This reduces CPU use for rapid terminal refresh workloads, spinner-like carriage-return updates, and command output bursts.
- Browser scroll-follow state and terminal resize/focus work are also scheduled with the terminal frame batch instead of every raw WebSocket message.

Terminal scroll:

- Wheel scroll speed is configurable in Settings under `Terminal input` with the `Scroll speed` slider.
- Small trackpad wheel deltas are accumulated before sending scroll commands, preventing tiny events from each scrolling a full line batch.
- In normal terminal scrollback, scrolling up pauses follow mode and keeps the same viewport position even when new output arrives.
- When follow mode is paused, a `Tail` button appears. Clicking it scrolls to the latest output and re-enables follow mode.
- Mobile terminal uses the same scrollback follow behavior and `Tail` button as desktop.
- In alternate-screen terminal apps, wheel and PageUp/PageDown scroll events are sent to the backend terminal application instead of local browser scrollback.

Terminal font:

- Configure in Settings under `Terminal input` with `Terminal font`.
- Use any installed CSS font family, including Nerd Fonts commonly used by Neovim, for example `JetBrainsMono Nerd Font, monospace` or `MesloLGS NF, monospace`.
- Browsers can only render fonts installed on the local machine.

Search palette:

- Open search from the top-right `⌕` button or with the keyboard prefix then `/`.
- Search is local and in-memory over currently loaded workspaces, repos, worktrees, labels, panels, and agents.
- Results include workspace (`ws`), worktree (`wt`), panel (`pn`), and agent (`ag`) entries.
- Use `Enter` to open the selected result, arrow keys to move selection, and `Esc` to close.
- Search result navigation always targets a concrete panel when one is available.

Keyboard shortcuts:

- Enable or disable from Settings under `Agents and alerts` with `Global keyboard shortcuts`.
- Press configured prefix (`Ctrl+B` by default) to open the WebUI shortcut prefix overlay. The next shortcut key is handled by WebUI and not sent to the terminal; `Esc` cancels.
- Change the prefix in Settings with `Shortcut prefix` → `Record`.
- Prefix shortcuts work from the terminal and UI and can be remapped from the shortcuts window with collision detection. Defaults are: prefix then `/` search, `?` shortcuts help, `S` settings, `B` sidebar, `N` new workspace, `P` new panel, `W` worktrees, `T` create worktree, `X` close panel, `Shift+X` close workspace/worktree, `Delete`/`Backspace` remove linked worktree, `A` next agent by blocked/done/idle/working priority, `Shift+A` previous agent by reverse priority, `J/K` workspace navigation, `[/]` panel navigation, `F` terminal focus, and `,/.` focus navigation.
- Optional direct search shortcuts can be configured in Settings. They are disabled by default to avoid conflicts with terminal applications.

## Install

Install as a per-user macOS LaunchAgent:

```sh
make install-mac
```

Run macOS LaunchAgent commands as your normal user, not with `sudo`. LaunchAgents load into the current user's `gui/$UID` launchctl domain; running with `sudo` targets root's domain and is rejected.

Install as a per-user Linux systemd service:

```sh
make install-linux
```

Release binaries can install themselves too:

```sh
./herdr-webui install-mac
./herdr-webui install-linux
```

For macOS service troubleshooting:

```sh
./herdr-webui install-mac --verbose
./herdr-webui uninstall-mac --verbose
```

Update installed binary and restart service:

```sh
make update-mac
make update-linux
```

Uninstall service:

```sh
make uninstall-mac
make uninstall-linux
```

## FAQ

### `herdr rejected terminal connection: client version 14 is newer than server version 13; please upgrade the herdr server`

This means WebUI is using a newer terminal attach protocol than the Herdr server process handling the session.

Check two things:

- Verify the `herdr` binary version in `PATH`, or the binary set through `HERDR_WEB_HERDR_BIN`.
- Make sure old Herdr server sessions are not still running. Updating the `herdr` binary does not upgrade already-running session processes; close all running Herdr sessions, then start them again with the updated binary.

### macOS blocks the downloaded binary

If macOS blocks the release binary because it was downloaded from the internet, remove the quarantine attribute and make it executable:

```sh
sudo xattr -d com.apple.quarantine herdr-webui
chmod +x herdr-webui
```

Run those commands from the directory containing the downloaded `herdr-webui` binary, or pass the full path to the file.

## Release Policy

WebUI releases use `v0.0.x` tags and GitHub Release notes. Root Herdr releases are not produced by this repository.
