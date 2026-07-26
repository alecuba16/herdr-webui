# Markdown + Mermaid Preview — Plan

## Goal

Add a rendered markdown preview (with mermaid diagram support) to the file
explorer. `.md`/`.markdown` files open as a formatted, readable view instead of
raw source. Mermaid fenced blocks render as SVG diagrams.

## Library choice (performance + size)

Repo constraints (from `docs/development.md`): vanilla JS frontend, no build
step, vendor bundles checked in via esbuild, assets embedded by Rust. So we
need a small markdown parser and sanitizer lazy-loaded when the first markdown
preview opens, plus a heavy mermaid renderer lazy-loaded only when a preview
actually contains Mermaid blocks.

| Lib | Min | Gzip | Role |
| --- | --- | --- | --- |
| `marked` | 40 kB | 12.7 kB | Markdown -> HTML parser, lazy-loaded on first preview |
| `dompurify` | ~28.5 kB | 10.7 kB | Sanitize marked output, lazy-loaded with marked |
| `mermaid` | ~3.45 MB | ~950 kB | Diagram renderer, lazy-loaded only when needed |

Why `marked` over `markdown-it` (44.6 kB gzip) / `micromark`: smallest gzip,
fast, CommonMark+GFM via `marked-gfm-heading-id` is optional. marked does not
sanitize, so DOMPurify is required on output HTML before injecting. DOMPurify
is small, vetted, and the recommended pairing in marked's README.

Why lazy-load all preview assets: most sessions never open a markdown file, and
most markdown files have no diagrams. Load marked and DOMPurify on first
preview. Load `/assets/vendor/mermaid.js` only when the rendered preview
contains a Mermaid block.

## Architecture (matches existing patterns)

```
src/assets/vendor/
  marked.bundle.js        NEW  esbuild IIFE, global window.HerdrMarked
  mermaid.bundle.js       NEW  esbuild IIFE, global window.HerdrMermaid (lazy)
  dompurify.bundle.js     NEW  esbuild IIFE, global window.HerdrDOMPurify
  marked_entry.mjs        NEW  entry source
  mermaid_entry.mjs       NEW  entry source
  dompurify_entry.mjs     NEW  entry source
src/assets/shared/
  markdown_preview.js    NEW  window.HerdrMarkdownPreview.render(container, md)
  markdown_preview.css   NEW  prose styling, theme-aware via existing CSS vars
scripts/
  build_markdown_assets.mjs  NEW  esbuild script, mirrors build_wterm_assets.mjs
```

Rust side (`src/assets.rs`, `src/main.rs`): add `include_str!` constants and
routes mirroring the existing `vendor_codemirror_js` / `shared_editor_js`
pattern:

- `/assets/vendor/marked.js`
- `/assets/vendor/dompurify.js`
- `/assets/vendor/mermaid.js`
- `/assets/shared/markdown_preview.js`
- `/assets/shared/markdown_preview.css`

## Integration points (confirmed via codebase-memory)

- `src/assets/shared/editor.js` `create(opts)`: this is the single entry both
  desktop and mobile use. Add a markdown branch here so the change is shared.
- `src/assets/desktop/file_browser.js` `mountEditors()` (line ~686) and
  `renderToolbar()` (line ~622): add a "Preview/Source" toggle button for
  `.md` files; mount markdown preview instead of CodeMirror when toggled on.
- `src/assets/mobile/file_browser.js` `renderPreview` (line ~461): same shared
  `HerdrEditor.create` call, so it inherits the change.
- `src/assets/app_boot.js`: load the preview shell during boot, but defer the
  marked, DOMPurify, stylesheet, and Mermaid assets until needed.

## Behavior

1. Open a `.md`/`.markdown` file -> default to rendered preview (not raw).
2. Toolbar adds `Source` button -> switches to current CodeMirror source view
   (read-only, with find). `Preview` button returns to rendered view.
3. Edit mode unchanged: `Edit` still opens CodeMirror editable, `Save`/`Cancel`
   as today. Rendered preview is only the read-only default for markdown.
4. Rendered preview: `marked.parse(md)` -> `DOMPurify.sanitize(html)` -> inject.
   Apply `markdown_preview.css` for prose (headings, lists, tables, code).
5. Mermaid: after inject, if container has `.mermaid` elements, lazy-load
   `mermaid.js` (cache the promise), call `mermaid.run({ nodes })`. If no
   mermaid blocks, never load the library.
6. Theme: reuse existing CSS vars (`--fg`, `--bg`, `--panel2`, `--accent`,
   `--border`) so preview matches light/dark. Mermaid theme picked from
   current app theme (dark vs default).
7. Find (`Ctrl/Cmd-F`): in rendered preview, fall back to browser find on the
   rendered DOM; in source view, existing CodeMirror find toolbar. Keep
   `openFind` working on source view.
8. Search-highlight open from content search: when a `.md` result opens, open
   in source view at the matched line (current behavior) so highlight/scroll
   still works. Rendered preview stays the manual default.

## Files touched

New: 8 files listed above.
Modified:
- `src/assets/shared/editor.js` (markdown branch in `create`)
- `src/assets/desktop/file_browser.js` (`mountEditors`, `renderToolbar`,
  `previewPlaceholder`, source/preview toggle state)
- `src/assets/mobile/file_browser.js` (inherits via shared editor; minor)
- `src/assets/app_boot.js` (keep preview dependencies out of boot)
- `src/assets.rs`, `src/main.rs` (include_str + routes)
- `package.json` (devDeps: marked, dompurify, mermaid)
- `docs/technical-details.md`, `docs/features.md`, `docs/development.md`
- `Makefile` (add `build:markdown` step before `build:editor`/build assets)

## Risks / edge cases

- XSS: marked output MUST go through DOMPurify before `innerHTML`. This is the
  critical safety check; add a test that raw `<img onerror>` is stripped.
- Mermaid render errors: catch per-diagram, show the error text in place
  instead of crashing the whole preview.
- Large `.md`: existing truncation rules still apply before render.
- Mermaid theme mismatch in light/dark: pick theme from current app mode.
- Bundle size: boot adds no markdown parser, sanitizer, stylesheet, or Mermaid
  request. First preview adds ~23 kB gzip for marked and DOMPurify. First
  Mermaid diagram adds ~950 kB gzip for the generated Mermaid IIFE.

## Verification

- Unit test (`app_*.test.mjs` style): `HerdrMarkdownPreview.render` produces
  sanitized HTML, strips `<img onerror>`, and wraps mermaid blocks.
- Manual: open a `.md` with mermaid in desktop and mobile; confirm diagram
  renders, Source/Preview toggle works, Edit/Save still works, find works in
  source view, light/dark themes look right.
- Build: `make build:markdown` regenerates the three vendor bundles; `cargo
  build` embeds them; app boots and `/assets/vendor/marked.js` etc. resolve.

## Out of scope

- Markdown editing live-preview (render-as-you-type in edit mode).
- Other diagram formats (plantuml, etc.).
- Export to PDF/image.
