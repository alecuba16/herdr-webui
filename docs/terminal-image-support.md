# Terminal image display: feasibility analysis

Status: implementation round 4 steps 1-5 COMPLETE for the builtin
backend (2026-09-18). DCS/APC/SOS/PM payloads are skipped until ST in
all three text-strip sites, builtin `pane.read` strips ANSI to match
external herdr's default, @wterm is upgraded to 0.5.0, Kitty sequences
pass through to the Ghostty core (iTerm2/Sixel stay filtered), builtin
panes advertise `TERM_PROGRAM=ghostty` with inherited `KITTY_WINDOW_ID`
scrubbed at PTY spawn, and the full real flow is E2E-verified: a real
jcode `read`-tool PNG renders in the browser terminal on the Ghostty
core (placeholder on wterm). The external-herdr backend remains open
(phase-2 bridge rearchitecture, see the round-3 plan). The document
answers "can the WebUI terminal display images (e.g. jcode-generated),
and what are the implications and technical decisions?"

## Short answer

Yes for the builtin backend, and the cheapest correct path is already 80%
built. The renderer stack (@wterm/dom + @wterm/ghostty) gained native Kitty
Graphics Protocol support in 0.5.0, but this repo pins 0.3.0 and strips image
escapes defensively. Upgrading the wterm packages to 0.5.0, un-stripping
Kitty sequences on the Ghostty core, and advertising capability to the PTY
environment would make jcode's inline images appear in the browser
terminal. iTerm2/Sixel remain non-renderable and must stay filtered.

For the external-herdr backend the answer is "yes, but only after a bridge
rearchitecture" (round-3, source- and live-verified): herdr 0.9.0 consumes
image escapes server-side and relays pane graphics ONLY to ClientShell
endpoint clients (`endpoint.hello.v1` hello with `direct_graphics`); the
webui bridge's TerminalAttach mode is structurally excluded from graphics
delivery - an attach client watching the same pane receives the text but
zero image bytes. See the External herdr backend section and round-3
findings for the corrected plan.

## Why images are invisible today

1. PTY env (builtin backend, `src/builtin_backend.rs`): `TERM=xterm-256color`,
   `COLORTERM=truecolor`, and (since round 4 step 4) `TERM_PROGRAM=ghostty`
   with inherited `KITTY_WINDOW_ID` scrubbed at PTY spawn. External herdr
   also sets `TERM=xterm-256color` (no image hints).
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
4. PTY env (landed, round 4 step 4): `TERM_PROGRAM=ghostty` is set for
   built-in panes and inherited `KITTY_WINDOW_ID` is removed at PTY spawn
   (`TERMINAL_ENV_SCRUB_KEYS` + `CommandBuilder::env_remove`), so jcode
   picks Kitty and a leaked real-kitty ID cannot misdirect it.
5. E2E validation (landed, round 4 step 5): the real jcode `read` tool's
   Kitty PNG emit renders on the Ghostty core and substitutes the
   placeholder on wterm, verified live on both cores
   (`just jcode-image-flow-e2e`), with clean visible text and stable
   pane status.

**External herdr backend (structured graphics pipeline):**

Round-3 correction (source + live verified on herdr 0.9.0): the original
plan assumed the webui bridge could arm herdr's graphics relay by
providing cell metrics on its existing attach connection. That is wrong:
herdr delivers pane graphics ONLY to ClientShell endpoint clients, and
the webui's bridge is a direct terminal client. The corrected plan:

1. The webui bridge would have to switch from TerminalHello +
   `AttachTerminal` to the endpoint hello (`EndpointControl`,
   `kind="endpoint.hello.v1"`, generation 1, JSON payload) - becoming a
   client-owned shell - to receive `PaneSurfaceFrame.graphics`
   (`SurfaceGraphicsScene` assets + placements) and
   `ServerMessage::GraphicsFile`. That is a different connection mode
   with different frame semantics (semantic frames of the whole shell
   surface, not per-terminal raw streams), i.e. a bridge rearchitecture,
   not a parameter change. Server-side arming requirements
   (herdr 0.9.0 `src/server/headless.rs:941` `client_supports_direct_graphics`):
   active shell client + `direct_graphics: true` + `pixel_mouse: true`
   + known cell size (from hello `cell_width_px/cell_height_px` +
   `surface_size`); the client-side profile gate
   (`src/client/handshake.rs` `direct_graphics_profile_allowed`) only
   arms under TERM_PROGRAM ghostty/wezterm (or TERM xterm-ghostty/
   xterm-kitty/xterm-wezterm, or KITTY_WINDOW_ID), local tty, not under
   TMUX/SSH.
2. `pane.graphics.*` API (`pane.graphics.set/clear/info/stream`) is a
   producer API: `pane.graphics.stream` pushes RGBA/BGRA frames INTO a
   pane layer (file or base64 payload, `FrameHeader` JSON + body). It
   does not subscribe the webui to pane graphics; consumption for
   clients is only the ClientShell surface-scene delivery above.
3. If the bridge stays a TerminalAttach client, external pane images are
   permanently invisible in the webui: the server renders attached
   terminals as virtual cell frames (`render_terminal_virtual`) with no
   graphics channel (verified live: an attach client watching the same
   pane where a shell client received the full Kitty upload+placement
   relay got the pane TEXT but zero `ESC_G` bytes).
4. The adapter's Kitty passthrough/filter is IRRELEVANT for external
   panes: raw escapes never reach the browser. Do not gate external image
   support on the wterm upgrade.
5. Parser hardening is NOT needed for external `pane.read` (already
   clean), but the webui's builtin-side parsers and its own API proxy
   still need it for builtin sessions.
6. Phasing decision for 100% coverage: ship builtin first (Option A),
   then external as phase 2 (bridge rearchitecture to ClientShell mode
   or a second parallel endpoint connection dedicated to graphics).

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
  (Refined round 2, reaffirmed round 3: yes, but only to steer jcode's
  emitter choice - herdr ingests Kitty/iTerm2/Sixel escapes server-side
  regardless of env, so the hint only ensures jcode emits Kitty, the
  protocol herdr's graphics pipeline is built around. Scrubbing the
  inherited `TERM_PROGRAM=iTerm.app` matters on both.)
- External backend scope decision (resolved round 3): the bridge cannot
  ride the existing attach connection; external image support requires
  the ClientShell-mode rearchitecture described above. Phasing: builtin
  first (Option A), external as phase 2. 100% coverage across both
  backends therefore needs both work streams; the wterm 0.5.0 upgrade
  alone covers only builtin.

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
  (`pane.graphics.set/clear/info/stream` API and a server-side
  `src/kitty_graphics.rs` gated by `terminal.kitty_graphics`, default true
  per herdr 0.9.1 config reference). The wire mechanics of how graphics
  reach the browser are now fully source- and live-verified (round 3):
  graphics are relayed ONLY to ClientShell endpoint clients
  (`EndpointControl` hello `endpoint.hello.v1` with `direct_graphics: true`),
  via `PaneSurfaceFrame.graphics` (`SurfaceGraphicsScene`: assets +
  placements) and `ServerMessage::GraphicsFile`; the webui's
  TerminalAttach bridge mode is structurally excluded (see round-3
  findings). The webui bridge attaches with `cell_width_px: 0`, and
  `pane.graphics.info` answers `cell_size_unavailable`; real cell metrics
  are a prerequisite for any ClientShell-style integration.
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
verification remains builtin step 5. (b) WAS closed by round 3 below:
herdr's graphics relay is now traced end-to-end and verified live.

8. **Round 3: herdr graphics relay fully traced + live-verified end-to-end
   (2026-09-18).** Using the sparse-cloned herdr v0.9.0 source
   (github.com/herdrdev/herdr) plus a live isolated daemon
   (`herdr server` on scratch sockets, session `imgext3`, never touching
   the user's real session), the complete arming + delivery chain was
   verified:

   - Arming: a shell client sends `EndpointControl` kind
     `endpoint.hello.v1` (generation 1) with `direct_graphics: true`,
     `pixel_mouse: true`, cell px, and `surface_size`. The herdr TUI
     client itself only sets `direct_graphics` when the terminal profile
     allows it (TERM_PROGRAM ghostty/wezterm, TERM xterm-ghostty/
     xterm-kitty/xterm-wezterm, or KITTY_WINDOW_ID; local tty; not
     TMUX/SSH) and the ioctl winsize reports pixel extent
     (`src/client/handshake.rs`, `src/client/terminal_geometry.rs`).
   - Server state: `client_supports_direct_graphics`
     (`src/server/headless.rs:941`) = active shell client + writer +
     `direct_graphics` + `pixel_mouse`; `host_cell_size` is set only
     while `kitty_graphics_enabled && cell_size.is_known()`
     (`src/server/headless.rs:841`), and resets when the last shell
     client leaves. Live: with the client connected,
     `pane.graphics.info` returns real cell metrics; after it detaches,
     the same call answers `cell_size_unavailable` (observed both).
   - Ingestion: pane PTY output goes through the vendored Ghostty VT;
     a canonical Kitty direct-RGBA transmit
     (`ESC_G a=T,f=32,t=d,i=7,p=3,s=2,v=2,c=10,r=5,q=2;<b64> ESC \`)
     is parsed and stored (test reference `src/ghostty/mod.rs`
     `kitty_graphics_direct_rgba_placement_is_queryable`). Server debug
     log live: `collect_visible_placements: done placements_len=1`,
     `clipped_placement: success`.
   - Delivery to shell clients: `src/server/client_shell_graphics.rs`
     `collect` builds a `SurfaceGraphicsScene` (assets + placements) into
     `PaneSurfaceFrame` for `ClientConnectionMode::ClientShell` only
     (`src/server/headless/render.rs` render_and_stream); the client
     shell re-encodes it as Kitty APC to its host terminal
     (`src/client/shell/graphics.rs` `compose_graphics`). Live: the shell
     client's pty received the full relay - upload
     `ESC_G a=t,t=d,f=32,s=2,v=2,i=24159,q=2,m=0;/wAA//8AAP//AAD//wAA/w== ESC \`
     then placement
     `ESC_G a=p,i=24159,p=146484,c=10,r=5,z=0,C=1,q=2,w=2,h=2 ESC \`.
   - `ServerMessage::GraphicsFile` (herdr's direct file-transfer path,
     `src/server/headless/pane_graphics.rs`) also targets ClientShell
     clients only (`matches!(client.mode, ClientShell)` gate), with an
     inline-data fallback when no shell client can take the file.
   - Negative control (live): a TerminalAttach client - exactly the
     webui bridge's mode, `TerminalHello` v22 + `AttachTerminal`
     (bincode-2 varint wire, variant index 5) to the same pane - received
     3.7-11.6 KiB of pane TEXT frames including the command output, but
     ZERO `ESC_G` bytes while the shell client got the full image relay.
     `ServerMessage::Graphics` (raw bytes variant) is never sent by the
     0.9.0 server at all.
   - Producer API: `pane.graphics.stream`
     (`src/api/server/pane_graphics_stream.rs`) pushes frames INTO pane
     layers (JSON `FrameHeader` + raw body, rgba/bgra, 16 MiB base64 /
     400 MiB file paths per `pane.graphics.info` live answer); it is not
     a subscription for clients.
   - Wire notes for any future bridge: the legacy `ClientShellHello`
     variant is rejected by 0.9.0 ("this client predates the stable
     endpoint protocol"); the live hello is `EndpointControl`/JSON.
     `HERDR_SESSION` on the client overrides `HERDR_SOCKET_PATH` socket
     derivation (session data dir wins), and `HERDR_SOCKET_PATH` derives
     the client socket as `<stem>-client.sock` - both matter for test
     harnesses. Probe scripts: `/tmp/herdr-imgtest.Wg8S4A/probe14.py`,
     `probe19.py`, `probe20.py`.

9. **Corrections to round-2 claims.** (a) The round-2 doc mentioned a
   `pane_graphics_frame_ack` event; no such event exists in the 0.9.0
   API event set (`src/api/schema/events.rs` EventKind list has no
   graphics entries). Graphics reach clients only via the ClientShell
   surface scene / GraphicsFile paths above. (b) Round-2's plan item
   "provide real cell metrics on the existing attach connection" is
   impossible: TerminalAttach clients never qualify for graphics
   delivery regardless of cell metrics; the corrected external plan is in
   the External herdr backend section above.

## Round-4 progress (implementation, 2026-09-18)

Step 1 of the builtin plan is landed (this repo, branch
`image_support_terminal`): parser hardening + `pane.read` parity, with
regression tests. No renderer, filter, or env changes yet - those are
steps 2-5.

**What changed (all verified by tests, 547 passing, baseline 534):**

1. `src/terminal_text.rs`: `terminal_text_lossy` and `strip_ansi_lossy`
   gained a match arm for `ESC P` (DCS/Sixel), `ESC X` (SOS), `ESC ^`
   (PM), and `ESC _` (APC/Kitty). A new `skip_string_sequence` helper
   consumes the payload until the String Terminator `ESC \` only. BEL
   (0x07) intentionally does NOT terminate: Sixel quoted strings may
   legally contain 0x07, so stopping at BEL would truncate mid-image and
   leak the rest as text. Unterminated sequences consume the remainder of
   the input, mirroring a real terminal holding the string open.
2. `src/tui_terminal.rs`: the styled-lines parser gained the same match
   arm, delegating to a local `skip_string_sequence` (kept separate from
   the existing `skip_osc`, which must keep terminating on BEL).
3. `src/builtin_backend.rs` `read_pane_recent`: now runs
   `terminal_text::strip_ansi_lossy(..., StripCarriageReturn::Drop)`
   over the history bytes before returning, matching external herdr's
   `pane.read` default (`strip_ansi: true`). Drop mode (not Newline)
   because history bytes carry CRLF line ends from the PTY: Newline
   mode would double every line break, while herdr's grid-row join
   emits single `\n`. This closes the round-2 leak finding (finding 2
   above): Kitty base64, Sixel raster, and iTerm2 base64 no longer reach
   builtin `pane.read` consumers (TUI panes, agent-status
   screen-scrape). The webui TUI's `refresh_tail` re-strips (Drop mode)
   anyway, so this is defense in depth, and the strip is idempotent for
   already-clean text.

**Regression tests added** (cover every leak site + the round-2 live
evidence shapes):

- `terminal_text_skips_kitty_apc_payload_until_st`: the canonical Kitty
  direct-RGBA transmit form herdr 0.9.0 ingests, across
  `tui_tail`/`backend_tail`/`strip_ansi_lossy`.
- `terminal_text_skips_sixel_dcs_payload_until_st`: Sixel DCS with an
  embedded BEL in a quoted string - asserts BEL does not terminate.
- `terminal_text_skips_sos_pm_and_unterminated_sequences`: SOS, PM, and
  a truncated/unterminated APC (e.g. a Kitty `m=1` chunk that never gets
  its final chunk) consume the rest of input.
- `terminal_text_skips_iterm2_osc_1337_payload`: iTerm2 inline image in
  both ST and BEL terminator forms.
- `terminal_text_keeps_text_after_image_sequences`: upload + placement
  back to back using the exact byte shapes observed live in round 3
  (`a=T,f=32,s=2,v=2,i=24159,q=2,m=0` then `a=p,i=24159,...`), with
  surrounding output preserved.
- `terminal_output_styled_lines_skip_kitty_and_sixel_payloads` and
  `terminal_output_styled_lines_skip_unterminated_apc`: the TUI
  styled-lines parser equivalents.
- `builtin_read_pane_strips_image_payloads_and_keeps_single_newlines`:
  a real-PTY integration test through `agent.start` + `read_pane_recent`
  that emits Kitty APC and iTerm2 OSC via `/bin/sh -c printf` and
  asserts no base64/escape framing leaks and CRLF stays a single
  newline.

**Explicitly NOT changed:** the client-side image filter
(`filterTerminalImageSequences`), wterm package pins (still 0.3.0), PTY
env (`TERM_PROGRAM` etc.), and the external-herdr bridge. Step 1 was
chosen first precisely because it is independent and fixes a real leak
on the builtin backend even if images are never rendered. iTerm2
OSC 1337 needed no new parser code (OSC payloads were already skipped
by the pre-existing OSC arms), but it now has an explicit regression
test (`terminal_text_skips_iterm2_osc_1337_payload`, both ST and BEL
terminator forms) since it is one of the three protocols jcode emits.

**Next steps (unchanged order):** step 2 wterm 0.5.0 upgrade with the
build-script patch, step 3 Ghostty-core Kitty gate in the filter, step 4
PTY env hints (set `TERM_PROGRAM=ghostty`, scrub inherited
`TERM_PROGRAM`/`KITTY_WINDOW_ID`), step 5 E2E validation, then the
external-backend phase 2 bridge rearchitecture per the round-3 plan.

**Round 4 step 2 landed (wterm 0.5.0 upgrade):** `@wterm/core`,
`@wterm/dom`, `@wterm/ghostty` pinned 0.3.0 -> 0.5.0 (exact pins, as
before); `npm run build:wterm` regenerated the vendored bundle with both
build-script patches intact (default WASM URL -> `/assets/vendor/
ghostty-vt.wasm`; IME textarea `aria-hidden` fix). Sizes match the
round-1 scratch-install verification: bundle 43,842 -> 96,005 bytes,
`ghostty-vt.wasm` 428,644 -> 577,013 bytes. The 0.5.0 CSS ships the
`.term-images` graphics layer. No adapter source changes were needed:
the 0.5.0 API surface the adapter uses (`WTerm` constructor options,
`init/write/resize/focus/destroy`, `GhosttyCore.load({wasmPath,
scrollbackLimit})`, `bridge`) is unchanged; the only 0.5.0 removal is
the public `rowHeight()` method, and every call site already guards
with a DOM-measured fallback or constant (17px), so wheel/touch
scrolling keeps working (terminal-fit e2e confirms scroll-adjacent
sizing still correct). The renderer still emits `.term-row`, which the
adapter's DOM-measured `rowHeight()` uses.

Verification (all on the real served app, isolated servers):
- Rust suite: 547 passing (embedding the new bundle).
- `node --test src/assets/*.test.mjs`: 558/558.
- Terminal-fit e2e (default wterm core, real Chrome): 26/26.
- Ghostty-core e2e (NEW, `scripts/e2e/run-ghostty-core-e2e.sh`, `just
  ghostty-core-e2e`): forces `terminalCore=ghostty` via localStorage and
  verifies attach, rendered rows, live shell prompt (starship `❯`), and
  the `.term-images` graphics container present: 5/5.
- Main e2e (60 checks incl. session UX), theme 15/15, mobile-edit
  52/52, git, git-drawer 21, content-search, lsp 20/20: all green.

The image filter (`filterTerminalImageSequences`) is still active and
unchanged - it is step 3's job to gate Kitty pass-through on the
Ghostty core. Images still render as the `[inline image omitted: ...]`
placeholder on both cores until then.

**Round 4 step 3 landed (Kitty pass-through gate):**
`filterTerminalImageSequences` in `src/assets/shared/terminal_adapter.js`
now passes Kitty `ESC _ G ... ESC \` sequences through untouched when the
adapter runs the Ghostty core; every other core (default wterm VT) keeps
the `[inline image omitted: Kitty graphics...]` placeholder. iTerm2 and
Sixel stay filtered on ALL cores (wterm 0.5.0 renders neither). The gate
is `state.allowKittyGraphics`, captured once at adapter construction
(`this.core === "ghostty"`), because the core cannot change without
recreating the adapter (Settings already reconnects on switch). Split
chunk buffering still works on the pass-through path (a sequence split
across ws frames is held until its ST arrives).

Live verification (real served app, real Chrome, real shell typing the
emit through the pane PTY): the extended ghostty-core e2e
(`scripts/e2e/ghostty-core-acceptance.mjs`, parametrized
`TERMINAL_CORE=ghostty|wterm`, runner runs BOTH) types the exact
round-3 direct-RGBA transmit + placement into a live zsh pane:

- Ghostty core: `.term-image` canvas renders (images=1), no placeholder
  text (placeholder=false). Full real path exercised: zsh ->
  `/dev/pts` -> pane stdout -> WebSocket -> adapter gate -> Ghostty
  core -> graphics layer.
- wterm core: same bytes, adapter substitutes the placeholder
  (placeholder=true), no `.term-image` (images=0).
- A first attempt with a PNG payload under `f=32,t=d` produced no image
  (correct behavior: direct-RGBA expects raw RGBA bytes, not PNG base64)
  - the round-3 probe payload is the right test vector.

Unit tests added (`src/assets/terminal_adapter.test.mjs`): Kitty
pass-through on ghostty core (whole and split chunks), placeholder kept
on wterm core, iTerm2/Sixel still summarized on ghostty core. 562/562
node tests, 547/547 Rust tests.

Settings/help text updated per parity rules (desktop settings label,
desktop help row, mobile settings renderer note): Ghostty renders Kitty
graphics inline, other cores show a placeholder, reload after switching.

**Round 4 step 4 landed (PTY env hints):**
`terminal_environment()` in `src/builtin_backend.rs` now sets
`TERM_PROGRAM=ghostty` and removes `KITTY_WINDOW_ID` from the env map,
and - the part the map alone cannot do - the pane spawn site calls
`CommandBuilder::env_remove()` for each key in the new
`TERMINAL_ENV_SCRUB_KEYS` list (`KITTY_WINDOW_ID`): `CommandBuilder::
env()` only adds on top of the inherited process env, it cannot unset,
so removing the key from the HashMap was a no-op for the PTY child (a
first live check caught `KITTY_WINDOW_ID=999` still reaching the shell
with the map-only fix). `TERM` stays `xterm-256color` (terminfo-safe,
already set at spawn), so agents detect Kitty via `TERM_PROGRAM`
only - which also disables the accidental Sixel-on-xterm path.

Verification:
- Unit: `terminal_environment()` map asserts `TERM_PROGRAM=ghostty`
  and no `KITTY_WINDOW_ID` with the process env poisoned to
  `iTerm.app`/`123`.
- Real-PTY integration (NEW): a pane spawned via `agent.start` with
  `/bin/sh -c printf` while the test process env is poisoned prints
  `TP=ghostty KID=` - proving `env_remove()` reaches the actual child,
  not just the map.
- Live check (`scripts/e2e/run-env-hints-check.sh`, self-contained
  server+Chrome, poisons the server env `TERM_PROGRAM=iTerm.app`,
  `KITTY_WINDOW_ID=999`): typing the printf into a real pane in the
  served app shows `TP=ghostty KID= TERM=xterm-256color`.
- Rust suite 549 passing; fmt/clippy clean.

Live-check debugging note: headless Chrome without `--window-size`
gets a narrow default viewport, `app_boot.js` resolves the mobile
layout (max-width 760px), and the mobile bundle never defines the
desktop `go()` - the check must launch Chrome with
`--window-size=1600,1000` like the other e2e runners.

**Round 4 step 5 landed (E2E, real jcode PNG through the real flow):**
two new live checks close the loop:

- `scripts/e2e/smoke-jcode-kitty-emit.sh` (no browser): a real
  `jcode serve` runs on a real PTY (`scripts/e2e/pty_capture.py`, an
  incremental-capture replacement for macOS `script`, which only
  flushes its transcript on clean exit) with the exact pane env
  (`TERM_PROGRAM=ghostty`, `TERM=xterm-256color`, no
  `KITTY_WINDOW_ID`); the real `read` tool driven over the debug
  socket (`JCODE_RUNTIME_DIR` isolated, `JCODE_DEBUG_CONTROL=1`,
  `create_session` + `tool:read`) emits the chunked Kitty form
  `ESC_G a=T,f=100,c=20,r=10,m=0;<base64 PNG> ESC \` to the PTY.
  Negative control (`SMOKE_MODE=noemit`): without the TERM_PROGRAM
  hint the same tool emits nothing - proving the emitter selection
  is driven by the step-4 env.
- `just jcode-image-flow-e2e` (`scripts/e2e/run-jcode-image-flow-e2e.sh`
  + `jcode-image-flow-acceptance.mjs`, 8 checks x both cores): the
  full production path in a real browser. A workspace boots on the
  isolated server, a real `jcode serve` is typed into the live pane
  (so the server's stdout IS the pane PTY and TERM_PROGRAM=ghostty
  comes from the real pane env), then the real `read` tool is driven
  over the debug socket. Results: Ghostty core renders the jcode PNG
  as a `.term-image` canvas (images=1, placeholder=false); wterm
  core substitutes `[inline image omitted]` (placeholder=true,
  images=0); the visible grid text carries no base64 payload
  (`iVBORw0KGgo` absent) and no escape framing on BOTH cores; the
  pane status API reports sane statuses. Per-core
  `JCODE_RUNTIME_DIR`s because the pane-owned `jcode serve` outlives
  its acceptance run.

Live-debugging notes recorded for future harnesses: (a) headless
Chrome without `--window-size` gets a narrow viewport, `app_boot.js`
resolves the mobile layout (max-width 760px), and the mobile bundle
never defines the desktop `go()` - image e2e runners must launch
Chrome with `--window-size=1600,1000`; (b) node scripts driving CDP
must end with an explicit `process.exit(...)` - the CDP WebSocket
keeps the event loop alive otherwise; (c) `jcode serve` (unlike
`jcode debug start`, which spawns `Stdio::null()`) runs in-process,
so its stdout follows the invoking shell's PTY - that is what makes
the pane the right place to run it.

**Builtin backend image support is COMPLETE.** Remaining open work:
the external-herdr backend (phase 2 bridge rearchitecture per the
round-3 plan: the webui bridge must become a ClientShell endpoint
client to receive herdr's graphics relay).
