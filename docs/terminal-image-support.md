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

The plan splits by backend because their pipelines differ (see the
cross-backend matrix under Observed evidence below):

**Builtin backend (raw escape pass-through):**

1. Parser hardening first (terminal_text.rs / tui_terminal.rs DCS+APC skip),
   with regression tests. Independent of everything else and fixes a latent
   leak even if we never render images.
2. Upgrade @wterm packages to 0.5.0 with the build-script patch fix. Verify
  both cores still pass existing tests before touching the image filter.
3. Gate Kitty pass-through on the Ghostty core in the adapter (keep iTerm2/
   Sixel filtered everywhere), with settings text and docs updated together
  per the repo's parity rules.
4. PTY env: set `TERM_PROGRAM=ghostty` for built-in panes, so jcode picks
   Kitty; scrub inherited `TERM_PROGRAM`/`KITTY_WINDOW_ID` (both leak in
   from the launching shell).
5. E2E validation: run a pane under the real flow, emit a Kitty test image
   (jcode `read` of a PNG), verify render on Ghostty core, placeholder on
   wterm core, clean pane.read output, and stable agent-status detection.

**External herdr backend (structured graphics pipeline):**

1. Provide real cell metrics: the webui bridge currently attaches with
   `cell_width_px: 0`, which makes herdr answer `pane.graphics.info` with
   `cell_size_unavailable` and disables its graphics relay. Forward the
   browser terminal's real cell size on attach/resize (`ClientMessage::
   Resize` already carries cell px fields).
2. Consume herdr's graphics protocol instead of raw escapes: handle
   `ServerMessage::Graphics` / `GraphicsFile` frames and the
   `pane.graphics.*` API/subscription events in the bridge, and render
   images as canvas overlays in the frontend from that structured data.
3. The adapter's Kitty passthrough/filter is IRRELEVANT for external
   panes: raw escapes never reach the browser. Do not gate external image
   support on the wterm upgrade.
4. Parser hardening is NOT needed for external `pane.read` (already
   clean), but the webui's builtin-side parsers and its own API proxy
   still need it for builtin sessions.

**Shared (both backends):**

- PTY env scrubbing: the `TERM_PROGRAM` leak exists on both; setting
  `TERM_PROGRAM=ghostty` matters only where raw Kitty escapes flow
  (builtin). For external, herdr consumes jcode's Kitty emission
  server-side regardless of env.
- jcode's query-based `ImageProtocol::detect` cannot complete on either
  backend: builtin has no DA1 responder at all, and external answers DA1
  (`?62;22c`, VT200+color, nothing image-specific) but stays silent on
  XTGETTCAP/Kitty graphics queries, so the Kitty probe never completes.
  Env-based detection is the only reliable route on both backends.

## Open questions (answer before implementation)

- Is Ghostty core the default for new users today? (Settings default is
  `wterm`.) If it stays default, most users still see the placeholder; a
  feature flag or default flip decision is needed.
- Should the mobile/temp-terminal surfaces get a settings toggle for inline
  images, or inherit the desktop setting?
- Does external herdr (the other backend) want the same TERM_PROGRAM hint?
  (Refined: yes, but for a different reason than builtin. External herdr
  consumes jcode's Kitty emission server-side into its graphics layer
  regardless of env; setting `TERM_PROGRAM=ghostty` there steers jcode to
  the Kitty emitter - the protocol herdr's `src/kitty_graphics.rs` is built
  around - instead of iTerm2/Sixel output that herdr would also consume
  but with less graphics-pipeline fidelity. Scrubbing the inherited
  `TERM_PROGRAM=iTerm.app` matters on both.)
- External backend scope decision: does this repo take on rendering
  herdr's structured graphics (bridge + frontend overlay work), or ship
  builtin-only image support first and treat external as phase 2?
  100% coverage across both backends requires the graphics-pipeline work
  above; it cannot ride the wterm 0.5.0 escape passthrough.

## Observed evidence (real-path validation, 2026-09-18)

### Cross-backend behavior matrix (clean real escapes, no echo pollution)

Identical clean inputs (real `ESC _ G` Kitty, real `ESC P` Sixel DCS, real
`ESC ] 1337` iTerm2 escapes emitted via a python `bytes([...])` heredoc so
the typed text never contains recognizable payload bytes) driven through
the real `/ws/terminal` bridge against both backends:

| Observation | Builtin backend | External herdr 0.9.0 |
| --- | --- | --- |
| Kitty `ESC_G` reaches browser stream | YES (escape + payload intact) | NO (consumed server-side) |
| Sixel DCS reaches browser stream | YES | NO (consumed server-side) |
| iTerm2 OSC 1337 reaches browser stream | YES | NO (consumed server-side) |
| Payload text leaks into `pane.read` | YES (all three) | NO (clean; only command echo remains) |
| Server-side image interception | none (raw PTY pass-through) | consumes all 3 protocols server-side (structured graphics layer; observed with kitty_graphics enabled - daemon inherited the user config where experimental.kitty_graphics=true; default true per herdr 0.9.1 config reference) |
| `TERM` in pane env | xterm-256color | xterm-256color |
| `TERM_PROGRAM` in pane env | leaks from launching shell (observed `iTerm.app` on this host) | same leak observed |
| `KITTY_WINDOW_ID` in pane env | unset | unset |
| DA1 (`CSI c`) answered | NO (emulator lives in browser) | YES: `ESC[?62;22c` on pane stdin, instant (raw-mode capture t=0.0s) |
| CSI 14t/16t/18t (px geometry) answered | NO | NO |
| XTGETTCAP (Tc/RGB) answered | NO | NO |
| DECRPM sixel (`?1070 $ p`) answered | NO | NO |

External DA1 answers exist because herdr 0.9.0 runs each pane through
its embedded Ghostty VT server-side (`terminal_responses` written back to
the pane PTY); see herdr source `src/pane/terminal.rs`,
`src/pty/actor/unix.rs`, and `vendor/libghostty-vt`. Note the answer is
written to pane STDIN, never forwarded to the browser stream, so browser
renderers never see it.

**Consequence for the design:** the two backends need different solutions.

- **Builtin**: pure pass-through. The Option A plan (wterm 0.5.0 upgrade +
  Kitty passthrough on Ghostty core + env hints) applies directly, because
  the browser receives the raw Kitty bytes.
- **External herdr 0.9.0**: the server consumes all three image protocols
  (observed: clean char-coded escapes never reach the browser stream and
  `pane.read` stays clean) and exposes a structured graphics surface
  (`pane.graphics.set/clear/info` API, `Graphics` server frames,
  `pane_graphics_frame_ack` events, `file_frame_*` transport, and a
  server-side `src/kitty_graphics.rs` gated by `terminal.kitty_graphics`,
  default true per herdr 0.9.1 config reference). The wire mechanics of
  how graphics reach the browser are under investigation via source
  review; rendering external-session images in the webui requires
  consuming that structured pipeline rather than forwarding escapes.
  The webui bridge attaches with `cell_width_px: 0`, and `pane.graphics.info`
  answers `cell_size_unavailable`; real cell metrics are a prerequisite.
  Leak profile differs too: external `pane.read` is already clean of image
  payloads (parser hardening in step 1 is less urgent for external, still
  needed for builtin and for the webui's own `pane.read` API proxy).

All observations come from the real built server
(`./target/debug/herdr-webui --https off --bind 127.0.0.1:8891
--session imgtest-e2e --backend-mode builtin`, isolated XDG/HOME config)
driven by a real client built on this crate's own public API
(`BackendClient` + `attach_terminal` + `send_input` + `read_event`,
integration client kept outside the repo at `/tmp/herdr-imgtest.Wg8S4A/`),
plus a real external herdr 0.9.0 daemon (`herdr server` on scratch sockets
`/tmp/herdr-imgtest.Wg8S4A/ext-herdr{,-client}.sock`) attached through the
same webui binary in `--backend-mode external-herdr` (port 8892), with the
browser WS path replicated by a real WebSocket client
(`websockets` python) speaking the same `/ws/terminal` protocol the
frontend uses. External herdr is the user's real installed `herdr 0.9.0`
binary, run as an isolated daemon on scratch sockets; the user's own
herdr session was never touched.

1. **Escape delivery is NOT the blocker (builtin backend).** Pushing real Kitty
   (`ESC _ G a=T,f=100...;b64...ESC \`), Sixel (`ESC P 0;1q ... ESC \`), and
   iTerm2 (`ESC ] 1337;File=...`) sequences through a live PTY pane and
   reading the terminal socket stream (the exact bytes `/ws/terminal`
   forwards to the browser) shows all three protocols are delivered
   byte-complete and unfiltered on the BUILTIN backend: escape framing
   intact, base64 payloads intact, all command sentinels intact. The only
   image stripping happens client-side in
   `filterTerminalImageSequences()`. Therefore the wterm upgrade alone is
   sufficient for the builtin wire path; the filter gate is a pure
   client-side toggle decision. (The external backend differs; see the
   matrix above.)
2. **The pane.read leak is real and confirmed (builtin backend).** After
   emitting the same escapes, builtin `pane.read` returns text containing
   the Kitty base64 payload (`iVBORw0KGgoAAAANSUhEUg==`), the raw `ESC _ G`
   framing, the Sixel raster bytes, and the iTerm2 base64. Any consumer of
   builtin `pane.read` (herdr-webui-tui, agent-status detection) sees image
   payloads as text garbage today. This hardens the case for doing step 1
   (parser hardening) first. The external backend's `pane.read` (source
   `recent`/`visible`, formats `text`/`ansi`) is already clean of image
   payloads - herdr 0.9.0 filters them into its graphics layer - so the
   leak is builtin-specific.
3. **Env detection finding: TERM_PROGRAM leaks (both backends).** Fresh
   panes report `TERM=xterm-256color`, and - unexpectedly -
   `TERM_PROGRAM=iTerm.app` with `COLORTERM=truecolor`, inherited from the
   shell that launched the server, on BOTH backends. Consequences: (a)
   jcode's env-based
   Kitty detection (`TERM_PROGRAM` in ghostty/kitty set) sees iTerm.app and
   may pick iTerm2 graphics, which wterm 0.5.0 does NOT render - the
   placeholder path again; (b) any env hint we set must be set
   explicitly on PTY spawn, and inherited values must be scrubbed.
   External nuance: setting `TERM_PROGRAM=ghostty` (or `kitty`) on external
   panes is still USEFUL - not for escape routing, but so jcode picks the
   Kitty emitter, whose output herdr then ingests server-side into its
   graphics layer. iTerm2 OSC 1337 and Sixel are consumed by herdr too, but
   Kitty is the protocol herdr's graphics pipeline is built around
   (`src/kitty_graphics.rs`), so steering jcode to Kitty maximizes
   compatibility.
4. **Query-based detection split by backend (round-2 correction).** On the
   BUILTIN backend, DA1 is never answered: the emulator lives in the
   browser, so a pane-side `CSI c` has no responder on the server side.
   On the EXTERNAL backend, herdr 0.9.0 DOES answer DA1 - instantly and on
   the pane's stdin - because pane output is processed server-side by
   herdr's embedded Ghostty VT (vendored `libghostty-vt`), whose
   `process_pty_bytes` returns `terminal_responses` that herdr's PTY actor
   writes straight back to the PTY (verified in herdr 0.9.0 source:
   `src/pane/terminal.rs` + `src/pty/actor/unix.rs`). The reply is
   `ESC[?62;22c` (VT200 conformance level 62 + ANSI color 22, xterm-style;
   no Sixel attribute 4, no kitty advertisement). Round-1's "no DA1
   answer" was a measurement artifact, and round-1's one-time `62;22c`
   observation is now fully explained (see the correction note below).
   Side findings on external: CSI 14t/16t/18t (pixel/cell geometry) are
   NOT answered, XTGETTCAP (Tc, RGB) is NOT answered, DECRPM sixel
   (`CSI ?1070 $ p`) is NOT answered, `KITTY_WINDOW_ID` is unset. So even
   on external, jcode's query-based `ImageProtocol::detect` cannot
   complete a Kitty graphics probe (no XTGETTCAP answer), and DA1 alone
   advertises nothing about image support. Env-based detection remains the
   only reliable route on both backends.

   Correction note (honesty): the round-1 observation `?62;22c` appearing
   "rendered at the zsh prompt, never reproducible" is now explained: the
   reply arrives on pane stdin WITH NO trailing newline while the tty is
   in canonical mode with echo. A canonical-mode reader's `select()` never
   fires, so naive probes read `NONE`; the bytes sit in the input queue and
   zsh's line editor later inserts them into the next typed command (proof:
   `~/.zsh_history` entries `62;22cprintf ...` / `62;22cclear` exactly at
   probe timestamps). A raw-mode (`termios` ICANON/ECHO off) foreground
   reader captures the reply at t=0.0s deterministically. Probes stored at
   `/tmp/herdr-imgtest.Wg8S4A/probe10.py`.
5. **ImageMagick is absent on this host** (`magick: command not found`),
   so jcode's Sixel claim on this machine relies on a non-ImageMagick
   path or is stale; do not assume ImageMagick-backed Sixel works here.
6. **Latent TUI bug found and fixed during validation:** the shipped
   `herdr-webui-tui` and `BackendClient` spoke protocol 16 while the
   server requires 22, so the shipped TUI could not attach to the shipped
   server at all. `BUILTIN_TUI_PROTOCOL_VERSION` bumped 16 -> 22 in
   `src/backend_client.rs`; all 534 tests pass after the fix. This bug
   exists on master too and is a prerequisite for any TUI-side image work.

7. **External DA1 answering mechanism (round-2, source-verified).** herdr
   0.9.0 processes every pane's PTY output through an embedded Ghostty VT
   (vendored `libghostty-vt`, see `src/ghostty/` in the herdr repo), and
   terminal query responses (DA1, XTGETTCAP, etc.) are written back to the
   pane PTY input by the PTY actor (`src/pty/actor/unix.rs`
   `read_once` -> `enqueue_terminal_responses`, immediate). DA1 therefore
   answers `ESC[?62;22c` at t=0.0s (raw-mode `termios` reader,
   deterministic across fresh panes p1/p2/p3). The earlier "never
   reproducible" observation was a canonical-mode tty artifact: the reply
   carries no newline, so `select()` on a canonical tty never fires; the
   bytes sat in the input queue and zsh's line editor pasted them into the
   next typed command (evidence: `~/.zsh_history` entries `62;22cprintf
   ...` at probe timestamps). herdr's graphics engine itself is
   `src/kitty_graphics.rs`, gated by `terminal.kitty_graphics` (default
   true per the herdr 0.9.1 config reference; the deprecated
   `experimental.kitty_graphics` is honored for compatibility), and the
   error string "pane graphics are disabled by terminal.kitty_graphics"
   exists in the shipped binary. herdr is open source
   (github.com/herdrdev/herdr, tag v0.9.0); this analysis reviewed
   `src/kitty_graphics.rs`, `src/pane/terminal.rs`, `src/pane.rs`,
   `src/pty/actor/unix.rs`, `src/ghostty/bindings.rs` presence, and the
   config reference for these claims.

What was NOT verified (and cannot be without doing the work): (a) actual
wterm 0.5.0 Kitty rendering in the real browser app (scratch-install
verification covers the library surface only: getGraphicsState/
getGraphicsImage, imageStorageLimit default 32 MiB, CSI 14t/16t answers,
WASM 429KB -> 577KB, aria-hidden patch drift); end-to-end render
verification remains builtin step 5. (b) External herdr's graphics relay
end-to-end: raw protocol probing confirmed the attach variant (index 5 on
the wire), that `cell_width_px` is carried in TerminalHello/Resize, and
that `pane.graphics.info` still answers `cell_size_unavailable` even while
a direct client holds an 8x16-cell attach. Source review located the
graphics relay pieces (server `src/server/client_shell_graphics.rs`,
`src/client/direct_graphics.rs`, `src/client/shell/graphics.rs`) but did
not trace the full arming conditions (which client type, hello fields, or
subscription arms `Graphics` frame delivery); that wiring remains open.