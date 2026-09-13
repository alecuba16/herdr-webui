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

# Real-browser acceptance run (file explorer edit flow). See scripts/e2e/README.md.
e2e:
    scripts/e2e/run-e2e.sh

# No-browser acceptance run for the Git explorer rework. See scripts/e2e/README.md.
git-e2e:
    scripts/e2e/run-git-e2e.sh

# No-browser acceptance run for backend-built content-search chunks. See scripts/e2e/README.md.
content-search-e2e:
    scripts/e2e/run-content-search-e2e.sh

# Real-browser acceptance run for the theme system. See scripts/e2e/README.md.
theme-e2e:
    scripts/e2e/run-theme-e2e.sh

# Real-browser acceptance run for terminal fill + panel-switch refit
# (includes opening the Git drawer in the live DOM). See scripts/e2e/README.md.
terminal-fit-e2e:
    scripts/e2e/run-terminal-fit-e2e.sh

# Real-browser acceptance run for the Git drawer CONTENT (changes tree,
# diff view, log graph, branch list) in the live DOM. See scripts/e2e/README.md.
git-drawer-e2e:
    scripts/e2e/run-git-drawer-e2e.sh

check: lint test

build:
    cargo build --release --target-dir {{target_dir}}

run bind='127.0.0.1:8787':
    cargo run --target-dir {{target_dir}} -- --bind {{bind}}

install-hooks:
    git config core.hooksPath .githooks
    chmod +x .githooks/pre-commit .githooks/commit-msg
    @echo "installed git hooks from .githooks"
