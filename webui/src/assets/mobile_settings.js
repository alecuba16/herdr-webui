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
      return `<section class="mobile-section mobile-form"><h2>Settings</h2><label><span>Layout</span><select onchange="HerdrMobile.setLayoutPreference(this.value)"><option value="auto" ${layout === "auto" ? "selected" : ""}>Auto</option><option value="mobile" ${layout === "mobile" ? "selected" : ""}>Mobile</option><option value="desktop" ${layout === "desktop" ? "selected" : ""}>Desktop</option></select><small>Auto uses viewport width, not user agent.</small></label><label><span>Theme</span><select onchange="HerdrMobile.setThemeMode(this.value)"><option value="auto" ${theme === "auto" ? "selected" : ""}>Auto</option><option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${theme === "light" ? "selected" : ""}>Light</option></select></label><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.refresh()">Refresh data</button><button class="mobile-btn mobile-wide" onclick="location.reload()">Reload selected layout</button>${state.error ? `<div class="mobile-error">${escapeHtml(state.error)}</div>` : ""}</section>`;
    }

    function setThemeMode(value) {
      localStorage.setItem("herdr-web-theme", value);
      applyTheme();
    }

    function setLayoutPreference(value) {
      localStorage.setItem("herdr-web-layout", value);
    }

    return { render, setLayoutPreference, setThemeMode };
  }

  globalThis.HerdrMobileSettings = { create: createMobileSettings };
})();
