(function () {
  function createMobileSettings({
    applyTheme,
    escapeHtml,
    localStorage,
    state,
  }) {
    function render() {
      const layout = localStorage.getItem("herdr-web-layout") || "auto";
      const theme = localStorage.getItem("herdr-web-theme") || "auto";
      const font = terminalFontValue();
      const notifications = browserNotificationsEnabled();
      const depth = fileBrowserDepthValue();
      const directory = defaultDirectoryValue();
      const volume = notificationVolumeValue();
      return `<section class="mobile-section mobile-form"><h2>Settings</h2><div class="mobile-settings-group"><h3>Appearance</h3><label><span>Theme</span><select onchange="HerdrMobile.setThemeMode(this.value)"><option value="auto" ${theme === "auto" ? "selected" : ""}>Auto</option><option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${theme === "light" ? "selected" : ""}>Light</option></select></label></div><div class="mobile-settings-group"><h3>Layout</h3><label><span>Layout mode</span><select onchange="HerdrMobile.setLayoutPreference(this.value)"><option value="auto" ${layout === "auto" ? "selected" : ""}>Auto</option><option value="mobile" ${layout === "mobile" ? "selected" : ""}>Mobile</option><option value="desktop" ${layout === "desktop" ? "selected" : ""}>Desktop</option></select><small>Auto uses viewport width, not user agent.</small></label></div><div class="mobile-settings-group"><h3>Files</h3><label><span>Browser depth</span><input type="number" min="0" max="8" step="1" value="${depth}" onchange="HerdrMobile.setFileBrowserDepth(this.value)"></label><small>0 shows current folder only. 3 expands three folder levels.</small></div><div class="mobile-settings-group"><h3>Workspaces</h3><label><span>Default directory</span><input placeholder="../worktrees" value="${escapeHtml(directory)}" onchange="HerdrMobile.setDefaultDirectory(this.value)"></label><small>Prefills worktree discovery paths.</small></div><div class="mobile-settings-group"><h3>Alerts</h3><label><input type="checkbox" ${notifications ? "checked" : ""} onchange="HerdrMobile.setBrowserNotifications(this.checked)"><span>Browser notifications</span><small>Show system notifications when an agent is blocked or done.</small></label><label><span>Notification volume (${volume}%)</span><input type="range" min="0" max="100" step="1" value="${volume}" onchange="HerdrMobile.setNotificationVolume(this.value)"></label><small>Controls the local attention tone volume.</small></div><div class="mobile-settings-group"><h3>Terminal</h3><label><span>Terminal font</span><input placeholder="JetBrainsMono Nerd Font, monospace" value="${escapeHtml(font)}" onchange="HerdrMobile.setTerminalFontFamily(this.value)"></label><small>Add a Nerd Font family name so icon glyphs render. Leave blank for the default stack.</small></div><div class="mobile-settings-group"><h3>Data</h3><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.refresh()">Refresh data</button><button class="mobile-btn mobile-wide" onclick="location.reload()">Reload selected layout</button></div>${state.error ? `<div class="mobile-error">${escapeHtml(state.error)}</div>` : ""}</section>`;
    }

    function readOptions() {
      try {
        return JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      } catch (_) {
        return {};
      }
    }

    function writeOptions(options) {
      localStorage.setItem("herdr-web-options", JSON.stringify(options || {}));
    }

    function browserNotificationsEnabled() {
      return readOptions().browserNotifications === true;
    }

    function setThemeMode(value) {
      localStorage.setItem("herdr-web-theme", value);
      applyTheme();
    }

    function setLayoutPreference(value) {
      localStorage.setItem("herdr-web-layout", value);
    }

    function terminalFontValue() {
      return readOptions().terminalFontFamily || "";
    }

    function fileBrowserDepthValue() {
      const value = Number(readOptions().fileBrowserDepth);
      return Math.max(0, Math.min(8, Number.isFinite(value) ? value : 3));
    }

    function defaultDirectoryValue() {
      return String(readOptions().worktreeDefaultDirectory || "").trim();
    }

    function notificationVolumeValue() {
      const value = Number(readOptions().notificationVolume);
      const volume = Number.isFinite(value) ? value : 0.24;
      return Math.round(Math.max(0, Math.min(1, volume)) * 100);
    }

    function setDefaultDirectory(value) {
      const parsed = readOptions();
      parsed.worktreeDefaultDirectory = String(value || "").trim();
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setNotificationVolume(value) {
      const parsed = readOptions();
      parsed.notificationVolume = Math.max(
        0,
        Math.min(100, Number(value) || 0),
      ) / 100;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserDepth(value) {
      const parsed = readOptions();
      parsed.fileBrowserDepth = Math.max(0, Math.min(8, Number(value) || 0));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setTerminalFontFamily(value) {
      try {
        const parsed = readOptions();
        parsed.terminalFontFamily = String(value || "").trim();
        writeOptions(parsed);
      } catch (_) {}
      if (
        globalThis.HerdrMobile &&
        globalThis.HerdrMobile.applyTerminalFontFamily
      )
        globalThis.HerdrMobile.applyTerminalFontFamily();
    }

    async function setBrowserNotifications(value) {
      const parsed = readOptions();
      let enabled = !!value;
      if (enabled && "Notification" in globalThis) {
        let permission = globalThis.Notification.permission;
        if (permission === "default") permission = await globalThis.Notification.requestPermission();
        enabled = permission === "granted";
      } else if (enabled) {
        enabled = false;
      }
      parsed.browserNotifications = enabled;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    return { render, setBrowserNotifications, setDefaultDirectory, setFileBrowserDepth, setLayoutPreference, setNotificationVolume, setThemeMode, setTerminalFontFamily };
  }

  globalThis.HerdrMobileSettings = { create: createMobileSettings };
})();
