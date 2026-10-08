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

## Utility scripts

- `probe-submit-route.sh` - route probe for submit endpoints
- `pty_capture.py` - PTY capture helper for terminal work
- `smoke-jcode-kitty-emit.sh` - kitty-graphics emit smoke test
