# Shared panes: backend ownership of panels and groups

Date: 2026-11-17. Branch: pane_controls_bar. Design document, implementation follows.

## What changes

Panel rename joins group rename, and the whole panel/group model moves
from browser localStorage to the webui server so every client connected
to the same herdr session shares one truth. The client keeps gestures,
quadrant math, preview squares, DOM reconcile, and terminal mounts; the
server owns records and invariants.

The user picked the full migration over shared-state-first: Rust owns
the model and the rules, JS sends intent ops and renders whatever entry
the server returns.

## Where the state lives

Webui server, per herdr session. Not the herdr backend protocol: the
builtin backend stays untouched, and external herdr sessions get sharing
through the webui server with zero protocol changes. `notes.rs` is the
proven pattern: Arc<Mutex<state>> + sidecar file + broadcast channel +
`/ws/events` fanout.

Session identity is already solved. Every client request carries
`x-herdr-session` through the shared HTTP bridge (`src/assets/shared/http.js`),
and the events socket pins `?session=` through `wsUrl()` (`terminal.js:1607`).
The server resolves the session name with `request_session_name`
(`main.rs:1757`), which maps "" and "default" to the single default
session. One store per session name covers builtin and external backends
alike, because both ride through the same webui server.

Sidecar per session: `panes-<session>.json` in the config dir
(`~/.config/herdr-webui/`, `XDG_CONFIG_HOME` in tests), written with the
existing `atomic_write`. The server-wide notes precedent uses
`notes.json`; panes need per-session files because two herdr sessions
never share panels.

## The wire

One route pair, notes-shaped:

- `GET /api/workspace-panes` returns the entry: `{ v: 3, panels, groups,
  visible, at }`. The 200 response is the adopt target.
- `POST /api/workspace-panes/op` applies one intent op and returns the
  SAME full entry. Ops:
  - `panel.create` `{wsId?}` - mint a panel (server mints paneId)
  - `panel.rename` `{paneId, name}` - empty string clears
  - `panel.close` `{paneId}` - splice, group surgery, visible heal
  - `group.create` `{draggedPaneId, axis, draggedFirst, neighborPaneId?}`
  - `group.grow` `{groupId, paneId, axis, draggedFirst, hostPaneId?}`
  - `group.ungroup` `{paneId}` - dissolve under two members
  - `group.rename` `{groupId, name}`
- `POST /api/workspace-panes/apply` replaces the entry wholesale (the
  client migration path: first client to POST wins the seed, plus the
  tab-placement syncs that only the client can see).

Broadcast after every mutation: `{ type: "workspace_panes_changed",
entry: <full entry> }` on the same `panes_tx` broadcast channel pattern
as `notes_tx`, fanned out through `events_socket` (`main.rs:6716`). Full
snapshot, no deltas: same reasoning as notes (small state, bursty
writes, a lagging client self-heals on the next GET). The client branch
in `connectEvents` must NOT call `scheduleRefresh` for this frame kind:
the entry repaints directly, a full workspace refresh on every group
drag would flicker.

One nuance: the broadcast is server-wide, not per-session. The events
socket already knows its session (resolved at upgrade through
`api_for_query_session_ensured`), so the broadcast frame carries
`session` and each socket drops frames from other sessions. Same
discipline as layout.updated's backend protocol gate.

## What moves to Rust and what stays in JS

Moves (the full entry format the client already persists, mirrored in
Rust structs):

- Panel records: `paneId`, `tabs`, `active`, `wsId`, `groupId`, and the
  new `name`.
- Group records: `groupId`, `name`, `memberIds`, `layout` (the
  row/column tree with sizes and splitIds).
- Id counters and the used-id registration (Rust mints `p<N>`/`g<N>`
  monotonically per session; a POST that names an unknown id is a 400,
  not a silent mint).
- Invariants: visible pointer validation and heal, group dissolve under
  two members, layout surgery (`member_layout_without`,
  `layout_with_panel_at`), memberIds/layout agreement, dedupe.

Stays client-side (inherently local):

- Drag gestures, dragover quadrant resolution, the preview square.
- DOM reconcile, strips, rail chips, empty-leaf cards, terminal shell
  parking.
- Per-client selection: `state.tab`, the route, focus pointer
  (`activePaneId` stays in the entry but each client heals its own view
  through its own render), and the visible subject stays per-client:
  two clients can look at different subjects of the same shared
  membership. The entry carries `visible` as the LAST WRITER's view and
  each client overrides it with its local pointer at adopt time. The
  user approved this default at phasing time.
- The terminal sync (`syncTerminalTabsIntoTree`) and tab placements:
  tab ids are backend truth, the sync resolves them into homes. The sync
  keeps running client-side and POSTs the tab-list deltas through
  `panel.update` ops (batched in one apply call) so the server holds the
  authoritative tabs arrays. Editor/git tab ids are client-owned and
  ride along as opaque strings.
- Auto-close arming and the sweep: the arm markers are gesture-local, so
  the sweep runs client-side and issues `panel.close` ops for its
  victims.

## Client migration path

`workspace_panes.js` keeps its whole local model as the fallback for
older servers and standalone harnesses. New flow:

1. Boot: `loadWorkspacePanesStates()` unchanged (localStorage seed).
2. After boot, fetch `GET /api/workspace-panes`. 200 with an entry:
   adopt (replace the local entry, keep local visible pointer when it
   names a live subject). 404 (older server): stay local, set
   `panesMode = "local"`, everything works as today.
3. On success set `panesMode = "server"`. Every mutation site (group
   create/grow/ungroup, panel create/close/rename, group rename, sync
   deltas) sends the op; the op response REPLACES the local entry and
   triggers `renderWorkspacePanes()`. On network failure: fall back to
   local mutation, retry the op once; if the server stays unreachable,
   drop to local mode for the session.
4. Broadcast frames (`workspace_panes_changed`) from other clients
   apply the entry the same way, guarded by the session match.
5. localStorage demotes to migration seed: `apply` POSTs the local
   entry once when the server has none (404 on GET), then stops being
   the truth. The load path stays for `panesMode = "local"`.

## Panel rename

Panel chips gain the same double-click edit the group chips have:
`state.editingPanelPaneId` + `state.editingPanelValue`,
`startPanelChipRename` / `commitPanelChipRename`, empty commit clears
the name. The rail label falls back to the derived label (active tab
visible label, workspace name) exactly as `railEntryLabelForPanel` does
today; a set name wins. The name rides the panel record, so it
persists server-side and every client renders it.

## Risks

- Tab sync loop risk: the client sync mutates tabs and POSTs; the
  broadcast comes back and re-triggers the sync. Mitigation: the sync
  is idempotent against a settled entry (one-home rule, prune), and
  the adopt path diffs before rendering. Watch for thrash in the live
  demo.
- Two clients minting panels concurrently: server-side minting makes
  ids unique by construction; the losing client adopts the returned
  entry.
- The v2 blob migration: a user upgrading with an existing localStorage
  entry POSTs it once through `apply`; the server normalizes it
  (mirroring `normalizePanelEntry`) before storing.
