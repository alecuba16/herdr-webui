# Contributing to Herdr WebUI

Herdr WebUI is a separate browser UI for official Herdr-compatible workflows. Changes should keep that boundary clear: this repository includes its own built-in WebUI backend for local terminal multiplexing, but it does not fork the official Herdr backend.

## Scope

- WebUI server, frontend, install helpers, docs, and release workflow belong here.
- Herdr backend changes belong upstream in the official Herdr repository.
- Protocol compatibility changes should document the supported Herdr backend versions and protocol number.

## Checks

Run the local checks before opening a PR:

```sh
just check
```

Or run pieces directly:

```sh
cargo fmt --check
cargo clippy --target-dir target --all-targets -- -D warnings
cargo test --target-dir target
node --test src/assets/*.test.mjs
```

## End-to-end checks

The synthetic suites run in a fake DOM and cannot catch DOM-liveness bugs.
When changing the file browser editor flow (lock toggle, dirty tabs, save),
also run a real-browser acceptance pass. The in-repo CDP harness was removed
(extension install is not always available); use the external cdp-chrome
skill (`~/.agents/skills/cdp-chrome`) to launch a self-contained headless
Chrome for Testing and drive the served app per `docs/e2e-external.md`.

When changing the Git explorer (folder actions, compare modes, discard),
also run the no-browser acceptance harness:

```sh
just git-e2e        # or: scripts/e2e/run-git-e2e.sh
```

It boots the served git-ui bundle in a node vm with fetch proxied to the
real backend, so it runs anywhere node and cargo do (no Chrome needed).

## Releases

WebUI releases use `v0.0.x` tags and GitHub Release notes. Do not prepare root Herdr release commits or tags from this repository.

## Commits

Use Conventional Commit subjects, for example:

```text
fix: preserve terminal focus during select input
```
