# Phase 5 transport design: shared attach, replay tail, backpressure

State: **implemented** (2026-10-03), commit on `ux_improvements`. See
"Implementation notes" at the bottom for deviations from this design
made while coding.

## Survey findings (what the code actually does today)

Key discovery: the three items are NOT three independent features here. The
builtin backend (`builtin_backend.rs`) already gives us most of the
machinery for free:

- `TerminalRuntime` (one per `terminal_id`, in `BuiltinData.terminals`)
  owns the PTY, an 8 MiB scrollback ring (`MAX_SCROLLBACK_BYTES`), and a
  subscriber list. `append_output` appends to scrollback AND fans the same
  bytes to every subscriber with `try_send`; a subscriber with a full
  channel (256 slots) is dropped ("slow consumer = disconnect" today).
- `handle_client_connection` (builtin attach handler) ALREADY:
  - supports multiple concurrent attaches per terminal (each connection
    subscribes with its own writer thread), so there is no takeover
    battle in the builtin backend;
  - replays `history_bytes()` as a full frame on `AttachTerminal`
    — this is already a replay buffer for the builtin path;
  - broadcasts `Resize` from any one connection to the shared PTY.
- The builtin reader is already effectively backpressure-aware at the
  source: the PTY read loop only produces what subscribers accept. A slow
  consumer gets dropped from the fan-out rather than memory growing.

The real gaps are all in the WebUI relay layer (`src/main.rs`), where the
browser connects:

1. **Per-WS attach.** Every browser WebSocket opens its OWN backend attach
   via `connect_terminal_attach` (takeover: true, one reader thread per
   WS). N viewers of the same terminal = N backend connections, N reader
   threads, N scrolls of the 8 MiB replay. For an EXTERNAL herdr daemon
   the reference reports takeover battles. Also a reconnect storm during
   resize drag rebuilds all of it per frame.
2. **No replay at the relay.** When a browser client reconnects (network
   blip), the builtin backend replays from its scrollback — but the relay
   spawns a fresh attach and the client waits for the full replay over a
   new backend connection; for the short-lived temporary tabs there is no
   guarantee the replay arrives before the WS banner path re-arms.
3. **Backpressure through the relay.** Backend output flows through an
   `unbounded_channel` (out_tx) to the WS loop; a stalled TCP peer makes
   this buffer grow without bound. Binary input from the browser flows
   through `std::sync::mpsc` to the writer thread — same issue.
4. **No protocol change signal.** PROTOCOL_VERSION stays 22 for external
   daemons (0.9.x). The builtin backend is our own, but the relay must
   keep speaking 22 to external backends. A bump would break herdr 0.9.x
   compatibility, which we keep (MIN_SUPPORTED_PROTOCOL_VERSION 22).

### Why we will NOT bump PROTOCOL_VERSION

The plan suggested "protocol version bump (`PROTOCOL_VERSION` guard
exists)" for the shared-PTY item. After the survey: not needed and not
safe. Multiple attaches are already part of protocol 22 semantics on the
builtin backend (subscriber fan-out exists), and external backend
compatibility with herdr 0.9.x is a hard constraint
(`MIN_SUPPORTED_PROTOCOL_VERSION = 22`). All three items are implementable
entirely inside the relay layer using existing protocol 22 messages. The
builtin backend needs zero protocol changes. Decision: keep 22, no bump.

## Design

### 1. Shared attach hub (per terminal_id) in main.rs

New module-level structure (new file `src/terminal_hub.rs`):

```text
TerminalHub {
  attaches: Mutex<HashMap<(backend_key, terminal_id), Arc<SharedAttach>>>
}
SharedAttach {
  stream: LocalStream (one backend connection),
  in_tx: std::sync::mpsc Sender<ClientMessage>,  // writer thread input
  out_tx: broadcast? no — per-client mpsc with bounded cap
  clients: Mutex<Vec<BoundedClientHandle>>,
  replay: Mutex<ReplayBuffer>,
}
```

Flow:

- First WS for `(backend, terminal_id)` creates the `SharedAttach`:
  `connect_terminal_attach` handshake, subscribe its reader thread to the
  backend connection, register client handle with a bounded tokio mpsc
  (e.g. 512 frames), seed the replay buffer from the attach's full frame
  (the builtin backend already sends `history_bytes` as the first frame),
  then forward everything into the replay buffer + fan out.
- Subsequent WS for the same key attach to the same `SharedAttach`: they
  get (a) the replay snapshot first, (b) the live broadcast going forward.
- Last client leaving sends `Detach` on the backend connection and drops
  the entry (refcount -> 0). Delayed teardown of ~1s (grace window for
  reconnects) so a reload does not bounce the backend attach.
- Resizes: the hub serializes resizes (last-wins across clients; the PTY
  only has one geometry, subscribers all see the same frames).
- Errors: a backend error is delivered to every registered client as a
  `TerminalEvent::Error` — each client WS still gets its own 4404 stall
  close + `herdr_error` JSON (existing behavior per client).

Replay on join = snapshot bytes of the bounded ring + a small "generation"
counter to prevent duplicate delivery if the buffer is concurrently being
written (join drains snapshot, then subscribes; any overlap is resolved by
the ring's monotonic byte counter).

### 2. Replay buffer (bounded, cheap)

Simple bounded `VecDeque<u8>` ring in the relay with a smaller cap than
the backend's 8 MiB — 2 MiB default (enough for the visible screen plus
recent scrollback on reconnect; configurable via env `HERDR_REPLAY_CAP`

-byte cap). Feeding happens in the hub's forward path; consumers (join
or reconnect) take a snapshot. UTF-8 boundary safe: replay is raw bytes
appended to wterm's scrollback exactly like live bytes, no string
conversion.

Important: this replay is a superset of what the builtin backend already
sends in the attach's first full frame, but it also covers reconnects
where the backend connection stays up (hub is alive) — the joining client
sees the last ~2 MiB instantly, no new backend attach, no takeover.

### 3. Backpressure

Two bounded paths, same policy as the builtin backend: bounded queue +
drop the slow consumer.

- Backend→client: bounded tokio mpsc (cap 512 frames). If a client's
  queue fills (browser is stalled), hub drops the client handle: its WS
  gets close 4404 (stall, existing banner). The client's own reconnect
  will re-join the hub and re-take the replay snapshot. Rationale: a
  stalled TCP client must never block the shared reader; other viewers
  keep flowing. This is also what the builtin subscriber model already
  does (try_send, drop on full).
- Client→backend input: the hub's writer thread reads from a bounded
  sync channel (cap 256, same as builtin's subscriber channel). If full
  (backend writer stalled), drop the connection's input? NO — input
  loss is worse than a stall banner. Better: apply the plan's item 3
  (input queue policy): if the writer thread cannot keep up for more
  than a few seconds, detach the slow client with 4404 rather than
  silently queueing unbounded. Ctrl+C keeps priority: the input channel
  is a single FIFO, all clients share it, no reordering, so a Ctrl+C
  behind a big paste is still delivered in order once drained.

### 4. What does NOT change

- Protocol 22 messages, wire format, frontend handshake: unchanged.
- Frontend: unchanged except… nothing. `ws.onclose` 4404 handling already
  exists. Frontend reconnect logic already reattaches; it will now hit
  the hub and get an instant replay. Zero frontend changes required.
- Builtin backend: zero changes.
- External backend path: the hub is keyed by backend too. External
  daemons get the same single-attach-per-terminal per session, killing
  the takeover storm; a takeover message from the daemon (if any) is
  delivered only to the one shared attach, not N.

### Test strategy

- New unit tests in `terminal_hub.rs` (or a dedicated test section):
  - replay ring append/snapshot/trim behavior, byte-cap enforcement.
  - hub join/leave refcounting, delayed teardown.
  - fan-out to 2 clients, slow-consumer drop, drop policy (queue cap).
  - resize last-wins.
- Integration: existing `fake_terminal_attach_socket` in tests.rs is
  single-connection-per-accept-thread; needs a multi-attach-aware fake
  (it already accepts multiple sequential connections; concurrency is
  fine). Existing WS tests must keep passing (they assert on the frames
  the relay forwards: Input/Detach/Resize etc.). Key risk: tests that
  rely on "every WS opens its own attach" — the fake records per
  connection; with the hub, a second WS in the same test on the same
  terminal_id now shares the first attach. We will check each existing
  test for that assumption.
- Frontend battery unchanged (no frontend changes).

## Risks / open questions

- Grace-window teardown (~1s): a reload closes+reopens within the
  window; fine. But a user closing the last viewer for good keeps a
  backend attach open for the grace period — acceptable (cheap).
- Hub entries keyed by `(backend, session, terminal_id)`. The `backend`
  key must include the query session/backend pin (same terminal_id in
  two sessions must not share). Confirm `SessionBackendTarget` is
  hashable/cloneable for the key; fallback key on the resolved socket
  path + terminal_id.
- The stall close 4404 on slow-consumer drop: the browser banner says
  "stream stalled" — accurate for this case too.
- Memory: 2 MiB replay per attached terminal. With a handful of
  terminals this is trivial; 100 terminals = 200 MiB worst case. Add a
  hub-wide total cap (env `HERDR_HUB_TOTAL_REPLAY_CAP`, default 32 MiB,
  oldest entries trimmed) — plan does not ask for it but it bounds worst
  case.
## Implementation notes (what actually shipped)

- New module `src/terminal_hub.rs` (`TerminalHub`, `SharedAttach`,
  `ReplayRing`, `HubClientEvent`, `AttachError`, `HubJoinGuard`).
  `main.rs::terminal_socket` now joins the hub instead of opening a
  per-WS backend attach; the old `TerminalEvent`/
  `TerminalAttachError`/`connect_terminal_attach` relay code was
  deleted (the handshake moved into the hub; errors are now
  `HubClientEvent::Error` events, but the wire frames to the browser
  are byte-identical).
- Key is `(client socket PathBuf, terminal_id)` — not
  `(backend, session, terminal_id)`: the resolved socket path already
  encodes session + backend, which settles the open question above.
- No protocol bump after all (see "Why we will NOT bump"). All three
  items landed inside the relay with protocol 22 unchanged. The plan's
  item 3 (input queue policy) became moot in its original form: input
  is now one plain FIFO per shared attach, so there is no unbounded
  per-client queue that could fire stale input into a dead session.
- Replay ring default is 8 MiB (matches the backend's scrollback
  bound, not the 2 MiB sketched above) so a late joiner never sees
  less than a fresh attach would show. Env override:
  `HERDR_REPLAY_CAP_BYTES`.
- Client queue cap is a frame-count cap (512): each client holds at
  most 512 pending output frames; a stalled consumer is dropped and
  its WS closes with the 4404 stall code (existing frontend banner).
- Backend full frames (`frame.full == true`) REPLACE the ring (the
  backend's replay is authoritative on a fresh attach); incremental
  frames append.
- Grace window: 1.5 s after the last viewer leaves, then the hub
  sends `Detach` on the shared backend connection. Rejoins inside
  the window cancel the teardown.
- Join atomicity: snapshot + registration happen under the same locks
  `publish` takes (replay, then clients), so bytes are delivered
  either in the snapshot or live, never both.
- Tests: 8 unit tests in `terminal_hub.rs` (ring append/trim/oversize/
  replace/snapshot, fan-out + stalled-client drop, late-joiner
  snapshot, error broadcast, noop detach); the migrated
  `terminal_attach_errors_classify_for_graceful_degradation` test now
  targets the hub's `AttachError`. Full battery green: 486 bin + 309
  lib Rust tests, every `src/assets/*.test.mjs` suite.
- Frontend: zero changes, as designed. Builtin backend: zero changes.

## Debt / accepted gaps

- Memory: 8 MiB replay ring per attached terminal matches what the
  builtin backend already holds per terminal in scrollback, so the
  hub does not add a new worst case; the hub-wide total cap idea
  (`HERDR_HUB_TOTAL_REPLAY_CAP`) was dropped as over-engineering for
  now — reopen if multi-hundred-terminal servers show up.
- Hub map entries are reaped lazily (on join/detach touch of the same
  key), so a closed attach's Arc stays in the map until someone
  touches the same terminal again. Bounded by terminals-per-session.
