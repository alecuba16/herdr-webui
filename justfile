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

# Real-browser acceptance for the pane strip rail (maximize keeps sibling
# strips visible). See scripts/e2e/README.md.
rail-e2e:
    scripts/e2e/run-rail-e2e.sh

# Real-browser acceptance for the Notes rail (server-synced notes panel:
# hosting, create/edit with CodeMirror, persistence, delete, clear-all).
# See scripts/e2e/README.md.
notes-rail-e2e:
    scripts/e2e/run-notes-rail-e2e.sh

# Live API+WebSocket probe: two subscribers must both get the
# notes_changed frame carrying the server contract (newest-first,
# display_title fallback, language table, created_note_id).
# See scripts/e2e/README.md.
notes-broadcast-probe:
    scripts/e2e/notes-broadcast-probe.sh

# Real-browser acceptance for the chat lens segment colors (thinking /
# tool names / running / failed rows, both themes, WCAG AA contrast).
# See scripts/e2e/README.md.
chat-colors-e2e:
    bash scripts/e2e/run-chat-colors-e2e.sh

# No-browser acceptance run for backend-built content-search chunks. See scripts/e2e/README.md.
content-search-e2e:
    scripts/e2e/run-content-search-e2e.sh

# Real-browser acceptance for the mobile composer-in-keybar unit and the
# Ctrl+Enter chord key (nesting, Keys toggle, rows, live chord bytes on
# the input WS, pane executes). See scripts/e2e/README.md.
mobile-chord-e2e:
    bash scripts/e2e/run-mobile-chord-e2e.sh

# Real-browser acceptance for the filter-results tree keyboard navigation
# (Up/Down select, Left/Right collapse/expand, Enter activates, Tab hops
# sections instead of walking rows). See scripts/e2e/README.md.
filter-tree-keyboard-e2e:
    bash scripts/e2e/run-filter-tree-keyboard-e2e.sh

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
