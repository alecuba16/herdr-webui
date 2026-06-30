# herdr-webui

Standalone browser UI for an official Herdr backend session.

`herdr-webui` is not a Herdr fork and does not ship the Herdr terminal multiplexer. It connects to a running Herdr backend through Herdr's JSON API socket and terminal attach socket, then exposes workspaces, panels, agents, terminals, Git, and files in local web UI.

## Highlights

- Desktop and mobile UI with terminal attach, workspace navigation, agent status, Git, file browsing, and Git-to-file-explorer handoff.
- Desktop Git UI with status, diffs, commit, log, stash, blame, file history, conflict tools, branch switch, hunk actions, and guarded destructive operations.
- File explorer/editor backed by authenticated Rust routes with path safety, bounded backend search, hash guards, rename, delete, split panes, and shared file trees.
- CodeMirror 6 editor bundle loaded lazily for file editing, previews, syntax highlighting, and side-by-side hunk merge editing.
- Settings search, shortcut editor, theme colors, terminal font/scroll controls, browser notifications, no-sleep controls, and consistent squared rounded buttons.
- Backend-offloaded app state, Git metadata, file search, and file tree data to reduce browser CPU/RAM on large workspaces.
- Embedded assets: release binary contains frontend HTML/CSS/JS.

## Compatibility

| WebUI | Herdr | Protocol | Status | Notes |
| --- | --- | --- | --- | --- |
| `0.0.56` | `0.7.1+` | `14` | Current | Improves file explorer search/folder browsing, child lazy-load controls, Git branch switching UX, and Linux release test stability. |
| `0.0.55` | `0.7.1+` | `14` | Supported | Adds lazy-loaded file explorer trees with Git-to-Files target reveal, removing the fixed visible-entry cap while keeping scroll performance. |
| `0.0.54` | `0.7.1+` | `14` | Supported | Fixes Git panel rename status paths so unstaging/stash actions use the renamed file path instead of the `old -> new` display string. |
| `0.0.53` | `0.7.1+` | `14` | Supported | Expanded Rust coverage around Git UI, app-state helpers, service command runner, file-browser edge paths, and README coverage notes. |
| `0.0.52` | `0.7.1+` | `14` | Supported | Mobile file edit/save/rename/delete, mobile Git stage/unstage/stash/discard/commit actions, Git changed files open directly in Files, backend file search, improved mobile nav/worktree guard, configurable shortcuts, combined workspace/worktree browser, deep worktree discovery. |
| `0.0.51` | `0.7.1+` | `14` | Supported | Combined workspace/worktree browser, configurable deep worktree discovery, Settings search/UX refresh, squared rounded buttons, CodeMirror merge hunk editing, lazy assets, backend app-state/Git metadata, file explorer/editor. |
| `0.0.50` | `0.7.1+` | `14` | Supported | Settings search/UX refresh, squared rounded buttons, CodeMirror merge hunk editing, lazy assets, backend app-state/Git metadata, file explorer/editor. |
| `0.0.49` | `0.7.1` | `14` | Tested | File browser/editor, shared file trees, CodeMirror editing, large Git change-set placeholders, browser notifications, themed favicons, local snapshot versioning. |
| `0.0.46` | `0.7.1` | `14` | Tested | Configurable WebUI/Git prefix shortcuts, Git keyboard isolation, Rust coverage above 70%. |
| `0.0.45` | `0.7.0` | `14` | Minimum supported | Uses legacy worktree fallback when native existing-branch support is unavailable. |

Newer Herdr builds may work when protocol stays compatible. WebUI reports untested versions in `/api/versions`.

## Requirements

- Rust toolchain for local builds.
- Git CLI for Git and worktree features.
- Official Herdr binary available as `herdr` in `PATH`, or set `HERDR_WEB_HERDR_BIN`.

## Build

```sh
make build
```

Binary output:

```text
target/release/herdr-webui
```

Runtime version behavior:

- Local builds report `snapshot-<shortsha>`.
- GitHub Actions tag builds report release tag, for example `v0.0.56`.
- `Cargo.toml` keeps static package SemVer; runtime product version comes from `build.rs` and is exposed by `herdr-webui --version` and `/api/versions`.

## Run

Start Herdr separately:

```sh
herdr server
```

Run WebUI on loopback without login:

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

Named session:

```sh
target/release/herdr-webui --session work --bind 127.0.0.1:8787
```

When Herdr is offline, WebUI shows a session manager that can launch Herdr, retry connection, reset workspaces, or close the current session.

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

Use `--verbose`, `-v`, or `HERDR_WEB_VERBOSE=1` with macOS service commands to print LaunchAgent diagnostics.

## Install

Install as per-user macOS LaunchAgent:

```sh
make install-mac
```

Install as per-user Linux systemd service:

```sh
make install-linux
```

Release binaries can install themselves:

```sh
./herdr-webui install-mac
./herdr-webui install-linux
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

Run macOS LaunchAgent commands as normal user, not with `sudo`. LaunchAgents load into current user's `gui/$UID` domain; `sudo` targets root's domain and fails.

## Authentication

Server access settings live in `~/.config/herdr-webui/webui-settings.json` and can be edited from WebUI Settings:

- Bind address, for example `127.0.0.1:8787` or `0.0.0.0:8787`.
- Username.
- Password.
- Localhost auth bypass.
- No-sleep Auto cooldown.

Non-localhost binds require username and password. WebUI rejects `0.0.0.0` or other non-loopback binds until both credentials are configured.

## UI Overview

Desktop shell:

- Sidebar workspace/worktree tree, agent list, top panel tabs, terminal foreground, Git foreground, and Files foreground.
- Sidebar can collapse; collapsed view keeps compact agent counters.
- Header exposes Search, Theme, No-sleep, Worktree, New workspace, Git, and Files controls.
- Footer exposes current session, shortcut help, settings, and version info.
- Settings are grouped and searchable. Local settings include theme colors, terminal font, scroll speed, shortcuts, notifications, file tree indentation, Git limits, and file browser parent traversal.

Mobile shell:

- Mobile tabs for Agents, Worktrees, Terminal, Git, Files, and Settings.
- Terminal paste handling, file browsing, Git status, settings, and notifications are available without desktop layout.

Terminals:

- Terminal attach uses Herdr direct terminal attach protocol.
- Pasted multiline text is sanitized before reaching terminal input: newlines become spaces and trailing spaces are trimmed.
- Wheel scroll speed is configurable. Small trackpad deltas are accumulated to avoid overscrolling.
- Terminal font can use any locally installed CSS font family, including Nerd Fonts.

Search and shortcuts:

- Search palette opens from header button or configured prefix then `/`.
- Search is local over loaded workspaces, repos, worktrees, labels, panels, and agents.
- Global prefix shortcuts are configurable. Default prefix is `Ctrl+B`.
- Shortcut editor blocks duplicate WebUI/Git bindings and reports collisions.

## File Browser

- Desktop workspaces and linked worktrees open Files as foreground mode. Git, Files, and terminal modes are mutually exclusive.
- Rust routes under `/api/file-browser/*` list trees, read files, save files, rename entries, and delete files/folders.
- Backend canonicalizes paths and rejects traversal outside allowed roots unless parent-folder traversal is explicitly enabled.
- Search runs in Rust with result and visit limits, skips heavy directories such as `.git`, `node_modules`, `target`, `.venv`, `dist`, and `build`, and uses smart-case matching.
- Folders lazy-load and default collapsed. `...` row moves to parent.
- Text files can be previewed or edited. Saves use hash guard to avoid overwriting changed files.
- Shift-click or context-menu `Open in split` opens another split preview pane.
- Shared `HerdrFileTree` powers file explorer, Git changed-file tree, and directory pickers.
- Shared `HerdrEditor` lazily upgrades from fallback preview/textarea to CodeMirror.

## Git UI

- Desktop Git runs through Rust API routes and system `git`; no Node/React/Vite runtime is required.
- Mobile Git shows grouped status for selected workspace/worktree.
- Drawer covers status, staged/unstaged/untracked/conflicted files, commit, amend, log, stash, file history, blame, compare, conflict resolution, branch switch, reset, rebase, stage/unstage, discard, and hunk restore.
- Large change sets render lightweight file shells first; individual file diffs load on demand.
- Git endpoints precompute change counts, diff line counts, and editable hunk models.
- File lists use compact folder trees with line counts; Settings can switch to filename-only mode.
- Changed-file context menus can open the same path in Files without leaving the single-page app.
- Diffs support collapse, word highlights, context expansion, hunk actions, per-file blame, and side-by-side current/previous views.
- Hunk editing uses CodeMirror `MergeView`: previous side read-only, current side editable, then saved back with hash guard.
- Mutating/destructive operations require confirmation and validate paths/refs before running Git.
- When Git is visible, it owns keyboard input so terminal does not receive Git keystrokes.

## Worktrees And Panels

- Herdr `0.7.1+` native worktree creation is used for existing local branches and deferred Git work.
- Herdr `0.7.0` keeps legacy fallback for existing branch checkout when path is supplied.
- WebUI subscribes to worktree and pane lifecycle events and refreshes quickly after changes.
- Linked worktree cards use branch as title and optional custom label as chip.
- Agent rows prefer worktree custom label for easier scan across branches.
- Closing last panel closes workspace with Herdr `workspace.close`; non-last panels use `tab.close`.
- When Herdr reports `pane.exited`, WebUI closes pane and switches away after refresh.

## Architecture

- Rust server embeds all static frontend assets with `include_str!`.
- Desktop and mobile frontend are vanilla JS/CSS assets; no framework runtime is shipped.
- Desktop shell and Git UI are split into source modules and concatenated by `src/assets.rs`.
- CodeMirror bundle is generated from `src/assets/vendor/codemirror_entry.mjs` into checked-in `codemirror.bundle.js`.
- `/api/app-state` aggregates desktop refresh data to reduce request fan-out and repeated browser-side derivation.
- Git and file-browser backend routes do cheap view-model work in Rust so browser renders less and computes less.
- Service command execution is behind a small runner abstraction so macOS `launchctl` and Linux `systemctl` behavior is testable without invoking real services.
- Prefer backend JSON/view-model endpoints over HTMX/WASM/framework rewrites for heavy data paths. Terminal, editor, Git drawer, keyboard routing, and websocket lifecycle stay in explicit JavaScript controllers.

## Testing And Coverage

- Rust coverage is measured with `cargo llvm-cov --summary-only`.
- Current backend line coverage is about 85%; focused service/file-browser modules are near complete (`service.rs` about 99%, `file_browser.rs` about 99%).
- Remaining uncovered file-browser/service lines are mostly OS/filesystem race or platform branches that are intentionally not forced through destructive tests.
- JavaScript smoke tests use Node's native test runner and syntax checks for desktop/mobile bundles.

## Project Layout

```text
src/main.rs                         WebUI server, auth, API proxy, websockets, service commands
src/assets.rs                       Embedded asset routes and concatenation
src/file_browser.rs                 File browser API and path safety
src/git_ui.rs                       Git API routes, diff parsing, metadata models
src/protocol.rs                     Terminal attach wire protocol
src/service.rs                      macOS/Linux service helpers and injectable command runner
src/assets/app.html                 Static HTML shell
src/assets/desktop/app_js/          Desktop shell JS modules
src/assets/desktop/app_css/         Desktop shell CSS modules
src/assets/desktop/git_ui/          Git UI JS/CSS modules
src/assets/desktop/file_browser.*   Desktop file explorer
src/assets/mobile/                  Mobile UI modules
src/assets/shared/                  Shared frontend helpers, file tree, editor
src/assets/vendor/                  CodeMirror source entry and generated bundle
.github/workflows/                  CI and release workflows
Makefile                            Local build/run/install/update targets
```

## Troubleshooting

### `herdr rejected terminal connection: client version 14 is newer than server version 13; please upgrade the herdr server`

WebUI is using newer terminal attach protocol than running Herdr server process.

- Verify Herdr binary in `PATH`, or the binary set by `HERDR_WEB_HERDR_BIN`.
- Stop old Herdr sessions. Updating Herdr binary does not upgrade already-running session processes.
- Start Herdr again with updated binary.

### macOS blocks downloaded binary

Remove quarantine and make executable:

```sh
sudo xattr -d com.apple.quarantine herdr-webui
chmod +x herdr-webui
```

Run from directory containing downloaded binary, or pass full path.

## Release Policy

WebUI releases use `v0.0.x` tags and GitHub Release notes. Root Herdr releases are not produced by this repository.
