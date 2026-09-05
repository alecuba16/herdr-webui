(function () {
  window.HerdrSettingsModules = window.HerdrSettingsModules || [];
  window.HerdrSettingsModules.push({
    id: "lsp",
    title: "Language servers",
    desc: "Editor intelligence backed by local language servers (diagnostics, hover, completion).",
    defaults: { lspEnabled: false },
    html: `
<div class="settings-section">
  <div class="settings-section-head">
    <h3>Language servers</h3>
    <p>Runs locally installed language servers, like Zed. Configure which server to use per language and start it from the editor.</p>
  </div>
  <label class="option"><input type="checkbox" id="optLspEnabled"><span>Enable language servers<small>Off by default. When on, opening a file starts its language server and shows diagnostics, hover, and completion.</small></span></label>
  <div class="worktree-error" id="lspSettingsError"></div>
  <div class="modal-actions">
    <button type="button" class="tab add" id="lspSettingsScan">Scan installed servers</button>
  </div>
  <div id="lspSettingsServers" class="lsp-settings-servers"></div>
</div>`,
    ids: ["optLspEnabled"],
    normalize(options) {
      options.lspEnabled = options.lspEnabled === true;
    },
    apply(options) {
      const enabled = document.getElementById("optLspEnabled");
      if (enabled) enabled.checked = options.lspEnabled === true;
    },
    bind(ctx) {
      const enabled = document.getElementById("optLspEnabled");
      if (enabled && enabled.dataset.bound !== "1") {
        enabled.dataset.bound = "1";
        enabled.onchange = () => {
          ctx.setOption("lspEnabled", enabled.checked);
          ctx.saveOptions();
          if (window.HerdrFileBrowser && window.HerdrFileBrowser.refreshLsp) window.HerdrFileBrowser.refreshLsp();
        };
      }
      const scan = document.getElementById("lspSettingsScan");
      if (scan && scan.dataset.bound !== "1") {
        scan.dataset.bound = "1";
        scan.onclick = () => { loadLspSettings(); };
      }
      if (scan) loadLspSettings();
    },
  });

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function api(url, opt) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
  }

  function post(url, payload) {
    return api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  async function loadLspSettings() {
    const container = document.getElementById("lspSettingsServers");
    const error = document.getElementById("lspSettingsError");
    if (!container) return;
    if (!window.HerdrLsp) {
      container.innerHTML = `<p class="settings-note">LSP client unavailable on this layout.</p>`;
      return;
    }
    container.innerHTML = `<p class="settings-note">Scanning…</p>`;
    let config, detected;
    try {
      const [configBody, detectBody] = await Promise.all([
        window.HerdrLsp.getConfig(),
        window.HerdrLsp.detect(),
      ]);
      config = configBody;
      detected = detectBody || [];
    } catch (err) {
      if (error) error.textContent = err.message || String(err);
      container.innerHTML = "";
      return;
    }
    renderServers(container, config, detected);
  }

  function renderServers(container, config, detected) {
    const settings = (config && config.settings) || { enabled: false, servers: {} };
    const byLanguage = new Map(detected.map((d) => [d.language, d]));
    const languages = (config.languages && config.languages.length ? config.languages : detected.map((d) => d.language)).slice().sort();
    const rows = languages.map((language) => {
      const found = byLanguage.get(language);
      const configured = settings.servers && settings.servers[language];
      const serverName = (found && found.name) || (configured && configured.command) || "";
      const isFound = !!(found && found.found);
      const enabled = !!(configured && configured.enabled);
      const hint = (found && found.hint) || "";
      const foundPath = (found && found.found) || "";
      const status = isFound
        ? `<span class="lsp-server-status found" title="${esc(foundPath)}">Installed</span>`
        : `<span class="lsp-server-status missing">Not found</span>`;
      const install = !isFound && hint ? `<small class="lsp-server-hint">${esc(hint)}</small>` : "";
      return `<div class="lsp-server-row" data-language="${esc(language)}">
        <div class="lsp-server-row-head">
          <label class="lsp-server-toggle"><input type="checkbox" data-lsp-language-enable="${esc(language)}" ${enabled ? "checked" : ""}><span class="lsp-server-language">${esc(language)}</span></label>
          ${status}
          <span class="lsp-server-name">${esc(serverName)}</span>
        </div>
        ${install}
      </div>`;
    });
    container.innerHTML = rows.join("") || `<p class="settings-note">No known languages.</p>`;
    container.querySelectorAll("[data-lsp-language-enable]").forEach((input) => {
      input.onchange = () => toggleLanguage(container, config, detected, input);
    });
  }

  async function toggleLanguage(container, config, detected, input) {
    const error = document.getElementById("lspSettingsError");
    const language = input.getAttribute("data-lsp-language-enable");
    const settings = JSON.parse(JSON.stringify((config && config.settings) || { enabled: false, servers: {} }));
    settings.servers = settings.servers || {};
    const existing = settings.servers[language] || {};
    settings.servers[language] = Object.assign({}, existing, {
      enabled: input.checked,
      command: existing.command || null,
      args: existing.args || [],
    });
    try {
      const body = await window.HerdrLsp.updateConfig(settings);
      config.settings = body.settings;
      if (error) error.textContent = "";
    } catch (err) {
      if (error) error.textContent = err.message || String(err);
      input.checked = !input.checked;
    }
  }

  window.HerdrLspSettings = { reload: loadLspSettings };
})();