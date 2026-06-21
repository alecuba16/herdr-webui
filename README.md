# Herdr WebUI

Standalone browser UI for an existing Herdr backend session.

This project builds a separate `herdr-webui` binary. It does not replace the upstream `herdr` binary and it does not run a terminal multiplexer by itself. Instead, it connects to Herdr's existing JSON API socket and client terminal socket, then exposes workspace navigation, agent status, and terminal attach through a local web app.

## What It Does

- Shows Herdr workspaces, worktrees, tabs, panes, and agents in a browser.
- Attaches the selected pane terminal using xterm.js.
- Shows workspace and agent status with compact visual indicators.
- Supports session, workspace, tab, and pane navigation through browser URLs.
- Supports inline rename for workspaces and tabs with double-click, Enter to save, and Escape to cancel.
- Supports creating and closing workspaces, tabs, and panels.
- Supports creating, grouping, and removing linked Git worktrees.
- Supports shared drag-and-drop workspace ordering through the WebUI process.
- Supports attention-based workspace and agent sorting.
- Supports browser-local terminal scroll speed, theme, sizing, and key-sequence settings.
- Supports runtime server access settings for bind address, username, password, and localhost auth bypass.
- Supports backend-managed no-sleep mode so the machine running WebUI/Herdr can stay awake for timed or unlimited sessions.
- Supports configurable agent notification sound scope.
- Provides a session manager when the Herdr backend is offline.
- Can launch a Herdr backend process for the configured session.
- Provides optional browser notifications through agent attention sounds.
- Can run from macOS LaunchAgent or Linux systemd user service.

## How It Works

`herdr-webui` has three layers:

- HTTP server: serves the HTML/CSS/JS app, auth routes, static vendored xterm assets, and JSON proxy endpoints.
- Herdr JSON API proxy: talks to Herdr over its existing API socket for workspace, tab, pane, agent, version, and mutation requests.
- Terminal WebSocket bridge: accepts browser WebSocket connections and forwards terminal input/output to Herdr's existing direct terminal attach protocol.

Browser state is URL-owned:

- `/session/default`
- `/session/:session`
- `/session/:session/workspace/:workspace_id`
- `/session/:session/workspace/:workspace_id/tab/:compact_tab_id`
- `/session/:session/workspace/:workspace_id/tab/:compact_tab_id/pane/:compact_pane_id`

Changing selection in the browser updates the URL. Browser back/forward restores the selected session, workspace, tab, and pane. The WebUI intentionally avoids calling Herdr's global workspace focus action on navigation, so multiple browser tabs can inspect different Herdr areas without fighting each other.

Tab and pane IDs in URLs are compact route IDs, such as `t1` and `p1`. Internally, WebUI expands them to Herdr backend IDs such as `w3:t1` and `w3:p1`.

Workspace, agent, and panel rows are real browser links. Normal click uses WebUI single-page navigation. Cmd/Ctrl-click, Shift-click, and middle-click use browser-native tab behavior. Links use a named target so the browser can reuse a selection tab when it chooses to, but browsers do not allow WebUI to force focus to an existing arbitrary tab.

## Project Layout

- `webui/src/main.rs`: WebUI server, auth, JSON proxy, WebSockets, embedded HTML/CSS/JS, terminal bridge, and macOS-facing behavior.
- `webui/Cargo.toml`: standalone Rust crate for `herdr-webui`.
- `Cargo.toml`: root Herdr crate used for backend-compatible types, server code, and release build output.
- `src/`: root Herdr application, API schema, worktree helpers, terminal/input integration, and tests.
- `src/worktree.rs`: shared worktree path, listing, command, and branch-detection helpers.
- `src/app/api/worktrees.rs`: Herdr JSON API worktree list/create/open/remove handlers.
- `src/app/worktrees.rs`: TUI worktree modal and create/open flow.
- `webui/src/assets/app.html`: main WebUI HTML shell.
- `webui/src/assets/app_core.js`: DOM-free frontend core helpers shared by browser code and Node tests.
- `webui/src/assets/app_core.test.mjs`: Node built-in test runner coverage for pure frontend helpers; no browser automation required.
- `webui/src/assets/app_load.test.mjs`: Node VM smoke test that loads production frontend scripts and catches startup-order regressions without browser automation.
- `webui/src/assets/app.css`: main WebUI styles.
- `webui/src/assets/app.js`: main WebUI browser logic.
- `webui/src/assets/login.html`: login page HTML.
- `webui/src/assets/login.css`: login page styles.
- `webui/src/assets/login.js`: login page logic.
- `webui/src/assets/xterm.min.js`: vendored xterm.js runtime.
- `webui/src/assets/xterm.css`: vendored xterm styles.
- `webui/src/assets/herdr-logo.svg`: favicon served by the WebUI.
- `Makefile`: build, run, install, update, and uninstall commands.
- `plan.md`: original implementation plan and design goals.
- `target/`: release/debug build output shared by root and WebUI crates.
- `webui/target/`: generated Cargo build output when WebUI crate is built with its own target dir; do not commit it.

The Rust binary embeds the frontend assets with `include_str!`, so release artifacts do not need external static files next to the binary.

## Quick Start

Prerequisites:

- Rust toolchain.
- Git CLI.
- Herdr backend binary available as `herdr` in `PATH`, or set `HERDR_WEB_HERDR_BIN`.
- Zig `0.15.x` for the root Herdr crate build. The Makefile first tries `./zigbin/zig`, then common `zig@0.15` locations, then `zig` from `PATH`.

Build both root Herdr crate and WebUI crate:

```sh
make build
```

Run local development server without login on loopback:

```sh
make run-web-local
```

Open:

```text
http://127.0.0.1:8787
```

Default server access settings are created on disk when no settings file exists:

- Bind address: `127.0.0.1:8787`.
- Username: blank.
- Password: blank.
- Localhost auth bypass: enabled, so loopback requests do not need login by default.

Server access settings can be changed from WebUI Settings. They are saved to:

```text
~/.config/herdr-webui/webui-settings.json
```

With `XDG_CONFIG_HOME` set, the file is:

```text
$XDG_CONFIG_HOME/herdr-webui/webui-settings.json
```

If the settings file already exists but is missing newer keys, WebUI keeps existing values and writes the missing keys with defaults.

If Herdr backend is not running, open the session manager and launch it, or start it separately:

```sh
herdr server
```

Use a specific Herdr binary for launched sessions:

```sh
HERDR_WEB_HERDR_BIN=/opt/homebrew/bin/herdr make run-web-local
```

## Build

```sh
make build
```

Binary output:

```sh
target/release/herdr-webui
```

## Run Locally

Run locally:

```sh
make run-web-local
```

Equivalent direct command:

```sh
target/release/herdr-webui --bind 127.0.0.1:8787
```

Then open:

```text
http://127.0.0.1:8787
```

CLI options:

```text
herdr-webui [--bind HOST:PORT] [--session NAME] [--api-socket PATH] [--client-socket PATH]
herdr-webui --version
herdr-webui install-mac [--bind HOST:PORT] [--session NAME]
herdr-webui update-mac
herdr-webui install-linux [--bind HOST:PORT] [--session NAME]
herdr-webui update-linux
herdr-webui start-mac | start
herdr-webui stop-mac | stop
herdr-webui restart-mac | restart
herdr-webui start-linux | start
herdr-webui stop-linux | stop
herdr-webui restart-linux | restart
herdr-webui uninstall-mac
herdr-webui uninstall-linux
```

## Authentication

Server access settings are stored in `~/.config/herdr-webui/webui-settings.json` and can be edited from WebUI Settings:

- Bind address, for example `127.0.0.1:8787` or `0.0.0.0:8787`.
- Username.
- Password.
- Localhost auth bypass.

Defaults when the file does not exist:

- Bind address: `127.0.0.1:8787`.
- Username: blank.
- Password: blank.
- Localhost auth bypass: enabled.

Non-localhost binds require both username and password. WebUI rejects `0.0.0.0` or any other non-loopback bind until both credentials are configured.

To expose the server on all interfaces:

1. Open Settings.
2. Set `Bind address` to `0.0.0.0:8787`.
3. Set a username and password.
4. Press `Apply server settings`.
5. Open the WebUI from another machine using `http://HOST_IP:8787`.

Changing the bind address restarts the WebUI HTTP listener in the same process. If you move from `127.0.0.1` to `0.0.0.0`, reload the browser using the externally reachable address.

The settings API intentionally does not expose the saved password value. Leaving the Password field blank in Settings keeps the current password.

Environment variable:

- `HERDR_WEB_HERDR_BIN`: Herdr backend binary used when WebUI launches a session.

## Sessions

By default, WebUI targets Herdr's default session sockets.

Use a named session:

```sh
target/release/herdr-webui --session work --bind 127.0.0.1:8787
```

When Herdr is offline, the WebUI shows a session manager. It can:

- Launch Herdr using `HERDR_WEB_HERDR_BIN` or `herdr` from `PATH`.
- Retry connection.
- Reset workspaces.
- Close the current Herdr session.

If `--session NAME` is supplied, launched Herdr processes receive `HERDR_SESSION=NAME`.

## macOS Install

Install as per-user LaunchAgent:

```sh
make install-mac
```

Release binaries can install themselves too:

```sh
./herdr-webui install-mac
```

This does three things:

- Builds release binary.
- Installs binary to `~/.local/bin/herdr-webui`.
- Writes LaunchAgent plist to `~/Library/LaunchAgents/herdr-web.plist`.

Logs are written to:

```text
~/Library/Logs/herdr-webui/stdout.log
~/Library/Logs/herdr-webui/stderr.log
```

Update installed binary and restart LaunchAgent:

```sh
make update-mac
```

Or from a downloaded release binary:

```sh
./herdr-webui update-mac
```

`update-mac` copies the current binary to `~/.local/bin/herdr-webui` and restarts the LaunchAgent. It does not overwrite `~/.config/herdr-webui/webui-settings.json`. If a newer binary needs additional settings keys, WebUI keeps existing values and writes missing keys with defaults on startup.

Control the installed LaunchAgent without replacing the binary:

```sh
herdr-webui start
herdr-webui stop
herdr-webui restart
```

Explicit macOS command names are also available:

```sh
herdr-webui start-mac
herdr-webui stop-mac
herdr-webui restart-mac
```

Uninstall LaunchAgent:

```sh
make uninstall-mac
```

Or:

```sh
./herdr-webui uninstall-mac
```

`~/.local/bin` does not need to be in `PATH` for LaunchAgent to work because the plist uses the full binary path. If it is not in shell `PATH`, `make install-mac` prints a note.

## Linux Install

Install as a per-user systemd service:

```sh
make install-linux
```

Release binaries can install themselves too:

```sh
./herdr-webui install-linux
```

This does three things:

- Installs binary to `~/.local/bin/herdr-webui`.
- Writes user service to `~/.config/systemd/user/herdr-web.service`.
- Runs `systemctl --user daemon-reload` and enables/starts `herdr-web.service`.

Update installed binary and restart the user service:

```sh
make update-linux
```

Or from a downloaded release binary:

```sh
./herdr-webui update-linux
```

`update-linux` copies the current binary to `~/.local/bin/herdr-webui`, reloads the user systemd daemon, and restarts `herdr-web.service`. It does not overwrite `~/.config/herdr-webui/webui-settings.json`; missing config keys are backfilled with defaults on startup.

Control the installed Linux service without replacing the binary:

```sh
herdr-webui start-linux
herdr-webui stop-linux
herdr-webui restart-linux
```

On Linux, aliases `start`, `stop`, and `restart` target the Linux user service. On macOS, those same aliases target the LaunchAgent.

Uninstall the Linux user service:

```sh
make uninstall-linux
```

Or:

```sh
./herdr-webui uninstall-linux
```

## UI Behavior

### Sidebar

The sidebar shows workspaces and worktrees first, then an `Agents` section. The two sections split sidebar height and scroll independently.

Worktrees are grouped by repo:

```text
Repo
  Worktree 1
  Worktree 2
```

Agent rows show status, source workspace/worktree, tab when useful, and agent name.

Main repo rows expose a `♧+` action to create a linked worktree. Linked worktree rows expose only a danger `✕` action to remove and close that worktree.

Destructive actions include the target name in the confirmation prompt:

- Workspace close: `Close workspace "name - branch"?`
- Worktree remove: `Remove and close worktree "name - branch"?`
- Panel close: `Close panel "workspace/worktree - panel"?`

### Worktree Creation

The Worktrees modal can discover an existing repo or a directory containing linked worktrees. Enter a repo path in `Repo or worktrees folder`, then WebUI lists existing linked worktrees and exposes a create form.

The create form has:

- Branch name.
- Base branch.
- Optional label.
- Checkout path.

Behavior:

- Selecting a non-default base branch pre-fills Branch name with that branch.
- Selecting `main` or `master` leaves Branch name blank unless generated names are enabled.
- Checkout path auto-fills from default worktree directory, repo name, and branch slug.
- Manual Checkout path edits are preserved.
- Default worktree directory is browser-local and defaults to `../worktrees`; relative paths resolve from repo root.
- Path suggestions are shown through the browser dropdown for `Repo or worktrees folder`.
- Typing a path updates only suggestions and schedules discovery; it does not clear the create form.
- The existing worktree list and create section update after discovery completes, not on every keystroke.
- Branch suggestions refresh only when the discovered source repo changes.
- The Refresh button rediscovers the current path without wiping Branch name, Label, or Checkout path.
- Existing local branch names are allowed. WebUI checks whether the branch is already checked out in any worktree. If not checked out, it creates the worktree with `git worktree add <path> <branch>`.
- New branches use `git worktree add -b <branch> <path> <base>`.
- After Git creates the checkout, WebUI asks Herdr backend to open the new path.

Close behavior:

- Press `X` or `Escape` to close the Worktrees modal.
- Clicking outside the Worktrees modal does not close it.

### Workspace Sorting

Workspace sorting is configured in Settings:

- `Default`: keep Herdr/default order.
- `Drag&drop`: use a custom order shared by all browser tabs connected to the same WebUI process and Herdr session.
- `State`: sort workspace groups by attention state.

State sorting uses the same priority model as agent sorting:

- Blocked.
- Done.
- Unknown.
- Idle.
- Working.

For a repo group with a main workspace and linked worktrees, the group uses the highest-priority state from any member.

Drag-and-drop order is stored in WebUI process memory, keyed by Herdr session. It is shared across browser tabs and browser sessions connected to the same WebUI process, but it is not persisted across WebUI restart.

### Status Indicators

Workspace/worktree rows use simple dots:

- Yellow: working.
- Green: idle.
- Red: blocked.
- Blue: done.
- Grey: unknown.

Agent rows keep the Herdr working animation for working agents. Other status text appears in the agent metadata line.

The working animation is a square-loop indicator. Agent metadata uses colored status text and grey agent names. Agent rows can optionally be sorted by attention state in Settings.

### Notification Sounds

Agent attention sounds are browser-local and start only after a user gesture unlocks browser audio. Sounds trigger when an agent newly enters an attention state such as blocked or done.

Chrome may block Web Audio until the page receives a click or key press. WebUI defers sound playback until that gesture unlocks audio; notification sounds remain optional and browser-local.

Notification scope is configured in Settings:

- `Current agent tab`: only the browser tab currently viewing that agent's workspace, panel, and pane plays the sound.
- `All tabs`: every open WebUI browser tab with sounds enabled can play the sound.

`Current agent tab` is the default to avoid one agent state change ringing in many open browser tabs.

### No-Sleep Mode

The no-sleep control sits beside the `?` toolbar button. Options are Off, Auto, 1h, 2h, 4h, and Infinite.

No-sleep is managed by the WebUI backend process, not by each browser tab. This keeps the machine running the Herdr session awake even if the browser is in the background. All open WebUI tabs read the same backend state and refresh it periodically, so changing the option in one tab updates the others.

Auto mode is also backend-managed. When Auto is enabled, WebUI polls the Herdr agent list from the backend process even if no browser tab is connected. If any agent status is `working`, WebUI prevents host sleep. When all agents are idle, done, blocked, unknown, or no agents exist, WebUI waits for the configured Auto cooldown and checks again. If no agents are working after that cooldown, WebUI releases the no-sleep inhibitor and switches the control back to Off. The default cooldown is 60 seconds.

Timed modes automatically turn off when their duration expires. Infinite stays active until changed to Off or until the WebUI process exits.

Platform support:

- macOS uses `caffeinate`.
- Linux uses `systemd-inhibit`.
- Other platforms report no-sleep as unsupported.

### Rename

Workspaces and tabs use inline rename:

- Double-click row or tab to edit.
- Enter commits rename.
- Escape cancels.
- Session refreshes preserve edit state while input is active.

There is no pencil button. Close buttons remain icon-only.

### Terminal

The terminal pane uses xterm.js and attaches to the selected Herdr pane.

Input handling:

- Keyboard input is forwarded through the terminal WebSocket.
- Switching from an agent row restores xterm focus so OpenCode-style terminal input continues working.
- `Cmd/Ctrl+C` copies xterm selection when text is selected.
- `Cmd/Ctrl+V` pastes clipboard into terminal.
- Large paste payloads are sent as one WebSocket frame when possible, while preserving bracketed-paste markers for terminal apps that request them.
- Optional close-panel shortcut setting supports `Option+W` or `Shift+Space, W`.
- Chrome reserves `Cmd+W` for browser tab close, so WebUI does not offer it as a reliable shortcut.
- Right-click opens Copy/Paste menu.
- `Shift+Enter` sends newline by default when the setting is enabled.

Scrolling:

- Normal wheel input is sent to Herdr's backend terminal scroll protocol.
- Alt/Option+wheel scrolls browser overflow.
- Browser scrollbars can be enabled or hidden in settings.
- Terminal scroll speed is browser-local and configurable from 1 to 20 lines per wheel step.

Sizing:

- Default mode uses backend pane layout size.
- Optional setting resizes the terminal attach to browser viewport size.

## Settings

Settings are stored in browser `localStorage`:

- Default theme: Auto, Light, or Dark.
- Server access: bind address, username, password, and localhost auth bypass. Stored in `~/.config/herdr-webui/webui-settings.json`.
- No-sleep mode: Off, Auto, 1h, 2h, 4h, or Infinite. Managed by the WebUI backend process and shared by all browser tabs.
- No-sleep Auto cooldown: seconds to wait after agents stop working before releasing the backend no-sleep inhibitor. Stored in `~/.config/herdr-webui/webui-settings.json`.
- Theme colors: edit Dark and Light palettes, apply built-in profiles, reset to defaults, and apply/reload UI immediately.
- Show terminal overflow scrollbars.
- Resize terminal to browser viewport.
- Shift+Enter inserts newline.
- Close panel shortcut: Disabled, Option+W, or Shift+Space then W.
- Sort agents by attention.
- Workspace sorting: Default, Drag&drop, or State.
- Notification scope: Current agent tab or All tabs.
- Terminal scroll speed.
- Agent attention sounds.
- Generate worktree branch names.
- Default worktree directory.
- Worktree autodiscover delay.

The header theme button cycles Auto, Dark, and Light. Auto follows browser/system color scheme through `matchMedia`, with fallback polling.

Theme color changes are stored in browser `localStorage`. Colors are normalized once when options load or are saved, then applied on startup, theme change, profile apply, reset, or explicit `Apply / reload UI`; render cycles do not recalculate color palettes.

Workspace drag-and-drop order is not stored in `localStorage`. It is stored in the WebUI backend process so multiple browser tabs can share it.

Server access settings are stored on disk by the WebUI process. Browser settings such as shortcuts, theme, terminal sizing, notification scope, and worktree defaults are stored in browser `localStorage`, so they survive closing and reopening browser tabs on that browser.

No-sleep state is stored in WebUI process memory. It is shared across browser tabs connected to the same WebUI process and stops when WebUI exits.

## Shortcuts

| Shortcut                                  | Action                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `?` toolbar button                        | Open shortcut reference.                                                              |
| No-sleep toolbar select                   | Ask WebUI backend to prevent host sleep: Off, Auto, 1h, 2h, 4h, or Infinite.          |
| `⚙` toolbar button                        | Open settings.                                                                        |
| `Shift+Enter`                             | Insert newline in terminal when enabled.                                              |
| `PageUp` / `PageDown`                     | Scroll Herdr terminal backend.                                                        |
| `Option+Wheel`                            | Scroll browser overflow instead of backend terminal scrollback.                       |
| `Cmd/Ctrl+C`                              | Copy selected terminal text.                                                          |
| `Cmd/Ctrl+V`                              | Paste clipboard into terminal.                                                        |
| Right-click terminal                      | Open Copy/Paste menu.                                                                 |
| Double-click workspace or tab             | Rename inline.                                                                        |
| Enter during rename                       | Save rename.                                                                          |
| Escape during rename                      | Cancel rename.                                                                        |
| Cmd/Ctrl-click, Shift-click, middle-click | Use browser-native tab behavior for workspace, agent, and panel links.                |
| Configured close-panel shortcut           | Close selected Herdr panel. Options: Disabled, `Option+W`, or `Shift+Space` then `W`. |
| Escape in Worktrees modal                 | Close modal.                                                                          |

Chrome and most browsers reserve `Cmd+W` for closing the browser tab, so WebUI does not expose it as a dependable close-panel shortcut.

## Capabilities

Navigation:

- Workspace, worktree, tab, pane, and agent browser navigation.
- URL-addressable selection with browser back/forward support.
- Multiple browser tabs can inspect different Herdr selections without fighting global Herdr focus.

Terminal:

- xterm.js terminal attach for selected Herdr pane.
- Raw input forwarding, clipboard paste, terminal scroll, and optional browser-viewport fit.
- Fast bracketed paste forwarding for large clipboard payloads.
- Browser-local light/dark theme color customization with built-in profiles and reset.
- Terminal loading overlay during selection changes.
- Visibility-based socket reconnect behavior.

Workspace and panel management:

- Create, rename, and close workspaces.
- Create, rename, and close tabs/panels.
- Inline rename for workspaces and tabs.
- Destructive action confirmations include target name.

Worktrees:

- Discover worktrees from repo path or worktrees directory.
- Browser dropdown path suggestions for repo/worktree discovery.
- Stateful Worktrees modal: discovery does not reset create fields.
- Group linked worktrees by repository.
- Create new linked worktrees from existing or new branches.
- Open existing linked worktrees.
- Remove linked worktrees, with dirty-check/force handling where supported.
- Configurable default worktree directory and autodiscover delay.

Agents:

- Agent status list with workspace/worktree and panel context.
- Attention-based sorting.
- Browser-local notification sounds for attention changes.
- Notification scope can be current tab only or all tabs.
- Backend-managed no-sleep mode shared by all browser tabs.

Sessions:

- Default and named Herdr session support.
- Session manager for offline backend state.
- Launch, retry, reset, and close session actions.

## Development Commands

```sh
make fmt
make check
make build
make test
make test-js
make coverage
make run-web-local
```

The project has unit and API-level tests for CLI parsing, auth decisions, login, session/socket path resolution, LaunchAgent plist generation, workspace-order API behavior, static asset routes, and direct-attach protocol framing. `make test` also runs DOM-free JavaScript helper tests and a production script load-order smoke test through Node's built-in test runner. `make coverage` uses `cargo llvm-cov` and prints a summary. Browser UI flows and live Herdr socket flows still need manual testing or future integration tests with fake Herdr socket servers.

Current tested coverage is limited by code that needs a real browser, live Herdr sockets, or macOS `launchctl` side effects. Recent coverage measurement:

- Line coverage: 55.87%.
- Function coverage: 44.64%.
- Region coverage: 53.01%.

Future test improvements:

- Add fake Herdr JSON API socket integration tests for proxied routes such as workspaces, tabs, panes, agents, worktree create/remove, and session close.
- Add fake Herdr client terminal socket tests for terminal attach, hello handshake, raw input forwarding, scroll messages, detach, and stale socket close behavior.
- Add WebSocket integration tests for `/ws/events` and `/ws/terminal` using in-process sockets.
- Add tests for session header routing against fake default and named Herdr sockets.
- Add macOS install tests by extracting plist/write/launchctl command construction from side-effect execution.
- Keep browser-dependent UI flows manual for now; settings modal, theme, drag-and-drop, notification scope, and terminal focus still require browser checks unless a lightweight optional container/browser suite is added later.

## Backend Compatibility

WebUI checks Herdr backend compatibility at runtime through `/api/versions`. It asks the backend for its version and direct attach protocol with the existing `ping` API, then returns compatibility metadata:

```json
{
  "webui": "v0.0.14",
  "backend": "0.7.0",
  "protocol_version": 14,
  "backend_protocol_version": 14,
  "min_backend": "0.7.0",
  "max_tested_backend": "0.7.1",
  "compatibility": {
    "status": "compatible",
    "compatible": true,
    "message": "backend version is supported"
  }
}
```

Compatibility status values:

- `compatible`: backend direct attach protocol matches this WebUI build and backend version is within the supported/tested range.
- `protocol_mismatch`: backend direct attach protocol does not match the WebUI build; terminal attach is not safe.
- `too_old`: backend is older than WebUI's minimum supported version.
- `untested_newer`: backend is newer than WebUI's maximum tested version; it may work, but this release has not validated it.
- `unknown`: backend version is unavailable or cannot be parsed.

Current compatibility table:

| WebUI version | Min backend | Max tested backend | Direct attach protocol |
| ------------- | ----------- | ------------------ | ---------------------- |
| v0.0.14       | 0.7.0       | 0.7.1              | 14                     |

Compatibility testing strategy:

- Unit tests cover semantic version parsing and compatibility status decisions.
- API-level tests use a fake Herdr JSON socket for `/api/versions` and assert compatibility metadata.
- WebUI reads Herdr's `ping.protocol` value and requires it to match its compiled direct attach protocol before allowing a backend to be treated as compatible.
- Future releases should add fake Herdr socket fixtures for workspace, tab, pane, agent, worktree, and terminal attach contracts.
- If Herdr later exposes a stable API/protocol crate, WebUI should depend on it so Dependabot can propose schema/protocol bumps and CI can catch incompatibilities.
- Until then, updating `max_tested_backend` and this table should remain a manual release step after testing against the target Herdr backend.

## Versioning and Releases

The binary reports its version with:

```sh
herdr-webui --version
```

Version is injected at build time:

- Tagged releases use SemVer from tags like `v1.2.3`, producing binary version `1.2.3`.
- Non-release builds use Cargo package version plus commit hash, for example `0.1.0+abc123def456`.

GitHub Actions workflows:

- `.github/workflows/webui-ci.yml`: runs format, check, test, and release build on `master` pushes and pull requests.
- `.github/workflows/webui-release.yml`: runs on SemVer tags, builds macOS arm64/x86_64 binaries, packages checksums, and publishes a GitHub release.

## Current Functionality Checklist

- Standalone Rust binary.
- Embedded offline assets.
- Localhost auth bypass.
- Credential auth for non-localhost use.
- Runtime server access settings with dynamic listener rebind.
- Backend-managed no-sleep control with timed and infinite modes.
- Workspace list/create/rename/close.
- Worktree grouping, creation, and removal.
- Worktree discovery/open modal.
- Stateful Worktrees discovery UX with dropdown suggestions.
- Existing-branch worktree creation workaround in WebUI server.
- Configurable default worktree checkout directory.
- Tab list/create/rename/close.
- Pane terminal attach.
- Agent list and status display.
- Agent attention sorting.
- Configurable agent notification sound scope.
- Workspace attention sorting.
- Shared drag-and-drop workspace sorting.
- Compact session/workspace/tab/pane URLs.
- Real links for workspace, agent, and panel navigation.
- Browser-local scroll speed setting.
- Browser-local light/dark theme color customization.
- Fast bracketed paste forwarding.
- Event WebSocket with snapshot refresh.
- Terminal WebSocket stale-session protection.
- Terminal loading overlay while switching selections.
- Browser visibility reconnect behavior.
- macOS LaunchAgent and Linux systemd user service install/update/start/stop/restart/uninstall.

## Known Limitations

- WebUI duplicates minimal Herdr protocol/schema types instead of depending on a stable shared crate.
- Frontend assets are separate files, but still embedded into the binary at compile time.
- Terminal rendering attaches one selected pane, not full multi-pane workspace layout.
- Browser viewport sizing resizes the Herdr terminal attach; fully independent browser-only terminal sizing is not supported by the current direct attach protocol.
- Theme toggle updates WebUI and xterm renderer, but cannot force already-running child TUIs to change their own color theme.
- Browser focus policies prevent WebUI from reliably focusing or switching to an arbitrary already-open browser tab.
- Robust semantic key encoding for every key combination is limited by Herdr's current direct attach protocol.
- Herdr exposes agent status, but not structured OpenCode TODO/task lists through the current API.
- Drag-and-drop workspace order is process-local memory and disappears when WebUI restarts.
- Event handling still uses snapshot refresh/debounce rather than fine-grained local state patches.
- Browser UI flows still rely on manual checks; Rust/API coverage covers server-side behavior and protocol framing.
- Launch/session management is desktop-service focused through macOS LaunchAgent and Linux systemd user service commands.
- Worktree creation compatibility code in WebUI exists because older provided Herdr backends may try `git worktree add -b` even when a local branch already exists.

## Tech Debt

- Expand DOM-free JavaScript unit tests for pure frontend helpers: route parsing, option normalization, worktree source selection, and sorting. Existing Node tests cover worktree path slugging, absolute path normalization, paste framing, theme color normalization, and frontend script load order.
- Add fake Herdr JSON socket tests for proxied mutation routes: worktree create/open/remove, tab close/rename, pane metadata, and session close.
- Add fake Herdr client terminal socket tests for terminal attach edge cases: reconnect, resize dedupe, scroll messages, bracketed paste payloads, and stale socket close behavior.
- Extract protocol/schema duplication into a shared internal crate if Herdr exposes one.
- Move large inline HTML template strings in `app.js` into small render helpers or static HTML asset sections where it reduces churn without introducing a frontend framework.
- Add stable frontend state boundaries for the highest-churn sections, especially worktree discovery and terminal attach, so updates do not require rebuilding unrelated DOM.
- Add explicit backend protocol support for browser theme/default-color messages if terminal theme sync becomes required.
- Improve `make update-mac` behavior when plist does not exist yet or was installed with a custom `INSTALL_BIN`.
- Document a manual smoke checklist for release validation: login, session launch, terminal attach, paste, Shift+Enter, Worktrees modal, existing-branch worktree create, remove worktree, and macOS update.
- Optional only: evaluate a lightweight browser/container smoke suite if manual checks become too costly; do not make Chrome/Puppeteer part of the default local workflow.

## Security Notes

- Do not expose WebUI outside localhost without setting a username and password.
- Use Settings to change username and password before changing Bind address to `0.0.0.0:8787` or another non-loopback address.
- Non-localhost binds are rejected unless a username and password are configured.
- Localhost auth bypass applies only to loopback requests. Remote requests still need credentials.
- Server access settings are stored in `~/.config/herdr-webui/webui-settings.json`. Protect this file because it contains the configured password.
- The WebUI controls Herdr sessions and terminal input, so treat it as equivalent to shell access.
