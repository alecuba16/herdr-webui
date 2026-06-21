# herdr-webui task runner

target_dir := "target"

fmt:
    cargo fmt --check

lint: fmt
    cargo clippy --target-dir {{target_dir}} --all-targets -- -D warnings

test-js:
    node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs

test: test-js
    cargo test --target-dir {{target_dir}}

check: lint test

build:
    cargo build --release --target-dir {{target_dir}}

run bind='127.0.0.1:8787':
    cargo run --target-dir {{target_dir}} -- --bind {{bind}}

install-hooks:
    git config core.hooksPath .githooks
    chmod +x .githooks/pre-commit .githooks/commit-msg
    @echo "installed git hooks from .githooks"
