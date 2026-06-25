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
| `0.0.35` | `0.7.1` | `14` | Tested | Uses native `worktree.create` existing-branch support and async/deferred worktree operations. |
| `0.0.35` | `0.7.0` | `14` | Minimum supported | Uses WebUI's legacy existing-branch worktree fallback when needed. |

Newer Herdr builds may work when protocol stays compatible, but WebUI reports them as untested.

## Build

```sh
make build
```

Binary output:

```text
target/release/herdr-webui
```

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
- `src/protocol.rs`: Herdr direct terminal attach wire types and frame codec.
- `src/service.rs`: OS service helpers.
- `src/assets/`: embedded HTML/CSS/JS and frontend tests.
- `.github/workflows/webui-ci.yml`: WebUI CI.
- `.github/workflows/webui-release.yml`: WebUI release builds for `v0.0.*` tags.
- `Makefile`: local build, run, install, update, uninstall commands.

The Rust binary embeds frontend assets with `include_str!`, so release artifacts do not need external static files next to the binary.

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

The browser UI provides workspace navigation, top panel tabs, agent status, terminal attach, and local-only convenience settings stored in browser storage.

Sidebar:

- Use the vertical divider between the sidebar and terminal to hide or show the workspace/agents sidebar.
- The collapsed state is stored in browser `localStorage`.

Worktrees:

- With Herdr `0.7.1` and newer, WebUI uses Herdr's native `worktree.create` support for existing local branches and deferred Git work.
- With Herdr `0.7.0`, WebUI keeps a legacy fallback for creating a checkout from an existing branch when a checkout path is supplied.
- WebUI subscribes to `worktree.created`, `worktree.opened`, and `worktree.removed` and refreshes workspace/agent state quickly after these events.
- `worktree.removed` events from Herdr `0.7.1` may include a workspace snapshot. This is additive; WebUI refreshes from the backend state instead of relying only on the event payload.

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

Terminal scroll:

- Wheel scroll speed is configurable in Settings under `Terminal input` with the `Scroll speed` slider.
- Small trackpad wheel deltas are accumulated before sending scroll commands, preventing tiny events from each scrolling a full line batch.

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
