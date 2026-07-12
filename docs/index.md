# Documentation index

Herdr WebUI is a local browser UI for built-in or external Herdr-compatible terminals, workspaces, Git status, worktrees, and file browsing.

The README is the short project summary. This `docs/` directory holds detailed functionality, implementation decisions, performance notes, styling rules, and project structure.

## Pages

| Page | Covers |
| --- | --- |
| [Installation and local run](installation.md) | Requirements, local HTTPS, CLI, macOS install/update/uninstall, auth, sessions, FAQ. |
| [Features](features.md) | User-facing desktop and mobile behavior, file explorer, Git UI, terminal, settings, worktrees. |
| [Technical details](technical-details.md) | Architecture, backend/frontend responsibilities, static assets, file explorer internals, settings, performance, styling, safety. |
| [Future TUI backend API](tui-backend-api.md) | Built-in backend client API for future TUI/smoke CLI, supported features, and remaining parity gaps. |
| [Development guide](development.md) | Repository layout, frontend module structure, desktop/mobile parity, maintainability rules. |
| [Release notes](release-notes.md) | Release policy and release history. |

## Topic map

| Topic | Start here | Details |
| --- | --- | --- |
| Run or install locally | [Installation](installation.md) | CLI flags, HTTPS modes, auth, service commands. |
| What the app can do | [Features](features.md) | Sidebar, panels, worktrees, file browser, Git UI, terminal, settings. |
| File explorer behavior | [Features: File browser](features.md#webui-features) | [Technical details: File explorer](technical-details.md#file-explorer). |
| Unified header search | [Features: File browser](features.md#webui-features) | [Technical details: Unified header search](technical-details.md#unified-header-search). |
| Backend content search | [Features: File browser](features.md#webui-features) | [Technical details: Content search](technical-details.md#content-search). |
| Git status colors | [Features: File browser](features.md#webui-features) | [Technical details: Git status propagation](technical-details.md#git-status-propagation). |
| Future TUI backend | [Future TUI backend API](tui-backend-api.md) | Reusable Rust client over built-in sockets, prototype scope, and parity gaps. |
| Performance model | [Technical details: Performance decisions](technical-details.md#performance-decisions) | Backend-owned repo work, terminal batching, lazy loading. |
| Styling and themes | [Technical details: Styling and theme architecture](technical-details.md#styling-and-theme-architecture) | Theme variables, shared color tokens, icon coloring rules. |
| Code structure | [Development guide](development.md#project-layout) | Asset modules, shared frontend helpers, desktop/mobile parity. |
| Release process | [Release notes](release-notes.md) | SemVer tags and release workflow. |

## Current design principles

- Backend owns expensive repo work: file listing, file/folder search, Git status propagation, content search traversal, Git comparisons, and safe filesystem access.
- Frontend owns rendering, transient UI state, editor mounting, and user interaction only.
- Shared modules contain reusable logic. Desktop and mobile should not copy large maps, theme rules, tree rendering, icon logic, or content-search rendering.
- Static assets are embedded in the Rust binary and served from stable `/assets/...` routes.
- User-facing features must update README/docs, in-app Help, and regression tests together.
