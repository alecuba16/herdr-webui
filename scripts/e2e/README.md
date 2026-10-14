# Acceptance checks

Only no-browser harnesses live in this repo. They drive the actually
served app over plain HTTPS or a node vm, no Chrome involved.

## Git explorer (git-e2e)

```sh
just git-e2e        # or: scripts/e2e/run-git-e2e.sh
```

Boots the served git-ui bundle in a node vm with fetch proxied to the real
backend. Covers folder actions, compare modes, discard.

## Content search (content-search-e2e)

```sh
just content-search-e2e   # or: scripts/e2e/run-content-search-e2e.sh
```

Backend-built content-search chunks served and checked over HTTPS.

## External-backend graphics probe (external-graphics-probe)

```sh
just external-graphics-probe
# or: scripts/e2e/run-external-graphics-probe.sh
```

Isolated herdr 0.9.0 daemon + the webui protocol.rs types speaking the real
ClientShell endpoint protocol.

## Real-browser e2e

Live keyboard-guards audits run in-repo with `make test-e2e` (or
`scripts/e2e/run-keyboard-guards-e2e.sh` directly): the runner builds,
boots an isolated server plus its own headless Chrome over CDP, runs the
mobile and desktop guard audits, and tears everything down. For
ad-hoc real-browser probing beyond that, the external cdp-chrome skill
and `docs/e2e-external.md` still apply.

## Git-log hover card (log-hover-e2e)

```sh
just log-hover-e2e  # or: scripts/e2e/run-log-hover-e2e.sh
```

Same real-browser setup (isolated server + headless Chrome over CDP, own
XDG_CONFIG_HOME/session, nothing external). Covers the labeled hover rows
(Commit id / Tags / Author / Date), per-field and per-tag copy commands
including the copy toast via trusted input, the accent-2 selected-row
tint, and the settings/terminal DOM hygiene audits (duplicate element
ids, IME textarea id/name).

## Chat lens segment colors (chat-colors-e2e)

```sh
just chat-colors-e2e  # or: scripts/e2e/run-chat-colors-e2e.sh
```

Same real-browser setup, plus an isolated HOME holding one fixture
jcode session (thinking, tool, error, and running parts; a fake `jcode`
script stamps its own pid into the fixture so session resolution works).
Drives the theme through the settings select's real change handler so
the inline `--bg` custom props follow. Covers the color mapping per
token (thinking magenta, tool name cyan, failed tool danger, running row
amber, prose stays `--fg`) in both themes via computed styles, WCAG AA
contrast (>= 4.5:1) against the served background, and screenshots of
both themes for the record.

## Pane strip rail (rail-e2e)

```sh
just rail-e2e  # or: scripts/e2e/run-rail-e2e.sh
```

Same real-browser setup. Covers the maximize rail: splitPaneRight, an
editor tab opened from the Files drawer into the fresh leaf, maximize
keeps the sibling strip visible (stub keyed by pane id, live controls),
own-tab click keeps maximize, rail tab click restores the split and
activates the sibling tab, and the git drawer opens a `gitchanges` tab.

## Notes rail (notes-rail-e2e)

```sh
just notes-rail-e2e  # or: scripts/e2e/run-notes-rail-e2e.sh
```

Same real-browser setup on its own port (8898). Covers the server-synced
notes panel: the rail Notes button hosts #notesPanel, creating a note
enters editing straight away, the row renders after back, CodeMirror
mounts with the note's language, title/language/content persist through
the real API and survive a client reload (sidecar GET), per-note delete
asks nothing, and clear-all rides the danger confirm and leaves the
note in place on reject. Server-restart persistence is covered by the
Rust suite's sidecar-rebuild test.

## Utility scripts

- `cdp-driver-helpers.mjs` - shared CDP plumbing for the real-browser drivers
  (WebSocket client, result recorder, JSON report writer)
- `e2e-runner-lib.sh` - shared runner boilerplate (Chrome lookup, teardown,
  health polling, port guard) sourced by the runner scripts
- `probe-submit-route.sh` - route probe for submit endpoints
- `pty_capture.py` - PTY capture helper for terminal work
- `smoke-jcode-kitty-emit.sh` - kitty-graphics emit smoke test
