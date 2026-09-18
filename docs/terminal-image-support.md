# Terminal image display: feasibility analysis

Status: analysis only, no code change yet. Answers: "can the WebUI terminal
display images (e.g. jcode-generated), and what are the implications and
technical decisions?"

## Short answer

Yes, and the cheapest correct path is already 80% built. The renderer stack
(@wterm/dom + @wterm/ghostty) gained native Kitty Graphics Protocol support in
0.5.0, but this repo pins 0.3.0 and strips image escapes defensively. Upgrading
the wterm packages to 0.5.0, un-stripping Kitty sequences on the Ghostty core,
and advertising capability to the PTY environment would make jcode's inline
images appear in the browser terminal. iTerm2/Sixel remain non-renderable and
must stay filtered.

## Why images are invisible today

1. PTY env (builtin backend, `src/builtin_backend.rs`): `TERM=xterm-256color`,
   `COLORTERM=truecolor`, no `TERM_PROGRAM`, no `KITTY_WINDOW_ID`. External
   herdr also sets `TERM=xterm-256color`.
2. jcode detection (`crates/jcode-terminal-image/src/display.rs`,
   `infer_protocol_from_env` in `jcode-tui-mermaid`): with this env the Kitty
   path is never selected. Worst case, if ImageMagick (`convert`) is installed,
   `TERM` containing "xterm" makes `detect_sixel()` return true and jcode emits
   Sixel DCS payloads that no web renderer can draw.
3. Browser adapter (`src/assets/shared/terminal_adapter.js`): every write passes
   `filterTerminalImageSequences()` which rewrites iTerm2 OSC 1337, Kitty
   `ESC_G`, and Sixel DCS into a text placeholder
   ("[inline image omitted: ...]"). This was added in 0.2.80 (see
   `docs/release-notes.md`) because wterm 0.3.0 cannot render them and raw
   base64 would leak into scrollback.
4. Renderer cores at 0.3.0: wterm built-in core consumes but does not draw
   Kitty APC; Ghostty 0.3.0 WASM pre-dates the graphics API
   (`getGraphicsState`/`getGraphicsImage` absent).

jcode image sources that would benefit once support lands:

- `read` tool on image files (`handle_image_file`): displays via detected
  protocol, plus returns base64 to the model for vision.
- TUI inline transcript images (`ui_inline_image.rs`): pasted screenshots,
  generated images render via Kitty picker, with text fallback otherwise.

## What changed upstream (verified 2026-09-18)

- `@wterm/ghostty` 0.5.0: optional terminal graphics API. Direct Kitty
  PNG/RGB/RGBA images render as transient, bounded canvas overlays; pinned
  placements follow scrollback/scroll/resize/screen switches; implicit
  auto-sized placements reserve their height in visual flow. Explicitly NOT
  supported: Sixel, iTerm2/OSC 1337, animation, virtual Unicode placements,
  file/shared-memory/URL media, image persistence across reconnect.
  `imageStorageLimit` option (default 32 MiB decoded, `0` disables graphics).
- `@wterm/dom` 0.5.0: consumes the graphics API, `maxImageWidth/Height`
  options, answers `CSI 14t/16t` pixel-geometry queries (needed by Kitty
  clients to size/place images), grapheme clusters, OSC 8 links.
- `@wterm/core` 0.5.0: optional `getGraphicsState()`/`getGraphicsImage()` in
  the `TerminalCore` contract; built-in core safely swallows unsupported Kitty
  APC sequences without advertising graphics.
- Upstream tracking issue for the older renderer: vercel-labs/wterm issue #60
  (still open; superseded in practice by Ghostty-core graphics support).

## Data flow today (all three surfaces: desktop, mobile, temp terminal)

```
PTY child (jcode) -> portable-pty master reader thread
  -> builtin scrollback ring (MAX_SCROLLBACK_BYTES = 8 MiB)
  -> terminal socket frames (MAX_FRAME_SIZE = 32 MiB)
  -> browser /ws/terminal (binaryType=arraybuffer)
  -> enqueueTerminalFrame (RAF batching, IMMEDIATE_WRITE_THRESHOLD = 8 KiB,
     LARGE_FRAME_THRESHOLD = 32 KiB)
  -> HerdrWtermAdapter.write()
       -> applyMouseModeSequences() sniffs DECSET/DECRST
       -> filterTerminalImageSequences() STRIPS images here  <-- the gate
  -> wterm.write() -> core (wterm zig | ghostty wasm) -> DOM
```

## Technical options

### Option A: Upgrade wterm to 0.5.0 and render Kitty via Ghostty core (recommended)

Changes needed in herdr-webui:

1. `package.json`: bump `@wterm/core`, `@wterm/dom`, `@wterm/ghostty` 0.3.0 ->
   0.5.0; regenerate `src/assets/vendor/wterm.bundle.js`,
   `wterm.css`, `ghostty-vt.wasm` via `scripts/build_wterm_assets.mjs` (WASM
   grows ~429 KB -> ~577 KB).
2. `scripts/build_wterm_assets.mjs`: the aria-hidden patch target string
   changed in 0.5.0 to `setAttribute("aria-hidden", "true")` (space added);
   the current no-space regex no-ops silently. Update patch + assert it applied.
3. `src/assets/shared/terminal_adapter.js`:
   - Keep `filterTerminalImageSequences` for iTerm2 and Sixel.
   - Split: when `core === "ghostty"` pass Kitty `ESC_G` through (including
     chunked `m=1` continuation state), keep filtering on `wterm` core.
     Keep the `imageEscapeBuffer` carry across chunks for the filtered path.
   - Pass `imageStorageLimit` (default 32 MiB is fine) and consider
     `maxImageWidth/Height` display caps.
4. `src/builtin_backend.rs` `terminal_environment()`: set `TERM_PROGRAM` /
   `TERM` hints so jcode picks Kitty. Two sub-decisions:
   - a) Keep `TERM=xterm-256color` for compat and set `TERM_PROGRAM=ghostty`
     (jcode's `infer_protocol_from_env` matches `ghostty` in TERM_PROGRAM, and
     `jcode-terminal-image` `is_kitty_terminal_name` matches `ghostty` in
     TERM_PROGRAM too). This also disables the accidental Sixel-on-xterm path.
   - b) Termenv/terminfo must still resolve for the value chosen. `xterm-256color`
     is safe; advertising `xterm-ghostty` via TERM would need a terminfo entry
     and changes terminfo-driven apps; TERM_PROGRAM is not terminfo-bound.
   - Clearing stale `KITTY_WINDOW_ID` from inherited env (browser-launched
     backends can inherit a real kitty/ghostty session's vars and jcode would
     then emit graphics the pane will never draw).
5. Attach replay: the backend replays `history_bytes()` (raw) on attach.
   Kitty graphics state is NOT persisted by the Ghostty core (transient), so
   after reconnect the image is gone but the reserved rows remain scrolled
   past. Acceptable; note it in docs. Keep MAX_SCROLLBACK_BYTES as-is (8 MiB
   ring already bounds memory; the terminal socket frames already handle up to
   32 MiB frames).
6. `pane.read` / agent status screen-scrape: base64 payloads inside OSC/DCS
   escapes are skipped by `skip_osc` / control-char skipping in
   `terminal_text.rs`/`tui_terminal.rs`, but DCS (Sixel `ESC P`) and APC
   (`ESC _`) bodies are NOT terminated by those parsers (they only know BEL
   and ST). With Kitty pass-through enabled, `pane.read` and jcode status
   detection would leak base64 text into `read_pane_recent` output and the
   agent-status screen-scrape. Needs a small parser fix (skip until ST for
   DCS/APC) BEFORE un-stripping Kitty. This is the main hidden cost of the
   whole feature.
7. Tests: update `src/assets/terminal_adapter.test.mjs` (filter tests keep
   for wterm core; new pass-through tests for ghostty core), node --check, the
   four app_*.test.mjs suites, cargo check/test. Docs: features.md line ~60,
   release-notes, Help modal text, README mention.

Why recommended: no hand-rolled escape parsing in the adapter beyond what
exists, one core switch, upstream-maintained decoding (Wuffs PNG/RGB/RGBA in
WASM), bounded memory, and the same API works for desktop, mobile, and temp
terminals because they all go through `HerdrWtermAdapter.write()`.

Risks/implications:

- Memory: decoded image budget is capped by `imageStorageLimit` (32 MiB per
  screen) plus a 32 MiB canvas backing-store cap and 4096 image/placement
  descriptor caps; the scrollback ring stays at 8 MiB regardless. Images are
  transient; reconnect loses them (backend replay has no image state).
- Bandwidth: a 1 MB PNG becomes ~1.37 MB base64 through the PTY -> socket ->
  browser pipeline. `display_kitty` chunks at 4 KiB; many small writes hit the
  RAF batching path. No protocol-level backpressure change needed, but
  attach-time replay of image-heavy scrollback can momentarily spike CPU in
  the ghostty core; the LARGE_FRAME loading overlay already covers the worst
  case.
- Interaction: wterm images are pointer-transparent (`aria-hidden` canvases),
  so text selection/copy/link click keep working; wheel scroll unaffected.
- TUI client (`herdr-webui-tui`) stays unaffected: it never got the image
  escapes today (they are stripped browser-side AFTER the backend, so the TUI
  already receives raw sequences; `tui_terminal.rs` skips OSC via BEL/ST and
  would leak DCS/APC base64 into status lines — same parser fix needed as (6).
  Actually the TUI reads the same raw stream; verify after the fix that
  screen-scrape status detection on jcode panes doesn't regress).

### Option B: Custom image rendering in the adapter (intercept + overlay divs)

Parse Kitty/iTerm2/Sixel ourselves in JS, decode images, absolutely position
<img>/canvas overlays in the terminal container, track scroll/resize.

Rejected for now: duplicates the upstream 0.5.0 work, the hard parts
(pinned-placement anchoring through scrollback and resize, implicit placement
flow) are exactly what upstream solved, and maintaining escape parsing for
three protocols (chunked state machine) is a long-term liability. Only worth
revisiting if upstream stalls or we need iTerm2/Sixel specifically.

### Option C: Do nothing in the renderer; expose images outside the terminal

Two sub-paths already possible with zero renderer work:

- File browser: serve raw image bytes via an authenticated `/api/file-browser/file?...`
  variant and show an <img> preview for binary image extensions instead of
  "Binary file preview unavailable". jcode writes generated images to disk, so
  users can open them in the Files tab. Cheap, but does not answer "images in
  the terminal context" and does not follow scrollback.
- chafa text fallback (documented today): jcode could be told to emit
  chafa braille art; works everywhere, loses fidelity.

Useful complements, not substitutes. Could be done independently of Option A.

## Recommended decision

Adopt Option A, in this order:

1. Parser hardening first (terminal_text.rs / tui_terminal.rs DCS+APC skip),
   with regression tests. Independent of everything else and fixes a latent
   leak even if we never render images.
2. Upgrade @wterm packages to 0.5.0 with the build-script patch fix. Verify
  both cores still pass existing tests before touching the image filter.
3. Gate Kitty pass-through on the Ghostty core in the adapter (keep iTerm2/
   Sixel filtered everywhere), with settings text and docs updated together
  per the repo's parity rules.
4. PTY env: set `TERM_PROGRAM=ghostty` for built-in panes (and same for
   external herdr upstream if desired), so jcode picks Kitty; scrub inherited
   KITTY_WINDOW_ID.
5. E2E validation: run a pane under the real flow, emit a Kitty test image
   (jcode `read` of a PNG), verify render on Ghostty core, placeholder on
   wterm core, clean pane.read output, and stable agent-status detection.

## Open questions (answer before implementation)

- Is Ghostty core the default for new users today? (Settings default is
  `wterm`.) If it stays default, most users still see the placeholder; a
  feature flag or default flip decision is needed.
- Should the mobile/temp-terminal surfaces get a settings toggle for inline
  images, or inherit the desktop setting?
- Does external herdr (the other backend) want the same TERM_PROGRAM hint?
  (Out of this repo's scope but affects parity.)

## Observed evidence (real-path validation, 2026-09-18)

All observations below come from the real built server
(`./target/debug/herdr-webui --https off --bind 127.0.0.1:8891
--session imgtest-e2e --backend-mode builtin`, isolated XDG/HOME config)
driven by a real client built on this crate's own public API
(`BackendClient` + `attach_terminal` + `send_input` + `read_event`,
integration client kept outside the repo at `/tmp/herdr-imgtest.Wg8S4A/`).

1. **Escape delivery is NOT the blocker.** Pushing real Kitty
   (`ESC _ G a=T,f=100...;b64...ESC \`), Sixel (`ESC P 0;1q ... ESC \`), and
   iTerm2 (`ESC ] 1337;File=...`) sequences through a live PTY pane and
   reading the terminal socket stream (the exact bytes `/ws/terminal`
   forwards to the browser) shows all three protocols are delivered
   byte-complete and unfiltered: escape framing intact, base64 payloads
   intact, all command sentinels intact. The only image stripping happens
   client-side in `filterTerminalImageSequences()`. Therefore the wterm
   upgrade alone is sufficient for the wire path; the filter gate is a
   pure client-side toggle decision.
2. **The pane.read leak is real and confirmed.** After emitting the same
   escapes, `pane.read` returns text containing the Kitty base64 payload
   (`iVBORw0KGgoAAAANSUhEUg==`), the raw `ESC _ G` framing, the Sixel
   raster bytes, and the iTerm2 base64. Any consumer of `pane.read`
   (herdr-webui-tui, agent-status detection) sees image payloads as text
   garbage today. This hardens the case for doing step 1 (parser
   hardening) first.
3. **Env detection finding: TERM_PROGRAM leaks.** A fresh pane in the
   test session reports `TERM=xterm-256color`, and - unexpectedly -
   `TERM_PROGRAM=iTerm.app` with `COLORTERM=truecolor`, inherited from the
   shell that launched the server. Consequences: (a) jcode's env-based
   Kitty detection (`TERM_PROGRAM` in ghostty/kitty set) sees iTerm.app and
   may pick iTerm2 graphics, which wterm 0.5.0 does NOT render - the
   placeholder path again; (b) any env hint we set must be set
   explicitly on PTY spawn, and inherited values must be scrubbed.
4. **Query-based detection cannot work.** A `CSI c` (DA1) probe sent to a
   pane is echoed by the shell but never answered on the terminal socket:
   the terminal emulator lives in the browser, not the server, so nobody
   responds to DA1/XTGETTCAP. jcode's `ImageProtocol::detect` (query
   DA1, wait for response) will always time out and fall back under
   herdr-webui. Only the env-variable route can steer it.
5. **ImageMagick is absent on this host** (`magick: command not found`),
   so jcode's Sixel claim on this machine relies on a non-ImageMagick
   path or is stale; do not assume ImageMagick-backed Sixel works here.
6. **Latent TUI bug found and fixed during validation:** the shipped
   `herdr-webui-tui` and `BackendClient` spoke protocol 16 while the
   server requires 22, so the shipped TUI could not attach to the shipped
   server at all. `BUILTIN_TUI_PROTOCOL_VERSION` bumped 16 -> 22 in
   `src/backend_client.rs`; all 534 tests pass after the fix. This bug
   exists on master too and is a prerequisite for any TUI-side image work.

What was NOT verified (and cannot be without the upgrade): actual wterm
0.5.0 Kitty rendering in the real browser app. The scratch-install
verification (getGraphicsState/getGraphicsImage, imageStorageLimit
default 32 MiB, CSI 14t/16t answers, WASM 429KB -> 577KB, aria-hidden
patch drift) covers the library surface only; end-to-end render
verification remains step 5 of Option A.