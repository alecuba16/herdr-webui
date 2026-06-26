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
      return `<section class="mobile-section mobile-form"><h2>Settings</h2><div class="mobile-settings-group"><h3>Appearance</h3><label><span>Theme</span><select onchange="HerdrMobile.setThemeMode(this.value)"><option value="auto" ${theme === "auto" ? "selected" : ""}>Auto</option><option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${theme === "light" ? "selected" : ""}>Light</option></select></label></div><div class="mobile-settings-group"><h3>Layout</h3><label><span>Layout mode</span><select onchange="HerdrMobile.setLayoutPreference(this.value)"><option value="auto" ${layout === "auto" ? "selected" : ""}>Auto</option><option value="mobile" ${layout === "mobile" ? "selected" : ""}>Mobile</option><option value="desktop" ${layout === "desktop" ? "selected" : ""}>Desktop</option></select><small>Auto uses viewport width, not user agent.</small></label></div><div class="mobile-settings-group"><h3>Terminal</h3><label><span>Terminal font</span><input placeholder="JetBrainsMono Nerd Font, monospace" value="${escapeHtml(font)}" onchange="HerdrMobile.setTerminalFontFamily(this.value)"></label><small>Add a Nerd Font family name so icon glyphs render. Leave blank for the default stack.</small></div><div class="mobile-settings-group"><h3>Data</h3><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.refresh()">Refresh data</button><button class="mobile-btn mobile-wide" onclick="location.reload()">Reload selected layout</button></div>${state.error ? `<div class="mobile-error">${escapeHtml(state.error)}</div>` : ""}</section>`;
    }

    function setThemeMode(value) {
      localStorage.setItem("herdr-web-theme", value);
      applyTheme();
    }

    function setLayoutPreference(value) {
      localStorage.setItem("herdr-web-layout", value);
    }

    function terminalFontValue() {
      try {
        const parsed = JSON.parse(
          localStorage.getItem("herdr-web-options") || "{}",
        );
        return (parsed && parsed.terminalFontFamily) || "";
      } catch (_) {
        return "";
      }
    }

    function setTerminalFontFamily(value) {
      try {
        const parsed = JSON.parse(
          localStorage.getItem("herdr-web-options") || "{}",
        );
        parsed.terminalFontFamily = String(value || "").trim();
        localStorage.setItem("herdr-web-options", JSON.stringify(parsed));
      } catch (_) {}
      if (
        globalThis.HerdrMobile &&
        globalThis.HerdrMobile.applyTerminalFontFamily
      )
        globalThis.HerdrMobile.applyTerminalFontFamily();
    }

    return { render, setLayoutPreference, setThemeMode, setTerminalFontFamily };
  }

  globalThis.HerdrMobileSettings = { create: createMobileSettings };
})();
