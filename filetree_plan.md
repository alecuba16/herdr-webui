# File Tree And Editor Plan

## Goal

Add a shared file navigation and editor foundation for desktop and mobile. Use it for the new file browser first, then migrate Git UI pieces and path picking flows.

## Shared Modules

- `HerdrFileTree`: DOM tree rendering, folder/file icons, status badges, collapsed folders, selection, and context/action hooks. Used by file browser and Git changed-file tree.
- `HerdrEditor`: editor/preview wrapper backed by a minimal CodeMirror 6 bundle, with a static fallback.

## Backend

- Add `file_browser` Rust module.
- Add `GET /api/file-browser/tree` for directory entries.
- Add `GET /api/file-browser/file` for UTF-8 file preview.
- Add `POST /api/file-browser/file` for guarded saves.
- Canonicalize root and target paths. Reject traversal outside selected root.
- Cap directory result count and preview size.
- Support `dirs_only=true` for workspace/worktree directory pickers.

## Desktop UI

- Add file browser drawer next to Git drawer.
- Left side: `HerdrFileTree` folder navigation.
- Right side: `HerdrEditor` read-only preview, with edit/save path later.
- Header button opens current workspace checkout path.

## Mobile UI

- Add `Files` nav item.
- Tree-first screen with folder tap expansion.
- File tap opens preview in same screen with back action.
- Reuse same backend and shared frontend modules.

## Git Migration

- Keep existing Git tree/action UI while file browser lands.
- Move Git changed-file tree to `HerdrFileTree`. Done.
- Move Git side editor to `HerdrEditor`. Done for editable hunks.
- Add CodeMirror extensions for blame gutter, hunk decorations, and hunk action widgets. Foundation done in `HerdrEditor`; Git diff UI can opt into it incrementally.
- Keep Git log, stash, branch, and worktree actions outside CodeMirror.

## Workspace/Worktree Picker Migration

- Replace autocomplete path suggestions with a directory picker backed by `HerdrFileTree`. Foundation done for desktop path inputs; autocomplete remains as fallback.
- Keep manual path input for power users.
- Remove `/api/path-suggestions` only after tree picker is stable. Pending.

## CodeMirror Direction

- Add minimal CodeMirror 6 bundle after this foundation is merged. Done.
- Include only edit, syntax, line numbers, undo/redo, read-only mode, and theme.
- Skip debug, lint, autocomplete, minimap, and language server features.
