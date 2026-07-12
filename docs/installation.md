# Installation and local run

## Requirements

- Rust toolchain for local builds.
- Git CLI for worktree features.
- Official Herdr binary available as `herdr` in `PATH`, or set `HERDR_WEB_HERDR_BIN`.

Compatibility:

| WebUI | Herdr | Protocol | Status | Notes |
| --- | --- | --- | --- | --- |
| `0.2.13` | `0.7.3` | `16` with `15` and `14` fallback | Current | Adds protocol 16 support with descending fallback to 15 and 14, subscribes to `layout.updated` events for live pane layout snapshots, exposes a `session.snapshot` endpoint for single-request bootstrap, and deserializes the new `PrefixInputSource` server message without acting on it. The legacy per-endpoint polling bootstrap is moved to `legacy_polling.js` with a removal TODO. |
| `0.2.12` | `0.7.2` | `15` with `14` fallback | Superseded | Uses the same CodeMirror editor tooling for both sides of Git hunk editing, keeps the previous side read-only with line numbers on the right, and hides backing textareas so editable text is not duplicated below the highlighted editor. |
| `0.2.11` | `0.7.2` | `15` with `14` fallback | Superseded | Uses the bundled JetBrainsMono Nerd Font stack when creating desktop xterm terminals, migrates the old desktop monospace default, and refreshes terminal metrics after the font loads. |
| `0.2.9` | `0.7.2` | `15` with `14` fallback | Superseded | Unifies workspace and worktree opening in one modal, adds always-discovered Git branches for worktree creation, shares refresh icon styling across Git/files/modals, and lets users continue worktree creation without pulling when fast-forward update detects diverging branches. |
| `0.2.8` | `0.7.2` | `15` with `14` fallback | Superseded | Restores terminal paste compatibility while keeping the performance fix: paste avoids xterm synchronous parsing and is sent as bounded WebSocket input chunks with backpressure. |
| `0.2.7` | `0.7.2` | `15` with `14` fallback | Superseded | Fixes panel close reconciliation and terminal scroll/follow behavior. Superseded by 0.2.8 for terminal paste compatibility. |
| `0.2.6` | `0.7.2` | `15` with `14` fallback | Tested | Adds configurable agent sorting and sidebar split, shared desktop/mobile terminal scrollback, file/folder browser search with editor readability improvements, and Git pull/push/rebase plus diff layout controls. |
| `0.2.5` | `0.7.2` | `15` with `14` fallback | Tested | Marks Herdr 0.7.2 protocol 15 as tested while preserving protocol 14 fallback for older compatible servers. |
| `0.2.4` | `0.7.1+` | `15` with `14` fallback | Tested | Prefers Herdr direct attach protocol 15 and retries protocol 14 when an older compatible server rejects the initial handshake. |
| `0.2.3` | `0.7.1` | `14` | Tested | Expands Help & Shortcuts with a separated Functionality map section and more detailed area rows. |
| `0.2.2` | `0.7.1` | `14` | Tested | Renames the `?` modal to Help & Shortcuts, with a functionality map and action flows for creating workspaces/panels, opening Files/Git, worktree actions, terminal scroll/follow, search palette, and settings. |
| `0.2.1` | `0.7.1` | `14` | Tested | Restores native xterm.js wheel scrolling by removing the custom shell wheel handler, enables xterm viewport scrolling, uses dynamic terminal shell sizing without inline height/width, removes the custom terminal context menu, and deduplicates terminal CSS/JS into modular helpers. |
| `0.2.0` | `0.7.1` | `14` | Tested | Unifies file browser go-up and search across desktop, mobile, and directory picker with shared tree helpers. Adds Git status colors to file browser entries (yellow modified, green new, red deleted, blue changed directories) with theme-aware contrast for light and dark. Adds unified Git diff layout (GitHub-style) with staged hunk restore. Fixes tab/panel rename focus loss during terminal updates. Fixes terminal wheel scroll in normal buffer mode. Replaces file browser Refresh text button with animated icon button. Splits Git UI into modules for maintainability. Fixes worktree duplication in cleanup. Adds worktree prune endpoint, ahead/behind upstream status, structured log output, and error warnings collection. Bundles JetBrainsMono Nerd Font Mono. |
| `0.1.9` | `0.7.1` | `14` | Tested | Splits Git UI into modules, fixes worktree duplication in cleanup, unifies file tree go-up and search across desktop/mobile/directory picker, adds directory picker search, adds worktree prune endpoint and ahead/behind upstream status, and bundles JetBrainsMono Nerd Font Mono. |
| `0.1.8` | `0.7.1` | `14` | Tested | Adds mobile read-only Git file diffs with horizontally scrollable hunks so long diff lines stay inside the mobile app shell. Bundles JetBrainsMono Nerd Font Mono for terminal icons and shared monospace UI rendering. |
| `0.1.7` | `0.7.1` | `14` | Tested | Improves Git cleanup results with nested repo lists, aligned visible checkboxes, group/repo selection, hidden primary worktrees, and stable scroll while selecting. |
| `0.1.6` | `0.7.1` | `14` | Tested | Adds Files search focus/typing UX, terminal URL links, current-panel close affordances, Git file filtering, cleanup layout fixes, and bulk cleanup refinements. |
| `0.1.5` | `0.7.1` | `14` | Tested | Adds Git branch/worktree cleanup, separate worktree and exploration default directories, and safer bulk cleanup selection. |
| `0.1.4` | `0.7.1` | `14` | Tested | Adds configurable default directory and local notification tone volume, documents browser notification permission handling, and keeps desktop/mobile Settings parity for these options. |
| `0.1.3` | `0.7.1` | `14` | Tested | Lazy-loads CodeMirror, desktop Git UI, and desktop file browser JavaScript so initial terminal loads avoid unused heavy feature bundles. |
| `0.1.0` | `0.7.1` | `14` | Tested | Unifies workspace/worktree opening, enriches workspace cwd metadata from backend pane data, restores Settings search, and reduces browser CPU/memory load for terminal output, large paste, no-sleep polling, and large Git diffs. |
| `0.0.57` | `0.7.1` | `14` | Tested | Fixes worktree creation source handling, adds optional base-branch pull, improves worktree deletion, Git directory loading, directory picker navigation, and terminal scroll follow controls. |
| `0.0.49` | `0.7.1` | `14` | Tested | Adds file browser/editor, shared file trees, CodeMirror editing, large Git change-set placeholders, browser notifications, themed favicons, and local snapshot versioning. |
| `0.0.46` | `0.7.1` | `14` | Tested | Adds configurable WebUI/Git prefix shortcuts, keeps Git drawer keyboard input isolated, and raises Rust line coverage above 70%. |
| `0.0.45` | `0.7.1` | `14` | Tested | Improves embedded Git UI navigation with Escape handling, all-changes return behavior, split frontend assets, scoped file history controls, keyboard-owned drawer input, and per-file large diff loading. |
| `0.0.45` | `0.7.0` | `14` | Minimum supported | Uses WebUI's legacy existing-branch worktree fallback when needed. |

Newer Herdr builds may work when protocol stays compatible, but WebUI reports them as untested. WebUI 0.2.13 treats Herdr 0.7.3 protocol 16 as tested and retries protocols 15 and 14 in descending order for compatible older Herdr 0.7.x servers.

## Build

```sh
make build
```

Binary output:

```text
target/release/herdr-webui
target/release/herdr-webui-tui
```

Runtime version:

- Local builds report `snapshot-<shortsha>`.
- GitHub Actions tag builds report the release tag.
- `Cargo.toml` keeps the next static WebUI SemVer for package metadata; product version still comes from `build.rs` and is exposed by `herdr-webui --version` and `/api/versions`.

## Run Locally

Run WebUI without login on loopback:

```sh
make run-web-local
```

Open:

```text
http://127.0.0.1:8787
```

Fresh settings default to `backend_mode: builtin`. The built-in backend starts inside the WebUI process, creates local API/client sockets for the current session, spawns PTY shells with `portable-pty`, and does not require a separate `herdr server`.

Use an external Herdr daemon only when you explicitly want daemon compatibility:

```sh
herdr server
herdr-webui --https off --backend-mode external-herdr
```

Use auto mode to prefer a compatible external socket when one is already running and fall back to built-in otherwise:

```sh
herdr-webui --https off --backend-mode auto
```

Use a specific Herdr binary only for external session launch/close compatibility:

```sh
HERDR_WEB_HERDR_BIN=/opt/homebrew/bin/herdr herdr-webui --https off --backend-mode external-herdr
```

## CLI

```text
herdr-webui [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME] [--api-socket PATH] [--client-socket PATH] [--backend-mode <external-herdr|builtin|auto>]
herdr-webui --version
herdr-webui-tui [--session NAME] [--api-socket PATH --terminal-socket PATH] [--refresh-ms MS] [--theme dark|light|system] [--summary|--once]
herdr-webui install-mac [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME]
herdr-webui update-mac [--verbose]
herdr-webui install-linux [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME]
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

Backend mode details:

- Default for fresh settings: `builtin`.
- `--backend-mode builtin`: force the in-process built-in backend.
- `--backend-mode external-herdr`: use external `herdr.sock` and `herdr-client.sock` paths, preserving named session behavior.
- `--backend-mode auto`: prefer a live compatible external API socket, otherwise start built-in.
- Settings → Backend writes `backend_mode`, optional `builtin_shell`, `builtin_backend_enabled`, and `external_herdr_backend_enabled` to `~/.config/herdr-webui/webui-settings.json`. Existing saved settings keep their saved mode until changed. Disable a backend type to hide it from the session manager and prevent selecting, creating, or closing sessions through that backend; at least one backend type must remain enabled. External Herdr discovery is passive and does not execute `herdr` unless you explicitly launch/create an external session.
- Current built-in MVP supports workspace/tab/pane basics, PTY terminal attach/input/resize/reconnect, agent/Jcode tail detection, and worktree list/open/create. It intentionally does not yet provide full Herdr parity for server-side scroll/search/selection, true event push, persistence after WebUI restart, or built-in worktree remove.

TUI details:

- `herdr-webui-tui` connects to the same built-in socket namespace as WebUI. Run it while the WebUI service is running.
- `--summary` and `--once` are non-interactive and safe for smoke tests.
- `--theme dark|light|system` controls TUI colors. `system` is default and follows terminal background detection when available; `HERDR_WEBUI_TUI_THEME` or `JCODE_THEME` can set the same value.
- Interactive mode uses Ctrl-B for the help/menu overlay, Enter to attach the selected pane terminal, and Ctrl-G to detach.
- WebUI and TUI can run in parallel against one built-in session. Output is shared through independent terminal attaches; avoid simultaneous input to the same pane from both clients.

Use `--verbose`, `-v`, or `HERDR_WEB_VERBOSE=1` with macOS service commands to print LaunchAgent diagnostics, including UID/EUID, launchctl domain, service target, plist path, and launchctl stderr.

### HTTPS

WebUI serves HTTPS by default. On startup it uses configured certificate files when available; otherwise it generates local self-signed certificates so local builds, installed services, and CI smoke runs work without external certificate tooling:

```sh
herdr-webui --https
```

The default mode is `auto`: WebUI checks whether configured certificate files are available; if not, it creates and reuses `~/.config/herdr/tls/self-signed-cert.pem` and `self-signed-key.pem` with `localhost`, `127.0.0.1`, and `::1` subject alternative names. Browsers will still warn because the fallback certificate is not trusted by the OS, but the transport is encrypted and works without network callbacks.

Use existing certificates, including Let's Encrypt certificates managed outside WebUI, with:

```sh
herdr-webui --https files --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

Passing `--tls-cert` and `--tls-key` also enables `--https files` automatically. WebUI does not run ACME challenges itself, so GitHub Actions and local builds stay deterministic and do not need public DNS or port 80/443 access.

If either configured cert file is missing when HTTPS starts, WebUI falls back to the generated self-signed certificate instead of failing startup. Use `--https off` to opt out and serve plain HTTP when you explicitly need it.

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

The install and update targets build with `cargo build --release --bins` and install both `herdr-webui` and `herdr-webui-tui` into `~/.local/bin` unless `LOCAL_BIN_DIR` is overridden.

Uninstall service:

```sh
make uninstall-mac
make uninstall-linux
```

## Authentication

Server access settings are stored in `~/.config/herdr-webui/webui-settings.json` and can be edited from WebUI Settings:

- Bind address, for example `127.0.0.1:8787` or `0.0.0.0:8787`.
- Username.
- Password.
- Localhost auth bypass.
- No-sleep Auto cooldown.

Non-localhost binds require both username and password. WebUI rejects `0.0.0.0` or any other non-loopback bind until both credentials are configured.

## Sessions

By default, fresh WebUI settings target the built-in backend default session. External Herdr sessions remain available from the session manager or by starting WebUI with `--backend-mode external-herdr`.

Use a named session:

```sh
target/release/herdr-webui --session work --bind 127.0.0.1:8787
```

The footer session button opens the session manager. It detects:

- built-in sessions under the WebUI config directory, for example `~/.config/herdr-webui/builtin/default`,
- external Herdr sessions under the Herdr config directory, for example `~/.config/herdr/sessions/work`.

Use **New built-in** to create or start a built-in session inside the WebUI process. Use **New Herdr** to target an external Herdr session and launch it using `HERDR_WEB_HERDR_BIN` or `herdr` from `PATH`. Selecting a row switches both the session name and backend target, so one browser WebUI process can work with built-in and external Herdr sessions in parallel.

The session manager can also retry connection, reset workspaces, or close the current selected session. Closing a built-in session drops the in-process backend handle; closing an external Herdr session sends `server.stop` to that Herdr backend.

If `--session NAME` is supplied, launched Herdr processes receive `HERDR_SESSION=NAME`.

## FAQ

### `herdr rejected terminal connection: client version 16 is newer than server version 13; please upgrade the herdr server`

This means WebUI is using a newer terminal attach protocol than the Herdr server process handling the session. WebUI retries protocols 16, 15, and 14 in descending order automatically when a newer handshake reaches a compatible older server, so seeing this error usually means the running Herdr server is older than WebUI's fallback range or failed after the fallback retries.

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
