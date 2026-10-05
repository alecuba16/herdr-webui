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

The in-repo CDP harness was removed (extension installs are not always
available). Run real-browser acceptance with the external cdp-chrome skill
and a self-contained headless Chrome for Testing; see
`docs/e2e-external.md`.

## Utility scripts

- `probe-submit-route.sh` - route probe for submit endpoints
- `pty_capture.py` - PTY capture helper for terminal work
- `smoke-jcode-kitty-emit.sh` - kitty-graphics emit smoke test
