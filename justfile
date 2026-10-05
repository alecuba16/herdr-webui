# herdr-webui task runner

target_dir := "target"

fmt:
    cargo fmt --check

lint: fmt
    cargo clippy --target-dir {{target_dir}} --all-targets -- -D warnings

test-js:
    node --test src/assets/*.test.mjs

test: test-js
    cargo test --target-dir {{target_dir}}

# Acceptance checks live in scripts/e2e. No-browser ones run from here.
# Real-browser acceptance (headless Chrome over CDP) moved out of the repo:
# use the external cdp-chrome skill (~/.agents/skills/cdp-chrome) to launch
# a headless Chrome for Testing, then drive the served app per
# docs/e2e-external.md.

# No-browser acceptance run for the Git explorer rework. See scripts/e2e/README.md.
git-e2e:
    scripts/e2e/run-git-e2e.sh

# No-browser acceptance run for backend-built content-search chunks. See scripts/e2e/README.md.
content-search-e2e:
    scripts/e2e/run-content-search-e2e.sh

# External-backend graphics probe: isolated herdr 0.9.0 daemon + the webui's
# protocol.rs types speaking the real ClientShell endpoint protocol. See
# scripts/e2e/README.md.
external-graphics-probe:
    scripts/e2e/run-external-graphics-probe.sh

check: lint test

build:
    cargo build --release --target-dir {{target_dir}}

run bind='127.0.0.1:8787':
    cargo run --target-dir {{target_dir}} -- --bind {{bind}}

install-hooks:
    git config core.hooksPath .githooks
    chmod +x .githooks/pre-commit .githooks/commit-msg
    @echo "installed git hooks from .githooks"
