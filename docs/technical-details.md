# Technical details

This document records implementation decisions, feature behavior, settings, and performance boundaries for Herdr WebUI.

## Architecture

Herdr WebUI is a Rust Axum server with embedded static assets. The browser connects to Herdr through HTTP and WebSocket endpoints exposed by the WebUI process.

```mermaid
flowchart LR
  Browser[Browser UI] --> WebUI[Rust WebUI server]
  WebUI --> Herdr[Herdr backend]
  WebUI --> Git[git CLI]
  WebUI --> FS[workspace filesystem]
  Browser --> Assets[embedded /assets routes]
```

### Backend responsibilities

- Serve embedded HTML, CSS, JavaScript, fonts, and icons from `src/assets.rs` and `src/main.rs` routes.
- Validate file paths before reading or writing.
- List file explorer entries and file search results.
- Calculate Git status for files and directories before sending file tree data.
- Run Git UI operations, diffs, comparisons, cleanup scans, and worktree operations.
- Proxy terminal/session protocol messages to compatible Herdr versions.

### Frontend responsibilities

- Render panes, tabs, sidebars, file trees, editor surfaces, terminal surfaces, and modals.
- Store browser-local UI options in `localStorage`.
- Preserve transient panel state while workspaces/worktrees stay open.
- Keep CodeMirror preview and edit mode behavior consistent.
- Load shared modules once through `app_boot.js`.

## Static asset model

The Rust binary embeds assets with `include_str!` or `include_bytes!`. Public routes are explicit, for example:

- `/assets/app-boot.js`
- `/assets/shared/core.js`
- `/assets/shared/colors.css`
- `/assets/shared/file-icons.js`
- `/assets/shared/file-icons.css`
- `/assets/shared/file-tree.js`
- `/assets/shared/file-content-search.js`
- `/assets/vendor/codemirror.js`
- `/assets/shared/editor.js`
- desktop assets under `/assets/desktop/...`
- mobile assets under `/assets/mobile/...`

`app_boot.js` loads layout CSS, then shared color tokens, shared icon CSS, shared JS, and finally layout-specific JS. File icon data is a shared module loaded before `file-tree.js`, so desktop and mobile use the same mappings. Content-search rendering is also shared, with desktop and mobile owning only controller state and backend calls.

## File explorer

### Search with folder context

When filtering files, the UI does not flatten matching files into a pathless list. It rebuilds the parent directory chain for each match. This keeps the path visible without requiring the full tree to stay expanded.

### Git status propagation

The backend runs one Git porcelain status scan per refresh, maps changed paths, then propagates status to parent folders.

Priority:

1. Deleted or missing paths -> red.
2. Modified, renamed, copied, type changed, conflicted -> yellow.
3. Added or untracked -> green.

The priority is monotonic while walking parents. A parent folder keeps the highest-priority child status. Refresh retriggers calculation from current Git state.

### Why backend calculation

Git status and path propagation depend on repository state, ignore rules, renames, untracked files, and deleted paths. Doing it in Rust avoids browser-side tree scans, avoids duplicate desktop/mobile logic, and returns ready-to-render entries.

### Workspace/worktree state

File explorer state is cached per open workspace/worktree identity. It preserves:

- selected file,
- file search query,
- split pane sizes,
- editing mode,
- unsaved edit draft,
- dirty flag.

When a workspace or worktree closes, the cached state is forgotten. Async file fetches write back to the captured workspace state, so switching panels does not corrupt another workspace panel.

### Content search

The file explorer content Search view is backend-owned for repository traversal and matching. Routes:

- `GET /api/file-browser/content-search`: bounded breadth-first scan from the current file tree root, grouped by file.
- `GET /api/file-browser/content-search/file`: lazy full match load for one file when the group is expanded.
- `POST /api/file-browser/content-search/snippet`: hash-guarded line-range save for an edited match snippet.

Performance limits:

- dependency/build folders such as `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, and `venv` are skipped,
- traversal is capped by `MAX_CONTENT_SEARCH_VISITS`,
- file reads are skipped above `MAX_CONTENT_SEARCH_FILE_BYTES`,
- binary/NUL content is skipped,
- result page size, context lines, and matches per file are clamped server-side.

Desktop and mobile use `src/assets/shared/file_content_search.js` for grouped rendering, highlight markup, expand/collapse controls, and snippet editor mount IDs. The frontend does not scan repository content. It only sends queries, renders grouped results, and mounts editor instances for requested snippets.

### Theme tokens

Shared theme extension tokens live in `src/assets/shared/colors.css`. New feature colors should use these or existing base variables instead of local hardcoded palettes. Current shared tokens cover focus rings, search hit foreground/background, content match row background, and editor-style panel background.

### File preview and editing

File open uses the same CodeMirror shell as edit mode from the first render. Preview is read-only by default. Edit only changes the editable state and enables save behavior. Cancel returns to the same read-only editor style.

Text files show line numbers by default. The setting can disable them.

### File icons

File icon logic is split into:

- `src/assets/shared/file_icons.js`: file name and extension mapping for file glyphs.
- `src/assets/shared/file_icons.css`: neutral monochrome glyph styling that inherits row color. Normal rows stay grey; Git status rows can color the whole row.
- `src/assets/shared/file_tree.js`: rendering only, with fallback when icon module is unavailable.

No external icon assets are copied. The implementation uses local CSS and short glyph labels for files. Folders keep the plain folder SVG and only change color through backend Git status row classes.

## Editor

The editor stack is CodeMirror. The WebUI preloads `/assets/vendor/codemirror.js` before `/assets/shared/editor.js` so file open can create a CodeMirror DOM immediately.

Supported behavior:

- read-only preview with CodeMirror style,
- edit mode with the same style,
- syntax highlighting by detected language,
- fold gutter and folding keymaps for compatible languages,
- default line numbers for text preview,
- high-contrast syntax palette tokens for light and dark themes,
- fallback numbered `<pre>` rendering if CodeMirror fails to load.

## Settings

Settings are stored in `localStorage` under `herdr-web-options`. Main defaults are defined in `src/assets/desktop/app_js/core.js`.

| Setting | Default | Notes |
| --- | --- | --- |
| `overflow` | `false` | Browser terminal overflow opt-in. |
| `notificationVolume` | `0.24` | Clamped 0 to 1. |
| `browserNotifications` | `false` | Browser notification permission still applies. |
| `shiftEnterNewline` | `true` | Terminal input newline behavior. |
| `closeShortcut` | `off` | Optional close shortcut mode. |
| `globalShortcutsEnabled` | `true` | Enables WebUI global shortcuts. |
| `globalShortcutPrefix` | app default | Prefix for global shortcuts. |
| `webuiShortcuts` | app default | User-overridable shortcut map. |
| `gitShortcuts` | app default | Git UI shortcut map. |
| `searchShortcut` | `off` | Optional search prefix. |
| `terminalFontFamily` | bundled Nerd Font stack | Migrates old monospace default. |
| `terminalLinks` | `true` | Terminal link detection. |
| `agentSortMode` | `off` | Optional attention/status sorting. |
| `agentStatusOrder` | blocked, idle, done, other, working | Custom status grouping order. |
| `sidebarWorkspacePercent` | `68` | Clamped 20 to 80. |
| `parentCloseMode` | `panels` | Parent close policy. |
| `stuckWorkingEnabled` | `true` | Stuck-working warnings. |
| `workingDismissMinutes` | `30` | Clamped 1 to 1440. |
| `workspaceSort` | `default` | Workspace ordering. |
| `scrollLines` | `3` | Terminal wheel/key scroll step, clamped 1 to 20. |
| `treeIndentPx` | `14` | File tree indent, clamped 0 to 40. |
| `fileBrowserAllowParent` | `true` | Show parent navigation. |
| `fileBrowserGitStatus` | `true` | Show backend-provided Git colors. |
| `fileBrowserLineNumbers` | `true` | Show line numbers in file previews. |
| `fileContentSearchContextLines` | `2` | Default lines above/below each content-search match, clamped 0 to 20. |
| `fileContentSearchAutoCollapseFiles` | `8` | Collapse result file groups when file count exceeds this value. 0 disables auto-collapse. |
| `fileContentSearchMatchesPerFile` | `5` | Initial matches loaded per file before lazy expansion, clamped 1 to 50. |
| `showTabActivity` | `false` | Show tab activity age. |
| `worktreeAutoDiscoverSeconds` | `3` | Discovery interval, clamped 0 to 30. |
| `generateWorktreeNames` | `false` | Auto-generate worktree names. |
| `worktreeDefaultDirectory` | empty | Default worktree parent dir. |
| `explorationDefaultDirectory` | empty | Default exploration/open dir. |
| `themeColors` | theme defaults | Normalized color token map. |

Other modules can contribute defaults through the settings module registry.

## Functionality detail sections

Main user-facing functionality is documented in [Features](features.md). Technical ownership is split as follows:

| Area | Backend owns | Frontend owns |
| --- | --- | --- |
| Terminal | Herdr protocol bridge, auth/session routing, WebSocket frame validation. | xterm attach, scroll-follow state, paste chunking, layout sizing. |
| Workspaces/worktrees | Herdr API proxying, compatibility fallback, service-level validation. | List ordering, local labels, action menus, open/create/remove flows. |
| Git UI | Git CLI commands, path/ref validation, diff/log/status parsing, cleanup scans. | Drawer rendering, shortcuts, staged/unstaged file interactions, diff controls. |
| File explorer tree | Safe path cleaning, directory listing, pagination, Git status propagation. | Tree rendering, focus/type-to-filter UX, selected file state, scroll preservation. |
| File content search | Traversal, text matching, caps, lazy file detail loads, snippet save validation. | Query input, grouped result rendering, expand/collapse state, editor mounting. |
| Settings/help | Runtime server settings and safe defaults. | Browser-local options, settings grouping/search, in-app Help content. |

This split keeps expensive or repository-sensitive work in Rust and keeps browser code focused on UI state and rendering.

## Performance decisions

### Backend-owned repository work

- File listing, file/folder search, content search, Git status, Git comparisons, cleanup scans, diffs, and path validation run on the backend.
- The browser never scans repository contents for search or Git state. It receives ready-to-render data with pagination/truncation markers.
- Git status uses one porcelain scan per refresh. Directory status is propagated by walking parent paths for changed files with monotonic priority red > yellow > green.
- Content search skips `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, and `venv`; caps traversal with `MAX_CONTENT_SEARCH_VISITS`; skips files above `MAX_CONTENT_SEARCH_FILE_BYTES`; skips binary/NUL data; clamps context and match counts.

### Frontend rendering work

- Shared modules avoid duplicate browser computation. `file_tree.js`, `file_icons.js`, `file_content_search.js`, `editor.js`, and terminal helpers are reused by desktop/mobile.
- File content search groups are collapsed by default when result counts exceed the configured threshold. Full per-file matches are lazy-loaded only when needed.
- CodeMirror is preloaded once and reused for preview, edit, Git hunk editing, and snippet editing. A numbered HTML fallback exists only for load failure.
- Desktop terminal output is coalesced once per animation frame before xterm writes. Attach frames have suppression logic so large initial frames do not reveal partial output.
- Large paste input bypasses xterm synchronous `paste()` and uses bounded WebSocket chunks with backpressure.
- Git diff views use lazy file loading, context expansion, placeholders, and omitted-line guards for very large diffs.

### State and refresh model

- File explorer state is scoped by open workspace/worktree identity. Switching panels restores search, selected files, split panes, edit mode, and drafts without refetching unrelated UI state.
- Closing a workspace/worktree forgets only UI cache. It does not mutate repository files or Herdr backend state.
- Refresh retriggers backend calculations for Git status and tree/content search, which avoids stale derived state in the browser.

## Styling and theme architecture

### Color tokens

- Desktop base tokens live in `src/assets/desktop/app_css/base.css`.
- Mobile base tokens live in `src/assets/mobile/app.css`.
- Shared cross-layout extension tokens live in `src/assets/shared/colors.css`.
- New shared feature colors should use shared tokens first, existing base tokens second, and local hardcoded colors only when there is a strong reason.

Current shared tokens cover:

- `--herdr-focus-ring`,
- `--herdr-search-hit-bg`,
- `--herdr-search-hit-fg`,
- `--herdr-search-match-bg`,
- `--herdr-content-panel-bg`,
- `--herdr-content-editor-min-height`.

### Icon and status color rules

- Normal file/folder icons are neutral grey and inherit row color.
- Folders stay plain grey unless backend Git status marks the row changed.
- Git status row color is semantic: deleted red, modified/conflict yellow, new/untracked green.
- File icon type glyphs are generated from local CSS/JS maps, not external icon packs.

### Editor visual rules

- Preview and edit mode share the same CodeMirror shell.
- Edit mode changes only editability and save controls.
- Syntax colors use editor-specific theme tokens so code remains readable in both light and dark themes.

## Code structure and maintainability

- Rust backend modules own security-sensitive and expensive work: `file_browser.rs`, `git_ui/`, `protocol.rs`, `service.rs`, and `assets.rs`.
- Desktop shell JS/CSS is split under `src/assets/desktop/app_js/` and `src/assets/desktop/app_css/`, then concatenated by `src/assets.rs`.
- Desktop Git UI is split under `src/assets/desktop/git_ui/` by settings, syntax, actions, shell layout, diff layout, and log layout.
- Shared browser modules live under `src/assets/shared/`. Shared modules should be preferred for behavior used by both desktop and mobile.
- Mobile-specific behavior lives under `src/assets/mobile/`, but should call shared renderers/helpers instead of copying maps or algorithms.
- Static asset routes are explicit in `src/main.rs`; new assets need route coverage in Rust tests and load-order coverage in JS tests.
- Visible features must update three places together: user docs, Help modal, and tests.

## Help button coverage

The in-app Help and Shortcuts modal documents user-facing behavior, including:

- terminal shortcuts,
- file explorer tree search, content search, Git color priority, icons, read-only preview, line numbers, folding, and workspace state preservation,
- Git UI actions and diff modes,
- command palette behavior.

When a visible feature is added, update `shortcutsModalHtml()` and tests in `src/assets/app_load.test.mjs`.

## Safety decisions

- Path inputs are cleaned before filesystem operations.
- File writes use editor state and backend validation.
- Workspace/worktree close forgets only UI state, not repository data.
- Destructive Git actions are routed through backend commands and UI confirmation paths.
