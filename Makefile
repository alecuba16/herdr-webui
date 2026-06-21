CARGO ?= cargo
BIND ?= 127.0.0.1:8787
TARGET_DIR := target
INSTALL_LABEL ?= herdr-web
INSTALL_PLIST := $(HOME)/Library/LaunchAgents/$(INSTALL_LABEL).plist
LINUX_SERVICE := $(HOME)/.config/systemd/user/$(INSTALL_LABEL).service
LOCAL_BIN_DIR ?= $(HOME)/.local/bin
INSTALL_BIN ?= $(LOCAL_BIN_DIR)/herdr-webui
BUILD_BIN := $(CURDIR)/$(TARGET_DIR)/release/herdr-webui
INSTALL_LOG_DIR := $(HOME)/Library/Logs/herdr-webui

.PHONY: build check check-rust fmt run-web run-web-local test test-js coverage clean install-mac update-mac start-mac stop-mac restart-mac uninstall-mac install-linux update-linux start-linux stop-linux restart-linux uninstall-linux

build:
	$(CARGO) build --release --target-dir $(TARGET_DIR)

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
	node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs

coverage:
	CARGO_TARGET_DIR=$(TARGET_DIR) $(CARGO) llvm-cov --summary-only

clean:
	$(CARGO) clean --target-dir $(TARGET_DIR)

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
	$(MAKE) restart-mac
	@echo "Updated binary at $(INSTALL_BIN)"

start-mac:
	@if [ ! -f "$(INSTALL_PLIST)" ]; then echo "LaunchAgent plist not found at $(INSTALL_PLIST)" >&2; exit 1; fi
	launchctl kickstart -k "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || \
		{ launchctl bootstrap "gui/$$(id -u)" "$(INSTALL_PLIST)" && launchctl kickstart -k "gui/$$(id -u)/$(INSTALL_LABEL)"; }
	@echo "Started $(INSTALL_LABEL)"

stop-mac:
	launchctl bootout "gui/$$(id -u)/$(INSTALL_LABEL)" >/dev/null 2>&1 || true
	@echo "Stopped $(INSTALL_LABEL)"

restart-mac: stop-mac start-mac
	@echo "Restarted $(INSTALL_LABEL)"

uninstall-mac:
	launchctl bootout "gui/$$(id -u)" "$(INSTALL_PLIST)" >/dev/null 2>&1 || true
	rm -f "$(INSTALL_PLIST)"
	@echo "Uninstalled $(INSTALL_LABEL)"

install-linux: build
	mkdir -p "$(LOCAL_BIN_DIR)" "$$(dirname "$(LINUX_SERVICE)")"
	install -m 755 "$(BUILD_BIN)" "$(INSTALL_BIN)"
	@{ \
		echo '[Unit]'; \
		echo 'Description=Herdr WebUI'; \
		echo 'After=network.target'; \
		echo; \
		echo '[Service]'; \
		echo 'Type=simple'; \
		echo 'ExecStart=$(INSTALL_BIN) --bind $(BIND)'; \
		echo 'Restart=always'; \
		echo 'RestartSec=2'; \
		echo; \
		echo '[Install]'; \
		echo 'WantedBy=default.target'; \
	} > "$(LINUX_SERVICE)"
	systemctl --user daemon-reload
	systemctl --user enable --now "$(INSTALL_LABEL).service"
	@echo "Installed $(INSTALL_LABEL) at $(LINUX_SERVICE)"
	@echo "Installed binary at $(INSTALL_BIN)"
	@echo "Open http://$(BIND)"

update-linux: build
	mkdir -p "$(LOCAL_BIN_DIR)"
	install -m 755 "$(BUILD_BIN)" "$(INSTALL_BIN)"
	systemctl --user daemon-reload
	$(MAKE) restart-linux
	@echo "Updated binary at $(INSTALL_BIN)"

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
