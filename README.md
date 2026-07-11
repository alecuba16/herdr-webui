# Herdr WebUI

Herdr WebUI is a local browser UI for Herdr terminals, workspaces, worktrees, Git operations, and file browsing.

It runs as a Rust server, serves embedded frontend assets, and connects to the official Herdr backend protocol. It is not a Herdr fork and does not ship the Herdr terminal multiplexer. The UI supports desktop and mobile layouts.

## Quick start

```bash
cargo run -- --backend http://127.0.0.1:5100 --listen 127.0.0.1:8080
```

Open `http://127.0.0.1:8080` or use HTTPS options from the docs.

## Documentation

- [Documentation index](docs/index.md)
- [Installation and local run](docs/installation.md)
- [Features](docs/features.md)
- [Technical details](docs/technical-details.md)
- [Development guide](docs/development.md)
- [Release notes](docs/release-notes.md)

## Highlights

- Multi-workspace terminal UI with desktop and mobile layouts.
- Git UI for status, diffs, staging, commits, stash, branches, cleanup, and worktrees.
- File explorer with backend Git status colors, parent-aware tree search, backend content search, type icons, read-only CodeMirror preview, edit mode, line numbers, and folding.
- Per-workspace file explorer state while workspaces/worktrees are open.
- Configurable keyboard shortcuts, theme colors, terminal settings, and file browser behavior.

## Development

```bash
cargo test
node --test src/assets/*.test.mjs
```

See [Development guide](docs/development.md) and [Technical details](docs/technical-details.md) for architecture and implementation notes.
