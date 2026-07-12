# Herdr WebUI

Herdr WebUI is a local browser UI for built-in or external Herdr-compatible terminals, workspaces, worktrees, Git operations, and file browsing.

It runs as a Rust Axum server, serves embedded frontend assets, and starts a built-in terminal multiplexer backend by default. It can also connect to an external Herdr backend protocol for compatibility. The UI supports desktop and mobile layouts.

## Quick start

```bash
cargo run -- --https off
```

Open `http://127.0.0.1:8787`. Fresh settings default to the built-in backend, so no separate Herdr daemon is required. To use an external Herdr daemon instead, start it separately and run:

```bash
cargo run -- --https off --backend-mode external-herdr
```

The installed package also includes a first-party terminal UI:

```bash
herdr-webui-tui
herdr-webui-tui --summary
herdr-webui-tui --once
```

`make install-mac`, `make update-mac`, `make install-linux`, and `make update-linux` install both `herdr-webui` and `herdr-webui-tui`. The browser WebUI and TUI can run in parallel against the same built-in backend session; both attach to the same terminal socket protocol. For predictable input, only type into one client for the same pane at a time.

## Documentation layout

The README is the project summary and documentation index. Detailed functionality, technical decisions, performance boundaries, styling rules, and project structure live under `docs/`.

| Page | Purpose |
| --- | --- |
| [Documentation index](docs/index.md) | Entry point and topic map for all docs. |
| [Installation and local run](docs/installation.md) | Requirements, local run, HTTPS, auth, service install, update, FAQ. |
| [Features](docs/features.md) | User-facing desktop and mobile functionality details. |
| [Technical details](docs/technical-details.md) | Architecture, API decisions, file explorer internals, settings, performance, styling. |
| [TUI backend API and prototype](docs/tui-backend-api.md) | Reusable Rust client layer over built-in backend sockets, first-party TUI prototype, and parity gaps. |
| [Development guide](docs/development.md) | Repo layout, frontend structure, parity rules, maintainability guidance. |
| [Release notes](docs/release-notes.md) | Release policy and change history. |

## Functionality summary

- Multi-workspace terminal UI with desktop and mobile layouts, backed by the built-in backend by default.
- First-party `herdr-webui-tui` for terminal-native workspace/agent navigation, live attach/input/resize/detach, ANSI colors/styles, `--theme dark|light|system`, Ctrl-B help/menu, and smoke-friendly summary/once modes.
- Workspace and linked worktree navigation with per-panel terminal state.
- Git UI for status, diffs, staging, commits, stash, branches, cleanup, worktrees, conflicts, blame, and file history.
- Unified header search for workspaces/worktrees, panels, file names, folder names, and file-content matches, including match-case and regex options for content search.
- File explorer with backend Git status colors, parent-aware backend file/folder search, backend content search, type icons, read-only CodeMirror preview, edit mode, line numbers, matched-line opening, folding, in-editor find, and editable find/replace.
- Per-workspace file explorer state while workspaces/worktrees are open, including selected files, search selections, edit mode, split panes, and drafts.
- Settings for keyboard shortcuts, theme colors, terminal behavior, notifications, worktree defaults, file browser behavior, enabled search sections, search section ordering, and content-search defaults.
- Help button documents visible features and shortcuts in-app.

See [Features](docs/features.md) for full behavior details.

## Technical summary

- Backend: Rust Axum server, explicit authenticated API routes, embedded assets, built-in terminal multiplexer, external Herdr protocol bridge, Git/file-system operations.
- Frontend: vanilla JS/CSS assets, no runtime framework, shared modules for tree rendering, icons, editor mounting, content search, terminal helpers, and theme tokens.
- Editor: CodeMirror bundle is preloaded before shared editor code so file previews mount directly with final editor styling; shared editor code provides find in preview plus replace in edit mode.
- File explorer/search: expensive work is backend-owned: tree listing, file/folder search, Git status propagation, content search traversal, safe file read/write, and hash-guarded snippet/file saves.
- Static assets: compiled into the binary with `include_str!`/`include_bytes!` and served from stable `/assets/...` routes.

See [Technical details](docs/technical-details.md) for routes, limits, data flow, and settings.

## Performance and safety summary

- Git status uses one porcelain scan per refresh and propagates parent folder state server-side with priority red > yellow > green.
- Content search skips dependency/build folders, caps traversal, skips large or binary files, paginates file groups, lazy-loads per-file match details, and validates regex patterns before traversal.
- Terminal output is frame-batched before xterm writes, and large paste input uses bounded WebSocket chunks with backpressure.
- Large Git diffs use lazy loading, placeholders, context expansion, and server-side Git commands rather than browser-side repository scanning.
- Path inputs are cleaned before file-system operations. Mutating Git/file actions use backend validation, hash guards, and confirmation where destructive.

See [Technical details](docs/technical-details.md#performance-decisions) and [Development guide](docs/development.md#frontend-notes).

## Styling and structure summary

- Core theme colors live in desktop/mobile base CSS, with shared extension tokens in `src/assets/shared/colors.css` for cross-layout features.
- File icons are neutral monochrome by default and inherit Git status colors only when backend status marks a row changed.
- Desktop CSS/JS is split into modules under `src/assets/desktop/app_css/` and `src/assets/desktop/app_js/`.
- Shared UI logic lives under `src/assets/shared/` to avoid duplicated desktop/mobile maps and rendering code.
- Mobile keeps layout-specific controllers but reuses shared tree, editor, icon, content-search, and terminal helper modules when possible.

See [Development guide](docs/development.md) for project structure and maintainability rules.

## Development

```bash
cargo test
node --test src/assets/*.test.mjs
```

Use `cargo fmt` before committing Rust changes. Keep Help and docs updated when adding visible features.
