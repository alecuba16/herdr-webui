# herdr-webui task runner

target_dir := "target"

fmt:
    cargo fmt --manifest-path webui/Cargo.toml --check

lint: fmt
    cargo clippy --manifest-path webui/Cargo.toml --target-dir {{target_dir}} --all-targets -- -D warnings

test-js:
    node --test webui/src/assets/app_core.test.mjs webui/src/assets/app_load.test.mjs webui/src/assets/app_boot.test.mjs webui/src/assets/mobile_load.test.mjs

test: test-js
    cargo test --manifest-path webui/Cargo.toml --target-dir {{target_dir}}

check: lint test

build:
    cargo build --release --manifest-path webui/Cargo.toml --target-dir {{target_dir}}

run bind='127.0.0.1:8787':
    cargo run --manifest-path webui/Cargo.toml --target-dir {{target_dir}} -- --bind {{bind}}

install-hooks:
    git config core.hooksPath .githooks
    chmod +x .githooks/pre-commit .githooks/commit-msg
    @echo "installed git hooks from .githooks"
