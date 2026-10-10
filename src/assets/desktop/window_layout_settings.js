// Desktop-side window layout reset. Splits, maximized panes, per-workspace
// panel choices (Files/Git/Search), and the remembered workspace/tab
// selection persist in this browser (herdr-web-workspace-panes,
// herdr-web-workspace-shell, herdr-session-state:*). A layout that grew
// over months has no one-click way back to the fresh single-pane boot
// shape without clearing site data by hand. This module adds a Settings
// section with a reset button that calls window.resetWindowLayout
// (defined in app_js/render.js, same bundle) behind the standard
// danger confirm modal.
(function () {
  function reset() {
    if (typeof window.resetWindowLayout !== "function") return;
    window
      .resetWindowLayout()
      .then(function (done) {
        if (!done) return;
        const note = document.getElementById("windowLayoutResetNote");
        if (note) {
          note.textContent = "Layout reset. Panes rebuilt as single panes.";
          note.hidden = false;
        }
      })
      .catch(function () {});
  }

  window.HerdrSettingsModules = window.HerdrSettingsModules || [];
  window.HerdrSettingsModules.push({
    id: "windowLayout",
    title: "Window layout",
    desc: "Reset saved panes, splits, and panel state.",
    defaults: {},
    html: `
<div class="settings-section">
  <div class="settings-section-head">
    <h3>Window layout</h3>
    <p>Panes, splits, maximized panes, open panels, and the remembered workspace and tab selection are saved in this browser. Workspaces, panels, and agents on the server are untouched.</p>
  </div>
  <div class="option"><span>Reset window layout<small>Clears saved panes and splits, closes open panels, expands both sidebars, and forgets the remembered selection. Asks before resetting.</small></span><button type="button" class="btn" id="windowLayoutReset">Reset window layout</button></div>
  <p class="settings-note" id="windowLayoutResetNote" hidden></p>
</div>`,
    ids: ["windowLayoutReset"],
    normalize() {},
    apply() {},
    bind() {
      const button = document.getElementById("windowLayoutReset");
      if (!button || button.dataset.bound === "1") return;
      button.dataset.bound = "1";
      button.onclick = reset;
    },
  });
})();
