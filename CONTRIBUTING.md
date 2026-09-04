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
node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs
```

## End-to-end checks

The synthetic suites run in a fake DOM and cannot catch DOM-liveness bugs.
When changing the file browser editor flow (lock toggle, dirty tabs, save),
also run the real-browser acceptance harness:

```sh
scripts/e2e/run-e2e.sh
```

It builds an isolated server (own config dir and session, so a locally
running instance is never touched), drives the served app in headless
Chrome over CDP, and tears everything down. See `scripts/e2e/README.md`.

## Releases

WebUI releases use `v0.0.x` tags and GitHub Release notes. Do not prepare root Herdr release commits or tags from this repository.

## Commits

Use Conventional Commit subjects, for example:

```text
fix: preserve terminal focus during select input
```
