# Future TUI backend API

Herdr WebUI now exposes a small reusable Rust client layer for a future first-party TUI or smoke CLI:

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

## Transport

The client wraps the same local sockets that the WebUI browser adapter uses.

| Socket | Encoding | Purpose |
| --- | --- | --- |
| API socket | newline-delimited JSON request/response | workspace, tab, pane, agent, worktree, and snapshot methods |
| terminal socket | length-prefixed bincode frames | terminal attach, ANSI output, input, paste, resize, detach |

`BackendClient::builtin_session(None)` discovers the default built-in socket pair from `~/.config/herdr-webui/webui-settings.json` location. Use `BackendClient::new(api_socket, terminal_socket)` when a launcher or test provides explicit sockets.

## Current Rust surface

Module: `herdr_webui::backend_client`

Primary types:

- `BackendClient`
- `TerminalClient`
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

## TUI prototype scope now possible

A minimal TUI can now be implemented without Axum, WebSocket, DOM, xterm.js, or browser-local storage:

1. Connect with `BackendClient::builtin_session(None)`.
2. Call `snapshot()`.
3. Render workspaces/tabs/panes from the JSON snapshot.
4. Attach to the selected pane terminal id.
5. Render ANSI bytes from `TerminalOutput` with a terminal parser.
6. Send keyboard input through `send_input` and paste through `paste_text`.
7. Resize on terminal-size changes.
8. Detach on exit.

## Supported feature guide

The future TUI may copy these features/functionality as a guide while keeping original implementation and UI:

- session/workspace/tab/pane navigation
- terminal attach/input/resize/detach
- agent list/status display
- agent start through argv/cwd
- pane recent read
- worktree list/open/create from `cwd`, branch, base, and path
- backend version/capability display from `ping`

## Current gaps

This API is a TUI-ready MVP, not full Herdr TUI parity.

Still pending:

- stable typed response structs instead of JSON `Value` for control responses
- true event stream/event hub; built-in `events.subscribe` currently acks then closes
- observe/control/takeover semantics for multiple terminal clients
- server-side scroll offsets, scroll metrics, search, and selection/copy APIs
- named built-in session registry and persistence after WebUI restart
- layout split/move/resize/zoom parity
- safe built-in worktree remove
- stress tests for large output, large paste, reconnect, and multi-client attach

## Tests

`src/backend_client.rs` includes unit tests for:

- built-in socket discovery path convention
- JSON API request/result unwrapping for TUI clients
- terminal handshake, attach, output read, input send, and detach over the bincode socket

Run:

```sh
cargo test backend_client
```
