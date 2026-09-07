# TUI backend API and prototype

Herdr WebUI exposes a small reusable Rust client layer plus a first-party prototype TUI binary over the built-in backend sockets:

```rust
use herdr_webui::backend_client::BackendClient;

let client = BackendClient::builtin_session(None);
let snapshot = client.snapshot()?;
let terminal_id = snapshot["snapshot"]["panes"][0]["terminal_id"]
    .as_str()
    .expect("root terminal id");

let mut terminal = client.attach_terminal(terminal_id, 120, 32)?;
terminal.send_input(b"printf hello\\n")?;
let frame = terminal.read_output()?;
terminal.detach()?;
```

This is an original client-facing API over the built-in WebUI backend. It uses Herdr-like features and behavior as a product guide, not copied source/UI code.

## Command-line TUI

Build all binaries:

```sh
cargo build --bins
```

Run the TUI against the default built-in backend session:

```sh
cargo run --bin herdr-webui-tui
```

Non-interactive smoke modes:

```sh
cargo run --bin herdr-webui-tui -- --summary
cargo run --bin herdr-webui-tui -- --once
```

Useful flags:

- `--session NAME`: use a built-in socket namespace, default `default`
- `--api-socket PATH --terminal-socket PATH`: connect to explicit socket paths
- `--refresh-ms MS`: set snapshot refresh interval, minimum 50ms
- `--theme dark|light|system`: choose TUI colors. `system` is default and follows the terminal background when detection is available.
- `--webui-api HOST:PORT`: pin the WebUI HTTP API base used by the Files and Git screens. Accepts `HOST:PORT` or `http://HOST:PORT`.
- `--summary`: print backend/session counts and exit
- `--once`: print a text snapshot, selected pane, selected agent, and pane output, then exit

Interactive controls:

- `j/k` or arrow keys move selection
- `Tab` switches workspace/agent list focus
- `w` focuses workspaces, `a` focuses agents
- `Enter` attaches the selected terminal and starts a live background reader for raw terminal frames
- keys in attach mode send input through the live terminal writer
- `Ctrl-G` detaches back to navigation
- `r` refreshes, `?` shows help, `q` quits from navigation
- `Ctrl-B` arms the WebUI prefix key (footer shows `Ctrl+B>`); the next key runs the matching WebUI default shortcut. `Ctrl-B` again opens the command/help menu. `Esc` cancels the prefix.

Prefix shortcuts (after `Ctrl+B`):

- `f`: Files screen. `j/k` moves, `Enter` enters a directory or opens the preview, `l` expands/enters, `h`/`u` go to the parent, `/` starts filtering, `r` refreshes.
- `g`: Git screen (Changes tab by default). `Tab` cycles Changes/Log/Branches/Stash tabs.
- `1`/`2`: Git Changes. `3`: Git Log. `4`: Git Stash. `b`: Git Branches. `2`/`c` open the commit modal, `e` edits the currently selected file (the Files preview on the Files screen, the file highlighted in Git Changes otherwise), `G` stages all changes.
- `y` stages, `u` unstages, `d` discards, `z` stashes the selected file. `p` pulls, `P` pushes.
- `t`: back to the Terminal screen. `?`: help overlay. `/`: filter in the Files screen.

Inside the Git screen: `s` stages, `d` discards, `f` fetches, `p` pulls, `P` pushes, `c`/`a` open commit/amend modals, `r` refreshes, `Enter` loads the diff (Changes), switches the selected branch (Branches), or applies a stash entry (Stash), and `D` deletes the selected branch (Branches) or drops the selected stash (Stash) after a typed `y` confirmation. Inside the Files screen: `Enter` enters a directory, expands one, or opens the preview, `e` starts editing the open preview (typing inserts at the cursor; `Left`/`Right`/`Home`/`End` move it; Ctrl-S saves with the 409 conflict guard, Ctrl-R reloads from disk discarding edits, Esc stops editing; prefix `e` on the Git screen edits the file highlighted in Changes), `R` renames the selected file with a prefilled prompt, and `x` deletes it after a typed `y` confirmation. Unsaved edits survive screen switches; opening a different file while dirty is refused until saved or reloaded.

The Files and Git screens call the WebUI HTTP API over loopback (`/api/files/*`, `/api/git/*`). The TUI discovers the API base from `HERDR_WEBUI_TUI_API`, then the WebUI settings bind address (`webui-settings.json`), then `127.0.0.1:8787`. `--webui-api` pins it explicitly. These screens require the WebUI server to be running; API errors show in the status/error line instead of failing the TUI.

Terminal output is loaded from `pane.read` for snapshot views and from raw terminal attach frames when entering attach mode. The TUI applies common terminal rewrites such as carriage return, line clear, cursor movement, OSC title skipping, and ANSI handling so Jcode toolbars and status lines stay visible instead of showing stale cleared output. Live attach rendering preserves SGR foreground/background colors plus bold, dim, italic, and underline for Ratatui spans.

The browser WebUI and TUI can run in parallel against one built-in backend session. They use separate terminal attaches over the same terminal socket protocol. Output fan-out is supported; simultaneous input to the same pane is allowed by the PTY but intentionally not coordinated, so users should type in only one client at a time for predictable command input.

Theme behavior mirrors the Jcode theme branch shape. `dark` and `light` are explicit palettes. `system` means terminal colors: the TUI checks `HERDR_WEBUI_TUI_THEME`, then `JCODE_THEME`, then queries the terminal background before entering raw mode. If the terminal cannot answer in non-interactive or unsupported environments, the fallback is dark.

## Transport

The client wraps the same local sockets that the WebUI browser adapter uses.

| Socket | Encoding | Purpose |
| --- | --- | --- |
| API socket | newline-delimited JSON request/response | workspace, tab, pane, agent, worktree, and snapshot methods |
| terminal socket | length-prefixed bincode frames | terminal attach, ANSI output, input, paste, resize, detach |

`BackendClient::builtin_session(None)` discovers the default built-in socket pair from `~/.config/herdr-webui/webui-settings.json` location. Use `BackendClient::new(api_socket, terminal_socket)` when a launcher or test provides explicit sockets.

## Current Rust surface

Module: `herdr_webui::backend_client`

The TUI stack is intentionally layered:

- `backend_client`: reusable transport/client API over built-in control and terminal sockets.
- `tui`: domain models, snapshot parsing, selection state, key mapping, text rendering, and Ratatui widgets.
- `bin/herdr-webui-tui.rs`: CLI parsing, terminal raw mode, event loop, and live terminal reader/writer wiring.

Keep new functionality behind this boundary. Add or extend `BackendClient` methods first, then consume them from TUI state/rendering. Do not import built-in backend internals into the TUI module or binary.

Primary types:

- `BackendClient`
- `TerminalClient`
- `TerminalWriter`
- `TerminalEvent`
- `TerminalOutput`
- `BackendClientError`

Control methods:

- `ping()`
- `snapshot()`
- `list_workspaces()`
- `create_workspace(cwd, label)`
- `list_tabs(workspace_id)`
- `create_tab(workspace_id, label)`
- `list_panes(workspace_id)`
- `read_pane(pane_id)`
- `list_agents()`
- `start_agent(name, argv, cwd)`
- `list_worktrees(cwd)`
- `open_worktree(path, branch, label)`
- `create_worktree(cwd, branch, path, label)`
- `create_worktree_from_base(cwd, branch, base, path, label)`
- generic `request(method, params)` for methods not yet wrapped

Terminal methods:

- `attach_terminal(terminal_id, cols, rows)`
- `TerminalClient::read_event()`
- `TerminalClient::read_output()`
- `TerminalClient::send_input(bytes)`
- `TerminalClient::paste_text(text)`
- `TerminalClient::resize(cols, rows)`
- `TerminalClient::detach()`
- `TerminalClient::writer()` for concurrent live read/write
- `TerminalWriter::send_input(bytes)`
- `TerminalWriter::paste_text(text)`
- `TerminalWriter::resize(cols, rows)`
- `TerminalWriter::detach()`

## TUI prototype scope now implemented

The prototype TUI works without Axum, WebSocket, DOM, browser terminal renderer, or browser-local storage:

1. Connect with `BackendClient::builtin_session(None)`.
2. Call `snapshot()`.
3. Render workspaces/tabs/panes from the JSON snapshot.
4. Attach to the selected pane terminal id.
5. Render ANSI bytes from `TerminalOutput` with local terminal rewrite handling and styled SGR spans.
6. Send keyboard input through `send_input` and paste through `paste_text`.
7. Resize on terminal-size changes.
8. Detach on exit.

## Supported feature guide

The future TUI may copy these features/functionality as a guide while keeping original implementation and UI:

- session/workspace/tab/pane navigation
- terminal attach/input/resize/detach
- ANSI color/style rendering for foreground/background colors, bold, dim, italic, and underline
- agent list/status display
- Jcode status display that uses built-in screen/process detection, Herdr `jcode-support` manifest markers, and active background-task cards to avoid false idle flips while work is still running
- agent start through argv/cwd
- pane recent read
- worktree list/open/create from `cwd`, branch, base, and path
- backend version/capability display from `ping`
- WebUI file explorer: tree browse, filter, preview, read, rename, delete
- WebUI git management: status, diff, log, branches, stashes, stage/unstage/discard, commit, pull/push/fetch, switch, branch delete, stash apply/drop

## Protocol version note

The TUI backend client uses `BUILTIN_TUI_PROTOCOL_VERSION: u32 = 16` (the minimum supported protocol) for built-in session connections, while the WebUI server supports up to protocol 20. This ensures the TUI can connect to any compatible built-in session regardless of the server's maximum protocol version. The protocol handshake iterates all supported protocol versions from 20 down to 16 (inclusive) in descending order for external Herdr connections, retrying on "newer than server version" rejections until the minimum supported protocol is reached.

## Current gaps

This API and TUI are usable prototypes, not full Herdr TUI parity.

Parity checked against the Herdr native TUI implementation in the `jcode-support` branch:

| Area | Herdr native TUI | `herdr-webui-tui` status |
| --- | --- | --- |
| Terminal attach/output/input | In-process terminal runtime with Ghostty VT parser, live render patches, keyboard protocol tracking, paste, resize, detach | Supported over built-in terminal socket with live background reader/writer, ANSI rewrite handling, SGR colors/styles, input, resize, detach |
| Jcode/agent status | Manifest-driven detection, sidebar state icons, priority sorting, unseen/done state handling, custom labels | Basic agent list/status from built-in snapshot, focused agent selected by default, Jcode output visible |
| Workspace navigation | Workspace picker, direct numeric switching, previous/next, rename, close, new workspace | Basic workspace list and selection only |
| Tabs | Full tab bar, create/rename/close/switch 1-9, previous/next | Tab list display only |
| Panes/layout | Split horizontal/vertical, focus by direction, cycle, resize mode, zoom, rename, close, last pane | Single selected pane display, no split/layout mutation yet |
| Scrollback/copy/search | Host scrollback, scroll metrics, scrollbar, copy mode, edit scrollback, text search/matches | Recent pane text plus live terminal text, no scroll/copy/search UI yet |
| Mouse/touch | Mouse pane focus, scroll, selection, dialogs, mobile layout | Keyboard-only prototype |
| File explorer | Not in native Herdr TUI | Files screen over the WebUI HTTP API: lazy tree, filter, preview, rename, delete |
| Git management | Not in native Herdr TUI | Git screen over the WebUI HTTP API: Changes/Log/Branches/Stash tabs, stage/unstage/discard/commit/pull/push/fetch/switch/stash |
| Worktrees | New/open/remove worktree dialogs with validation | Backend client supports list/open/create wrappers, no interactive TUI dialogs yet |
| Settings/config/keybinds | Config reload, settings overlay, custom commands, prefix mode, configurable keybinds | Fixed keymap and help overlay |
| Notifications/integrations | Notification targets, release notes, integrations/settings panels | Not implemented |

The current pairing is therefore **backend/protocol paired**, not **feature-complete Herdr UI paired**. The TUI is ready as a foundation for Herdr-like workflows, but it intentionally does not yet replace the native Herdr app.

Still pending:

- stable typed response structs instead of JSON `Value` for control responses
- typed event wrappers in `BackendClient`; built-in `events.subscribe` now has a server-side event hub, but the Rust client layer does not yet expose a high-level typed subscription API
- observe/control/takeover semantics for multiple terminal clients
- server-side scroll offsets, scroll metrics, search, and selection/copy APIs
- named built-in session registry and persistence after WebUI restart
- layout split/move/resize/zoom parity
- safe built-in worktree remove
- stress tests for large output, large paste, reconnect, and multi-client attach

## Tests

`src/backend_client.rs`, `src/tui.rs`, `src/tui_web_api.rs`, `src/tui_keys.rs`, `src/tui_panels.rs`, and `src/bin/herdr-webui-tui.rs` include unit tests for:

- built-in socket discovery path convention
- JSON API request/result unwrapping for TUI clients
- terminal handshake, attach, output read, input send, and detach over the bincode socket
- TUI snapshot parsing, render smoke, keyboard-to-terminal byte mapping, text snapshots, raw terminal output parsing, ANSI color/style spans, terminal row rewrite behavior, and CLI parsing
- WebUI HTTP API URL parsing/discovery, prefix-key state machine, shortcut mapping, file explorer behavior, git panel state and actions, and render smoke tests for all screens

Run:

```sh
cargo test backend_client
cargo test tui
cargo test --bin herdr-webui-tui
```
