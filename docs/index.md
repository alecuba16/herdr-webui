# Documentation index

Herdr WebUI is a local browser UI for Herdr terminals, workspaces, Git status, worktrees, and file browsing.

## Pages

- [Installation and local run](installation.md): requirements, local HTTPS, CLI, macOS install, auth, sessions, FAQ.
- [Features](features.md): desktop and mobile UI capabilities.
- [Technical details](technical-details.md): architecture, decisions, performance model, settings, file explorer internals.
- [Development guide](development.md): project layout, frontend structure, desktop and mobile parity.
- [Release notes](release-notes.md): release history and release policy.

## Current design principles

- Backend owns expensive repo work: file listing, Git status propagation, Git comparisons, and safe filesystem access.
- Frontend owns rendering, transient UI state, and user interaction only.
- Shared modules contain reusable logic. Desktop and mobile should not copy large maps or theme rules.
- Static assets are embedded in the Rust binary and served from stable `/assets/...` routes.
