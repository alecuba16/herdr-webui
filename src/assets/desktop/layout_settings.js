// Desktop-side layout preference control: the mobile bundle has a Layout
// section (Settings → Layout with auto/mobile/desktop). Desktop had none,
// so a desktop user who wants the mobile UI on a narrow window (or vice
// versa) had no in-app control. This module adds Settings → Layout with the
// same herdr-web-layout localStorage key app_boot.js resolves at load.
// Changing it reloads the app so the new bundle loads — the same contract
// as mobile's "Reload selected layout" Data row.
(function () {
  const KEY = "herdr-web-layout";

  function readPreference() {
    try {
      const value = localStorage.getItem(KEY);
      if (value === "desktop" || value === "mobile") return value;
    } catch (_) {}
    return "auto";
  }

  window.HerdrSettingsModules = window.HerdrSettingsModules || [];
  window.HerdrSettingsModules.push({
    id: "layout",
    title: "Layout",
    desc: "Choose which UI bundle loads: desktop, mobile, or auto by viewport width.",
    defaults: {},
    html: `
<div class="settings-section">
  <div class="settings-section-head">
    <h3>Layout</h3>
    <p>Auto follows the viewport width (max-width 760px means mobile). Saved in this browser; switching reloads the app.</p>
  </div>
  <label class="option"><span>Layout mode<small>Auto uses viewport width, not user agent.</small></span><select class="settings-select" id="optLayoutMode"><option value="auto">Auto</option><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></label>
  <p class="settings-note" id="layoutSettingsNote" hidden></p>
</div>`,
    ids: ["optLayoutMode"],
    normalize() {},
    apply() {
      const select = document.getElementById("optLayoutMode");
      if (select) select.value = readPreference();
    },
    bind(ctx) {
      const select = document.getElementById("optLayoutMode");
      if (!select || select.dataset.bound === "1") return;
      select.dataset.bound = "1";
      select.value = readPreference();
      select.onchange = () => {
        const value = select.value === "mobile" || select.value === "desktop" ? select.value : "auto";
        try {
          localStorage.setItem(KEY, value);
        } catch (_) {}
        const note = document.getElementById("layoutSettingsNote");
        if (note) {
          note.textContent = "Layout preference saved. Reloading…";
          note.hidden = false;
        }
        window.setTimeout(() => window.location.reload(), 150);
      };
    },
  });
})();