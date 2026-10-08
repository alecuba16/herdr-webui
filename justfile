# herdr-webui task runner

target_dir := "target"

fmt:
    cargo fmt --check

lint: fmt
    cargo clippy --target-dir {{target_dir}} --all-targets -- -D warnings

test-js:
    node --test src/assets/*.test.mjs

# Live keyboard-guards audits: the runner builds, boots its own isolated
# server + headless Chrome and tears both down. Nothing external needed.
test-e2e:
    bash scripts/e2e/run-keyboard-guards-e2e.sh

test-all: test-js test-e2e
    cargo test --target-dir {{target_dir}}

test: test-js
    cargo test --target-dir {{target_dir}}

# No-browser acceptance run for the Git explorer rework. See scripts/e2e/README.md.
git-e2e:
    scripts/e2e/run-git-e2e.sh

# Real-browser acceptance for the Git-log hover card rework. See
# scripts/e2e/README.md.
log-hover-e2e:
    scripts/e2e/run-log-hover-e2e.sh

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
