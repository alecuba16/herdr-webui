CARGO ?= cargo
ZIG ?= $(shell if [ -x "$(CURDIR)/zigbin/zig" ]; then printf '%s' "$(CURDIR)/zigbin/zig"; elif command -v zig@0.15 >/dev/null 2>&1; then command -v zig@0.15; elif [ -x /opt/homebrew/opt/zig@0.15/bin/zig ]; then printf '%s' /opt/homebrew/opt/zig@0.15/bin/zig; elif [ -x /usr/local/opt/zig@0.15/bin/zig ]; then printf '%s' /usr/local/opt/zig@0.15/bin/zig; else command -v zig; fi)
BIND ?= 127.0.0.1:8787
ROOT_MANIFEST := Cargo.toml
WEBUI_MANIFEST := webui/Cargo.toml
TARGET_DIR := target
INSTALL_LABEL ?= herdr-web
INSTALL_PLIST := $(HOME)/Library/LaunchAgents/$(INSTALL_LABEL).plist
LOCAL_BIN_DIR ?= $(HOME)/.local/bin
INSTALL_BIN ?= $(LOCAL_BIN_DIR)/herdr-webui
BUILD_BIN := $(CURDIR)/$(TARGET_DIR)/release/herdr-webui
INSTALL_LOG_DIR := $(HOME)/Library/Logs/herdr-webui
HERDR_WEB_LOCALHOST_NO_AUTH ?= true
HERDR_WEB_USER ?=
HERDR_WEB_PASSWORD ?=

.PHONY: build check check-rust fmt run-web run-web-local test test-js coverage clean install-mac update-mac uninstall-mac

build:
	ZIG="$(ZIG)" $(CARGO) build --release --manifest-path $(ROOT_MANIFEST) --target-dir $(TARGET_DIR)
	$(CARGO) build --release --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR)

check:
	$(CARGO) check --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR)

check-rust:
	$(CARGO) check --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR)

fmt:
	$(CARGO) fmt --manifest-path $(WEBUI_MANIFEST)

run-web:
	$(CARGO) run --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR) -- --bind $(BIND)

run-web-local:
	HERDR_WEB_LOCALHOST_NO_AUTH=true $(CARGO) run --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR) -- --bind $(BIND)

test: test-js
	$(CARGO) test --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR)

test-js:
	node --test webui/src/assets/app_core.test.mjs webui/src/assets/app_load.test.mjs

coverage:
	CARGO_TARGET_DIR=$(TARGET_DIR) $(CARGO) llvm-cov --manifest-path $(WEBUI_MANIFEST) --summary-only

clean:
	$(CARGO) clean --manifest-path $(WEBUI_MANIFEST) --target-dir $(TARGET_DIR)

install-mac: build
	mkdir -p "$(HOME)/Library/LaunchAgents" "$(INSTALL_LOG_DIR)" "$(LOCAL_BIN_DIR)"
	install -m 755 "$(BUILD_BIN)" "$(INSTALL_BIN)"
	@{ \
		echo '<?xml version="1.0" encoding="UTF-8"?>'; \
		echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'; \
		echo '<plist version="1.0">'; \
		echo '<dict>'; \
		echo '  <key>Label</key>'; \
		echo '  <string>$(INSTALL_LABEL)</string>'; \
		echo '  <key>ProgramArguments</key>'; \
		echo '  <array>'; \
		echo '    <string>$(INSTALL_BIN)</string>'; \
		echo '    <string>--bind</string>'; \
		echo '    <string>$(BIND)</string>'; \
		echo '  </array>'; \
		echo '  <key>EnvironmentVariables</key>'; \
		echo '  <dict>'; \
		echo '    <key>HERDR_WEB_LOCALHOST_NO_AUTH</key>'; \
		echo '    <string>$(HERDR_WEB_LOCALHOST_NO_AUTH)</string>'; \
		if [ -n "$(HERDR_WEB_USER)" ]; then echo '    <key>HERDR_WEB_USER</key>'; echo '    <string>$(HERDR_WEB_USER)</string>'; fi; \
		if [ -n "$(HERDR_WEB_PASSWORD)" ]; then echo '    <key>HERDR_WEB_PASSWORD</key>'; echo '    <string>$(HERDR_WEB_PASSWORD)</string>'; fi; \
		echo '  </dict>'; \
		echo '  <key>RunAtLoad</key>'; \
		echo '  <true/>'; \
		echo '  <key>KeepAlive</key>'; \
		echo '  <true/>'; \
		echo '  <key>StandardOutPath</key>'; \
		echo '  <string>$(INSTALL_LOG_DIR)/stdout.log</string>'; \
		echo '  <key>StandardErrorPath</key>'; \
		echo '  <string>$(INSTALL_LOG_DIR)/stderr.log</string>'; \
		echo '</dict>'; \
		echo '</plist>'; \
	} > "$(INSTALL_PLIST)"
	launchctl bootout "gui/$$(id -u)" "$(INSTALL_PLIST)" >/dev/null 2>&1 || true
	launchctl bootstrap "gui/$$(id -u)" "$(INSTALL_PLIST)"
	launchctl kickstart -k "gui/$$(id -u)/$(INSTALL_LABEL)"
	@echo "Installed $(INSTALL_LABEL) at $(INSTALL_PLIST)"
	@echo "Installed binary at $(INSTALL_BIN)"
	@if ! printf '%s' ":$$PATH:" | grep -q ":$(LOCAL_BIN_DIR):"; then echo "Note: $(LOCAL_BIN_DIR) is not in PATH for this shell"; fi
	@echo "Open http://$(BIND)"

update-mac: build
	mkdir -p "$(LOCAL_BIN_DIR)"
	install -m 755 "$(BUILD_BIN)" "$(INSTALL_BIN)"
	launchctl kickstart -k "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || \
		launchctl bootstrap "gui/$$(id -u)" "$(INSTALL_PLIST)"
	@echo "Updated binary at $(INSTALL_BIN)"
	@echo "Restarted $(INSTALL_LABEL)"

uninstall-mac:
	launchctl bootout "gui/$$(id -u)" "$(INSTALL_PLIST)" >/dev/null 2>&1 || true
	rm -f "$(INSTALL_PLIST)"
	@echo "Uninstalled $(INSTALL_LABEL)"
