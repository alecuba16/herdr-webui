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
- Supports configurable agent notification sound scope.
- Provides a session manager when the Herdr backend is offline.
- Can launch a Herdr backend process for the configured session.
- Provides optional browser notifications through agent attention sounds.
- Can run from macOS LaunchAgent as a per-user service.

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
- `webui/src/assets/xterm.min.js`: vendored xterm.js runtime.
- `webui/src/assets/xterm.css`: vendored xterm styles.
- `webui/src/assets/herdr-logo.svg`: favicon served by the WebUI.
- `Makefile`: build, run, install, update, and uninstall commands.
- `plan.md`: original implementation plan and design goals.

## Build

```sh
make build
```

Binary output:

```sh
target/release/herdr-webui
```

## Run Locally

Run with localhost auth bypass:

```sh
make run-web-local
```

Equivalent direct command:

```sh
HERDR_WEB_LOCALHOST_NO_AUTH=true target/release/herdr-webui --bind 127.0.0.1:8787
```

Then open:

```text
http://127.0.0.1:8787
```

## Authentication

Environment variables:

- `HERDR_WEB_USER`: username for login.
- `HERDR_WEB_PASSWORD`: password for login.
- `HERDR_WEB_LOCALHOST_NO_AUTH=true`: allow localhost requests without login.

Non-localhost binds require credentials. Public binds without auth should fail fast.

Example public bind:

```sh
HERDR_WEB_USER=admin HERDR_WEB_PASSWORD='change-me' target/release/herdr-webui --bind 0.0.0.0:8787
```

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

Uninstall LaunchAgent:

```sh
make uninstall-mac
```

Or:

```sh
./herdr-webui uninstall-mac
```

`~/.local/bin` does not need to be in `PATH` for LaunchAgent to work because the plist uses the full binary path. If it is not in shell `PATH`, `make install-mac` prints a note.

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

The `♧+` button opens a worktree creation modal with:

- Branch name.
- Base ref, defaulting to `HEAD`.
- Optional label.
- Optional path.

After creation, WebUI routes to the new workspace, tab, and root pane returned by Herdr.

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

Notification scope is configured in Settings:

- `Current agent tab`: only the browser tab currently viewing that agent's workspace, panel, and pane plays the sound.
- `All tabs`: every open WebUI browser tab with sounds enabled can play the sound.

`Current agent tab` is the default to avoid one agent state change ringing in many open browser tabs.

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
- Optional close-panel shortcut setting supports `Option+W` or `Shift+Space, W`.
- Chrome reserves `Cmd+W` for browser tab close, so WebUI does not offer it as a reliable shortcut.
- Right-click opens Copy/Paste menu.

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
- Show terminal overflow scrollbars.
- Resize terminal to browser viewport.
- Shift+Enter sequence.
- Close panel shortcut: Disabled, Option+W, or Shift+Space then W.
- Sort agents by attention.
- Workspace sorting: Default, Drag&drop, or State.
- Notification scope: Current agent tab or All tabs.
- Terminal scroll speed.
- Agent attention sounds.

The header theme button cycles Auto, Dark, and Light. Auto follows browser/system color scheme through `matchMedia`, with fallback polling.

Workspace drag-and-drop order is not stored in `localStorage`. It is stored in the WebUI backend process so multiple browser tabs can share it.

Shortcut settings are stored in browser `localStorage`, so they survive closing and reopening browser tabs.

## Development Commands

```sh
make fmt
make check
make build
make test
make coverage
make run-web-local
```

The project has unit and API-level tests for CLI parsing, auth decisions, login, session/socket path resolution, LaunchAgent plist generation, workspace-order API behavior, static asset routes, and direct-attach protocol framing. `make coverage` uses `cargo llvm-cov` and prints a summary. Browser UI flows and live Herdr socket flows still need manual testing or future integration tests with fake Herdr socket servers.

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
- Keep browser UI JavaScript untested for now; settings modal, theme, drag-and-drop, notification scope, and terminal focus still require manual browser checks unless a browser automation suite is added later.

## Backend Compatibility

WebUI checks Herdr backend compatibility at runtime through `/api/versions`. It asks the backend for its version with the existing `ping` API and returns compatibility metadata:

```json
{
  "webui": "0.0.1",
  "backend": "0.7.0",
  "protocol_version": 14,
  "min_backend": "0.7.0",
  "max_tested_backend": "0.7.0",
  "compatibility": {
    "status": "compatible",
    "compatible": true,
    "message": "backend version is supported"
  }
}
```

Compatibility status values:

- `compatible`: backend is within the supported and tested version range.
- `too_old`: backend is older than WebUI's minimum supported version.
- `untested_newer`: backend is newer than WebUI's maximum tested version; it may work, but this release has not validated it.
- `unknown`: backend version is unavailable or cannot be parsed.

Current compatibility table:

| WebUI version | Min backend | Max tested backend | Direct attach protocol |
| --- | --- | --- | --- |
| 0.0.1 | 0.7.0 | 0.7.0 | 14 |

Compatibility testing strategy:

- Unit tests cover semantic version parsing and compatibility status decisions.
- API-level tests use a fake Herdr JSON socket for `/api/versions` and assert compatibility metadata.
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
- Workspace list/create/rename/close.
- Worktree grouping, creation, and removal.
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
- Event WebSocket with snapshot refresh.
- Terminal WebSocket stale-session protection.
- Terminal loading overlay while switching selections.
- Browser visibility reconnect behavior.
- macOS LaunchAgent install/update/uninstall.

## Known Limitations

- WebUI duplicates minimal Herdr protocol/schema types instead of depending on a stable shared crate.
- Main app HTML/CSS/JS is embedded as a large Rust string in `main.rs`.
- Terminal rendering attaches one selected pane, not full multi-pane workspace layout.
- Browser viewport sizing resizes the Herdr terminal attach; fully independent browser-only terminal sizing is not supported by the current direct attach protocol.
- Theme toggle updates WebUI and xterm renderer, but cannot force already-running child TUIs to change their own color theme.
- Browser focus policies prevent WebUI from reliably focusing or switching to an arbitrary already-open browser tab.
- Robust semantic key encoding for every key combination is limited by Herdr's current direct attach protocol. WebUI can send configured raw sequences, but backend protocol support is needed for richer semantic key events.
- Herdr exposes agent status, but not structured OpenCode TODO/task lists through the current API.
- Drag-and-drop workspace order is process-local memory and disappears when WebUI restarts.
- Event handling still uses snapshot refresh/debounce rather than fine-grained local state patches.
- Tests are minimal; most confidence currently comes from `make build` and manual browser checks.
- Launch/session management is macOS-focused.

## Tech Debt

- Split embedded frontend into separate source files and embed them at build time.
- Add browser smoke tests for routing, inline rename, terminal focus, and session manager flows.
- Add Rust tests for auth decisions, API proxy error handling, and plist generation.
- Extract protocol/schema duplication into a shared internal crate if Herdr exposes one.
- Add stable frontend state model instead of rebuilding large DOM sections on every refresh.
- Add explicit backend protocol support for browser theme/default-color messages if terminal theme sync becomes required.
- Improve `make update-mac` behavior when plist does not exist yet or was installed with a custom `INSTALL_BIN`.
- Document compatibility matrix against Herdr backend versions once protocol changes stabilize.

## Security Notes

- Do not bind to public interfaces without setting `HERDR_WEB_USER` and `HERDR_WEB_PASSWORD`.
- `HERDR_WEB_LOCALHOST_NO_AUTH=true` is intended only for loopback development or trusted local use.
- The WebUI controls Herdr sessions and terminal input, so treat it as equivalent to shell access.
