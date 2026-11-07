CARGO ?= cargo
BIND ?= 127.0.0.1:8787
TARGET_DIR := target
INSTALL_LABEL ?= herdr-web
INSTALL_PLIST := $(HOME)/Library/LaunchAgents/$(INSTALL_LABEL).plist
LINUX_SERVICE := $(HOME)/.config/systemd/user/$(INSTALL_LABEL).service
LOCAL_BIN_DIR ?= $(HOME)/.local/bin
INSTALL_BIN ?= $(LOCAL_BIN_DIR)/herdr-webui
INSTALL_TUI_BIN ?= $(LOCAL_BIN_DIR)/herdr-webui-tui
BUILD_BIN := $(CURDIR)/$(TARGET_DIR)/release/herdr-webui
BUILD_TUI_BIN := $(CURDIR)/$(TARGET_DIR)/release/herdr-webui-tui
INSTALL_LOG_DIR := $(HOME)/Library/Logs/herdr-webui

.PHONY: build check check-rust fmt run-web run-web-local test test-js coverage clean install-mac update-mac start-mac stop-mac restart-mac uninstall-mac set-password install-linux update-linux start-linux stop-linux restart-linux uninstall-linux build-markdown

build:
	$(CARGO) build --release --bins --target-dir $(TARGET_DIR)

check:
	$(CARGO) check --target-dir $(TARGET_DIR)

check-rust:
	$(CARGO) check --target-dir $(TARGET_DIR)

fmt:
	$(CARGO) fmt

run-web:
	$(CARGO) run --target-dir $(TARGET_DIR) -- --bind $(BIND)

run-web-local:
	$(CARGO) run --target-dir $(TARGET_DIR) -- --bind $(BIND)

test: test-js
	$(CARGO) test --target-dir $(TARGET_DIR)

test-js:
	node --test src/assets/*.test.mjs

test-e2e:
	bash scripts/e2e/run-keyboard-guards-e2e.sh

test-all: test-js test-e2e
	$(CARGO) test --target-dir $(TARGET_DIR)

build-markdown:
	node scripts/build_markdown_assets.mjs

coverage:
	CARGO_TARGET_DIR=$(TARGET_DIR) $(CARGO) llvm-cov --summary-only

clean:
	$(CARGO) clean --target-dir $(TARGET_DIR)

install-mac: build
	# Delegate to the binary's own installer: it copies in place
	# (preserving the file identity for TCC), re-signs, and writes the
	# plist. BIND is forwarded as an explicit --bind only when the
	# operator overrode it (the default value means "honor the saved
	# webui-settings.json"); otherwise the service runs bare.
	$(TARGET_DIR)/release/herdr-webui install-mac $(if $(filter $(BIND),127.0.0.1:8787),,--bind $(BIND))

update-mac: build
	# The binary's updater owns the stop-first, in-place copy, re-sign,
	# and start sequence. No bind flag: an update must not re-pin the
	# saved bind into the service; the plist keeps whatever the last
	# install wrote (bare, or --bind when the operator pinned it).
	$(TARGET_DIR)/release/herdr-webui update-mac
	@echo "Updated binary at $(INSTALL_BIN)"
	@echo "Updated TUI binary at $(INSTALL_TUI_BIN)"

start-mac:
	@if [ ! -f "$(INSTALL_PLIST)" ]; then echo "LaunchAgent plist not found at $(INSTALL_PLIST)" >&2; exit 1; fi
	launchctl enable "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || true
	launchctl kickstart -k "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || \
		{ launchctl bootstrap "gui/$$(id -u)" "$(INSTALL_PLIST)" && launchctl kickstart -k "gui/$$(id -u)/$(INSTALL_LABEL)"; }
	@echo "Started $(INSTALL_LABEL)"

stop-mac:
	launchctl disable "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || true
	launchctl bootout "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || true
	@echo "Stopped $(INSTALL_LABEL)"

restart-mac:
	$(MAKE) stop-mac
	@sleep 1
	$(MAKE) start-mac
	@echo "Restarted $(INSTALL_LABEL)"

uninstall-mac:
	launchctl disable "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || true
	launchctl bootout "gui/$$(id -u)" "$(INSTALL_PLIST)" >/dev/null 2>&1 || true
	rm -f "$(INSTALL_PLIST)"
	@echo "Uninstalled $(INSTALL_LABEL)"

set-password: build
	# Set or clear the WebUI login password without running the server.
	# No password flag forwarding here: the binary prompts with echo off so
	# the secret never lands in shell history or process listings.
	$(TARGET_DIR)/release/herdr-webui set-password

install-linux: build
	# Delegate to the binary's installer (in-place copy + unit write).
	# BIND is forwarded as an explicit --bind only when the operator
	# overrode it; the default value means "honor the saved
	# webui-settings.json", so the service runs bare.
	$(TARGET_DIR)/release/herdr-webui install-linux $(if $(filter $(BIND),127.0.0.1:8787),,--bind $(BIND))

update-linux: build
	# The binary's updater owns the stop-first copy and restart. No bind
	# flag: an update must not re-pin the saved bind into the unit.
	$(TARGET_DIR)/release/herdr-webui update-linux
	@echo "Updated binary at $(INSTALL_BIN)"
	@echo "Updated TUI binary at $(INSTALL_TUI_BIN)"

start-linux:
	@if [ ! -f "$(LINUX_SERVICE)" ]; then echo "systemd user service not found at $(LINUX_SERVICE)" >&2; exit 1; fi
	systemctl --user start "$(INSTALL_LABEL).service"
	@echo "Started $(INSTALL_LABEL)"

stop-linux:
	systemctl --user stop "$(INSTALL_LABEL).service"
	@echo "Stopped $(INSTALL_LABEL)"

restart-linux:
	@if [ ! -f "$(LINUX_SERVICE)" ]; then echo "systemd user service not found at $(LINUX_SERVICE)" >&2; exit 1; fi
	systemctl --user restart "$(INSTALL_LABEL).service"
	@echo "Restarted $(INSTALL_LABEL)"

uninstall-linux:
	systemctl --user disable --now "$(INSTALL_LABEL).service" >/dev/null 2>&1 || true
	rm -f "$(LINUX_SERVICE)"
	systemctl --user daemon-reload >/dev/null 2>&1 || true
	@echo "Uninstalled $(INSTALL_LABEL)"
