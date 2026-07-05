// =============================================================================
// DEPRECATED: Legacy multi-request polling bootstrap.
// =============================================================================
//
// This file contains the pre-protocol-16 refresh mechanism that bootstraps the
// WebUI session by issuing separate `workspace.list`, `tab.list`, `pane.list`,
// `agent.list`, and `pane.layout` requests on every refresh, plus a 5s polling
// snapshot of agents/workspaces from the events socket.
//
// It is kept as a fallback for backends older than protocol 16 (which do not
// expose `session.snapshot` or emit `layout.updated` events) and to preserve
// the existing behavior while the new snapshot-based bootstrap matures.
//
// TODO(remove): Delete this file and its call sites once the official Herdr
// release with protocol 16 ships and `session.snapshot` + `layout.updated` are
// confirmed stable across all supported backends. The new mechanism lives in
// `core.js` (`refreshOnlineSnapshot`, `applyLayoutUpdated`).
// =============================================================================

// Applies the legacy 5-second polling snapshot pushed by the events socket.
// Kept here so the new snapshot path in core.js can fall back to it when
// `session.snapshot` is unavailable (backend older than protocol 16).
function applyLegacyPollingSnapshot(msg) {
  const wr = msg.workspaces && msg.workspaces.result;
  const ar = msg.agents && msg.agents.result;
  if (wr && wr.workspaces) state.workspaces = wr.workspaces;
  if (ar && ar.agents) {
    state.agents = ar.agents;
    handleAttentionSound();
  }
  render();
}