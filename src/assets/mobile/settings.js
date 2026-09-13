(function () {
  function createMobileSettings({
    api,
    applyTheme,
    escapeHtml,
    localStorage,
    state,
  }) {
    const normalizeOrder = globalThis.HerdrAppHelpers.normalizeOrder;
    let settingsFilter = "";
    // Row id -> { label } for badges to emit on the next render. Setters run
    // before HerdrMobile.refresh() re-renders the whole settings screen, so a
    // badge appended to the live DOM would be wiped; instead render() bakes
    // the badge into the row keyed by data-settings-id, and a timer clears it
    // with one extra re-render.
    const pendingAppliedFlash = new Map();
    let appliedFlashTimer = null;
    let pendingSearchOrderFlash = null;
    const APPLIED_FLASH_MS = 2500;
    // Values saved when the settings screen was opened (per row id). A
    // rollback chip appears whenever the saved value drifted from this
    // baseline; the baseline self-heals whenever the current value equals
    // it again (for example after a rollback).
    const settingBaselines = new Map();

    // Settings entry (re)captures the open-time snapshot. Called by
    // showScreen("settings") so re-entering Settings never rolls back to
    // values saved during an earlier visit.
    function resetSettingBaselines() {
      settingBaselines.clear();
    }

    function baselineValue(settingsId) {
      if (!settingBaselines.has(settingsId))
        settingBaselines.set(settingsId, currentValueFor(settingsId));
      return settingBaselines.get(settingsId);
    }

    function currentValueFor(settingsId) {
      const options = readOptions();
      switch (settingsId) {
        case "theme":
          return localStorage.getItem("herdr-web-theme") || "auto";
        case "layout":
          return localStorage.getItem("herdr-web-layout") || "auto";
        case "notificationVolume":
          return Math.round(
            Math.max(0, Math.min(1, Number(options.notificationVolume) || 0)) * 100,
          );
        default: {
          const value = options[settingsId];
          return value === undefined ? "" : value;
        }
      }
    }

    function rollbackHtml(settingsId) {
      const baseline = baselineValue(settingsId);
      const current = currentValueFor(settingsId);
      if (String(baseline) === String(current)) return "";
      return `<button type="button" class="settings-rollback" data-rollback-id="${escapeHtml(settingsId)}" onclick="HerdrMobile.rollbackSetting('${escapeHtml(settingsId)}')" aria-label="Roll back this change" title="Roll back this change">↺</button>`;
    }

    function rollbackSetting(settingsId) {
      const baseline = baselineValue(settingsId);
      if (baseline === undefined) return;
      switch (settingsId) {
        case "theme":
          localStorage.setItem("herdr-web-theme", String(baseline));
          applyTheme();
          break;
        case "layout":
          localStorage.setItem("herdr-web-layout", String(baseline));
          break;
        case "notificationVolume": {
          const parsed = readOptions();
          parsed.notificationVolume =
            Math.max(0, Math.min(100, Number(baseline) || 0)) / 100;
          writeOptions(parsed);
          break;
        }
        default: {
          const parsed = readOptions();
          parsed[settingsId] = baseline;
          writeOptions(parsed);
          break;
        }
      }
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.applyTerminalFontFamily && settingsId === "terminalFontFamily")
        globalThis.HerdrMobile.applyTerminalFontFamily();
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.reloadTerminal && settingsId === "terminalCore")
        globalThis.HerdrMobile.reloadTerminal();
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function queueAppliedFlash(settingsId, label) {
      if (!settingsId) return;
      pendingAppliedFlash.set(String(settingsId), { label: label || "Applied" });
      if (appliedFlashTimer) clearTimeout(appliedFlashTimer);
      appliedFlashTimer = setTimeout(clearAppliedFlash, APPLIED_FLASH_MS);
    }

    function clearAppliedFlash() {
      pendingAppliedFlash.clear();
      appliedFlashTimer = null;
      pendingSearchOrderFlash = null;
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function appliedFlashHtml(settingsId) {
      if (!pendingAppliedFlash.size) return "";
      const pending = pendingAppliedFlash.get(String(settingsId));
      if (!pending) return "";
      return `<span class="settings-applied" aria-live="polite" data-state="settings-applied-ok">✓ ${escapeHtml(pending.label)}</span>`;
    }

    function render() {
      const layout = localStorage.getItem("herdr-web-layout") || "auto";
      const theme = localStorage.getItem("herdr-web-theme") || "auto";
      const font = terminalFontValue();
      const notifications = browserNotificationsEnabled();
      const depth = fileBrowserDepthValue();
      const lineNumbers = fileBrowserLineNumbersEnabled();
      const headerSearch = headerSearchEnabled();
      const searchOrder = searchSectionOrderValue();
      const pathSearchPageSize = fileBrowserSearchPageSizeValue();
      const minChars = contentSearchMinCharsValue();
      const contentPageSize = contentSearchPageSizeValue();
      const contextLines = contentSearchContextLinesValue();
      const autoCollapse = contentSearchAutoCollapseFilesValue();
      const defaultExpanded = contentSearchDefaultExpandedValue();
      const matchesPerFile = contentSearchMatchesPerFileValue();
      const matchCase = contentSearchMatchCaseValue();
      const regex = contentSearchRegexValue();
      const worktreeDirectory = worktreeDefaultDirectoryValue();
      const explorationDirectory = explorationDefaultDirectoryValue();
      const volume = notificationVolumeValue();
      const soundScope = readOptions().soundScope === "all" ? "all" : "current";
      const agentSortMode = readOptions().agentSortMode || "off";
      const stuckWorking = readOptions().stuckWorkingEnabled !== false;
      const dismissMinutes = workingDismissMinutesValue();
      const noSleep = state.noSleep || { mode: "off", error: null, supported: true };
      const links = terminalLinksEnabled();
      const core = terminalCoreValue();
      const mouseReporting = terminalMouseReportingEnabled();
      const editorEnhanced = editorEnhancedEnabled();
      const editorWordWrap = editorWordWrapEnabled();
      const editorTabSize = editorTabSizeValue();
      const lsp = lspEnabled();
      const groups = [
        { title: "Appearance", keywords: "theme dark light auto", html: appearanceSection(theme), open: true },
        { title: "Layout", keywords: "layout mobile desktop auto", html: layoutSection(layout) },
        { title: "Editor", keywords: "editor word wrap tab size codemirror lsp diagnostics language server", html: editorSection(editorEnhanced, editorWordWrap, editorTabSize, lsp) },
        { title: "Files and search", keywords: "files search browser content line numbers regex", html: filesSection(depth, lineNumbers, headerSearch, searchOrder, pathSearchPageSize, minChars, contentPageSize, contextLines, autoCollapse, defaultExpanded, matchesPerFile, matchCase, regex) },
        { title: "Workspaces", keywords: "workspace worktree exploration default directory", html: workspacesSection(worktreeDirectory, explorationDirectory) },
        { title: "Alerts", keywords: "alerts notifications sound volume scope", html: alertsSection(notifications, volume, soundScope) },
        { title: "Agents", keywords: "agents sorting stuck working dismiss blocked done idle", html: agentsSection(agentSortMode, stuckWorking, dismissMinutes) },
        { title: "Energy", keywords: "no sleep energy coffee awake power", html: energySection(noSleep.mode, noSleep.error, noSleep.supported === false) },
        { title: "Terminal", keywords: "terminal renderer core ghostty font links mouse reporting", html: terminalSection(font, core, links, mouseReporting) },
        { title: "Data", keywords: "refresh reload data", html: dataSection() },
      ];
      const anyVisible = groups.some(settingsGroupVisible);
      return `<section class="mobile-section mobile-form"><h2>Settings</h2><label class="mobile-settings-filter"><span>Filter settings</span><input value="${escapeHtml(settingsFilter)}" oninput="HerdrMobile.setSettingsFilter(this.value)" placeholder="Search settings"></label>${groups.map((group) => renderSettingsDisclosure(group)).join("")}<div id="mobileSettingsEmpty" class="mobile-loading"${anyVisible ? " hidden" : ""}>No settings match.</div>${state.error ? `<div class="mobile-error">${escapeHtml(state.error)}</div>` : ""}</section>`;
    }

    function settingsGroupVisible(group) {
      const needle = settingsFilter.trim().toLowerCase();
      if (!needle) return true;
      return `${group.title} ${group.keywords}`.toLowerCase().includes(needle);
    }

    function renderSettingsDisclosure(group) {
      const html = stripGroupHeading(group.title, group.html);
      const open = group.open || !!settingsFilter.trim();
      const hidden = settingsGroupVisible(group) ? "" : " hidden";
      const searchText = `${group.title} ${group.keywords}`.toLowerCase();
      return `<details class="mobile-settings-disclosure" data-settings-text="${escapeHtml(searchText)}"${open ? " open" : ""}${hidden}><summary>${escapeHtml(group.title)}</summary>${html}</details>`;
    }

    function stripGroupHeading(title, html) {
      return String(html).replace(`<div class="mobile-settings-group"><h3>${title}</h3>`, '<div class="mobile-settings-group">');
    }

    function appearanceSection(theme) {
      return `<div class="mobile-settings-group"><h3>Appearance</h3><label data-settings-id="theme">${rollbackHtml("theme")}${appliedFlashHtml("theme")}<span>Theme</span><select onchange="HerdrMobile.setThemeMode(this.value)"><option value="auto" ${theme === "auto" ? "selected" : ""}>Auto</option><option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${theme === "light" ? "selected" : ""}>Light</option></select></label></div>`;
    }

    function layoutSection(layout) {
      return `<div class="mobile-settings-group"><h3>Layout</h3><label data-settings-id="layout">${rollbackHtml("layout")}${appliedFlashHtml("layout")}<span>Layout mode</span><select onchange="HerdrMobile.setLayoutPreference(this.value)"><option value="auto" ${layout === "auto" ? "selected" : ""}>Auto</option><option value="mobile" ${layout === "mobile" ? "selected" : ""}>Mobile</option><option value="desktop" ${layout === "desktop" ? "selected" : ""}>Desktop</option></select><small>Auto uses viewport width, not user agent.</small></label></div>`;
    }

    function filesSection(depth, lineNumbers, headerSearch, searchOrder, pathSearchPageSize, minChars, contentPageSize, contextLines, autoCollapse, defaultExpanded, matchesPerFile, matchCase, regex) {
      return `<div class="mobile-settings-group"><h3>Files and search</h3><label data-settings-id="fileBrowserDepth">${rollbackHtml("fileBrowserDepth")}${appliedFlashHtml("fileBrowserDepth")}<span>Browser depth</span><input type="number" min="0" max="8" step="1" value="${depth}" onchange="HerdrMobile.setFileBrowserDepth(this.value)"></label><small>0 shows current folder only. 3 expands three folder levels.</small><label data-settings-id="fileBrowserLineNumbers">${rollbackHtml("fileBrowserLineNumbers")}${appliedFlashHtml("fileBrowserLineNumbers")}<input type="checkbox" ${lineNumbers ? "checked" : ""} onchange="HerdrMobile.setFileBrowserLineNumbers(this.checked)"><span>Line numbers</span><small>Show line numbers when previewing text files.</small></label><label data-settings-id="headerSearchEnabled">${rollbackHtml("headerSearchEnabled")}${appliedFlashHtml("headerSearchEnabled")}<input type="checkbox" ${headerSearch ? "checked" : ""} onchange="HerdrMobile.setHeaderSearchEnabled(this.checked)"><span>Header search button</span><small>Show the search action and allow the palette to open.</small></label><div><span>Search section order</span>${renderSearchSectionOrder(searchOrder, pendingSearchOrderFlash)}</div><small>Use arrows to move sections. Use Shown/Hidden to include or remove a section.</small><label data-settings-id="fileBrowserSearchPageSize">${rollbackHtml("fileBrowserSearchPageSize")}${appliedFlashHtml("fileBrowserSearchPageSize")}<span>File/folder page size</span><input type="number" min="10" max="500" step="10" value="${pathSearchPageSize}" onchange="HerdrMobile.setFileBrowserSearchPageSize(this.value)"></label><label data-settings-id="fileContentSearchMinChars">${rollbackHtml("fileContentSearchMinChars")}${appliedFlashHtml("fileContentSearchMinChars")}<span>Content minimum characters</span><input type="number" min="1" max="20" step="1" value="${minChars}" onchange="HerdrMobile.setFileContentSearchMinChars(this.value)"></label><label data-settings-id="fileContentSearchPageSize">${rollbackHtml("fileContentSearchPageSize")}${appliedFlashHtml("fileContentSearchPageSize")}<span>Content page size</span><input type="number" min="10" max="500" step="10" value="${contentPageSize}" onchange="HerdrMobile.setFileContentSearchPageSize(this.value)"></label><label data-settings-id="fileContentSearchContextLines">${rollbackHtml("fileContentSearchContextLines")}${appliedFlashHtml("fileContentSearchContextLines")}<span>Content context lines</span><input type="number" min="0" max="20" step="1" value="${contextLines}" onchange="HerdrMobile.setFileContentSearchContextLines(this.value)"></label><label data-settings-id="fileContentSearchAutoCollapseFiles">${rollbackHtml("fileContentSearchAutoCollapseFiles")}${appliedFlashHtml("fileContentSearchAutoCollapseFiles")}<span>Content auto-collapse files</span><input type="number" min="0" max="200" step="1" value="${autoCollapse}" onchange="HerdrMobile.setFileContentSearchAutoCollapseFiles(this.value)"></label><label data-settings-id="fileContentSearchDefaultExpanded">${rollbackHtml("fileContentSearchDefaultExpanded")}${appliedFlashHtml("fileContentSearchDefaultExpanded")}<input type="checkbox" ${defaultExpanded ? "checked" : ""} onchange="HerdrMobile.setFileContentSearchDefaultExpanded(this.checked)"><span>Content results expanded by default</span><small>Expand each file group when content results load.</small></label><label data-settings-id="fileContentSearchMatchesPerFile">${rollbackHtml("fileContentSearchMatchesPerFile")}${appliedFlashHtml("fileContentSearchMatchesPerFile")}<span>Content matches per file</span><input type="number" min="1" max="50" step="1" value="${matchesPerFile}" onchange="HerdrMobile.setFileContentSearchMatchesPerFile(this.value)"></label><label data-settings-id="fileContentSearchMatchCase">${rollbackHtml("fileContentSearchMatchCase")}${appliedFlashHtml("fileContentSearchMatchCase")}<input type="checkbox" ${matchCase ? "checked" : ""} onchange="HerdrMobile.setFileContentSearchMatchCase(this.checked)"><span>Content search match case</span></label><label data-settings-id="fileContentSearchRegex">${rollbackHtml("fileContentSearchRegex")}${appliedFlashHtml("fileContentSearchRegex")}<input type="checkbox" ${regex ? "checked" : ""} onchange="HerdrMobile.setFileContentSearchRegex(this.checked)"><span>Content search regex</span></label></div>`;
    }

    function editorSection(enhanced, wordWrap, tabSize, lsp) {
      return `<div class="mobile-settings-group"><h3>Editor</h3><label data-settings-id="editorEnabled">${rollbackHtml("editorEnabled")}${appliedFlashHtml("editorEnabled")}<input type="checkbox" ${enhanced ? "checked" : ""} onchange="HerdrMobile.setEditorEnabled(this.checked)"><span>Code editor enhancements</span><small>Enable CodeMirror editing enhancements. Files remain editable when this is disabled.</small></label><label data-settings-id="editorWordWrap">${rollbackHtml("editorWordWrap")}${appliedFlashHtml("editorWordWrap")}<input type="checkbox" ${wordWrap ? "checked" : ""} onchange="HerdrMobile.setEditorWordWrap(this.checked)"><span>Editor word wrap</span></label><label data-settings-id="editorTabSize">${rollbackHtml("editorTabSize")}${appliedFlashHtml("editorTabSize")}<span>Editor tab size</span><input type="number" min="1" max="8" step="1" value="${tabSize}" onchange="HerdrMobile.setEditorTabSize(this.value)"></label><label data-settings-id="lspEnabled">${rollbackHtml("lspEnabled")}${appliedFlashHtml("lspEnabled")}<input type="checkbox" ${lsp ? "checked" : ""} onchange="HerdrMobile.setLspEnabled(this.checked)"><span>LSP diagnostics</span><small>Show language server diagnostics under the editor. Off by default.</small></label></div>`;
    }

    function renderSearchSectionOrder(value, flashKey) {
      const labels = { workspaces: "Workspaces", files: "Files", content: "Content" };
      const order = normalizeSearchSectionOrder(value);
      return `<div class="mobile-actions mobile-search-order">${order.map((key, index) => {
        const enabled = searchSectionEnabled(key);
        return `<span class="mobile-btn mobile-search-order-row">${flashKey === key ? `<span class="settings-applied" aria-live="polite" data-state="settings-applied-ok">✓ Applied</span>` : ""}<strong>${escapeHtml(labels[key] || key)}</strong><button class="mobile-btn" ${index === 0 ? "disabled" : ""} onclick="HerdrMobile.moveSearchSection('${key}',-1)">↑</button><button class="mobile-btn ${enabled ? "active" : ""}" onclick="HerdrMobile.toggleSearchSection('${key}')">${enabled ? "Shown" : "Hidden"}</button><button class="mobile-btn" ${index === order.length - 1 ? "disabled" : ""} onclick="HerdrMobile.moveSearchSection('${key}',1)">↓</button></span>`;
      }).join("")}</div>`;
    }

    function workspacesSection(worktreeDirectory, explorationDirectory) {
      return `<div class="mobile-settings-group"><h3>Workspaces</h3><label data-settings-id="worktreeDefaultDirectory">${rollbackHtml("worktreeDefaultDirectory")}${appliedFlashHtml("worktreeDefaultDirectory")}<span>Worktree default directory</span><input placeholder="../worktrees" value="${escapeHtml(worktreeDirectory)}" onchange="HerdrMobile.setWorktreeDefaultDirectory(this.value)"></label><small>Base for generated worktree checkout paths.</small><label data-settings-id="explorationDefaultDirectory">${rollbackHtml("explorationDefaultDirectory")}${appliedFlashHtml("explorationDefaultDirectory")}<span>Exploration default directory</span><input placeholder="~/Documents/code" value="${escapeHtml(explorationDirectory)}" onchange="HerdrMobile.setExplorationDefaultDirectory(this.value)"></label><small>Prefills worktree discovery paths.</small></div>`;
    }

    function alertsSection(notifications, volume, soundScope) {
      return `<div class="mobile-settings-group"><h3>Alerts</h3><label data-settings-id="browserNotifications">${rollbackHtml("browserNotifications")}${appliedFlashHtml("browserNotifications")}<input type="checkbox" ${notifications ? "checked" : ""} onchange="HerdrMobile.setBrowserNotifications(this.checked)"><span>Browser notifications</span><small>Show system notifications when an agent is blocked or done.</small></label><label data-settings-id="notificationVolume">${rollbackHtml("notificationVolume")}${appliedFlashHtml("notificationVolume")}<span>Notification volume (${volume}%)</span><input type="range" min="0" max="100" step="1" value="${volume}" onchange="HerdrMobile.setNotificationVolume(this.value)"></label><label data-settings-id="soundScope">${rollbackHtml("soundScope")}${appliedFlashHtml("soundScope")}<span>Notification scope</span><select onchange="HerdrMobile.setSoundScope(this.value)"><option value="current" ${soundScope !== "all" ? "selected" : ""}>Current agent tab</option><option value="all" ${soundScope === "all" ? "selected" : ""}>All tabs</option></select><small>Play the attention tone in every open tab or only in the tab viewing the agent.</small></label><small>Controls the local attention tone volume.</small></div>`;
    }

    function agentsSection(agentSortMode, stuckWorking, dismissMinutes) {
      return `<div class="mobile-settings-group"><h3>Agents</h3><label data-settings-id="agentSortMode">${rollbackHtml("agentSortMode")}${appliedFlashHtml("agentSortMode")}<span>Agent sorting</span><select onchange="HerdrMobile.setAgentSortMode(this.value)"><option value="off" ${agentSortMode !== "attention" && agentSortMode !== "attention_inverted" ? "selected" : ""}>Attention rank (blocked first)</option><option value="attention" ${agentSortMode === "attention" ? "selected" : ""}>Custom group order</option><option value="attention_inverted" ${agentSortMode === "attention_inverted" ? "selected" : ""}>Working-first preset</option></select><small>Blocked and done agents always float up; custom order follows the desktop agent group order.</small></label><label data-settings-id="stuckWorkingEnabled">${rollbackHtml("stuckWorkingEnabled")}${appliedFlashHtml("stuckWorkingEnabled")}<input type="checkbox" ${stuckWorking ? "checked" : ""} onchange="HerdrMobile.setStuckWorkingEnabled(this.checked)"><span>Ignore stuck working agents</span><small>Dismiss working agents that appear stuck. Clears automatically on status changes.</small></label><label data-settings-id="workingDismissMinutes">${rollbackHtml("workingDismissMinutes")}${appliedFlashHtml("workingDismissMinutes")}<span>Ignore stuck working for (minutes)</span><input type="number" min="1" max="1440" step="1" value="${dismissMinutes}" onchange="HerdrMobile.setWorkingDismissMinutes(this.value)"></label></div>`;
    }

    function energySection(noSleepMode, noSleepError, noSleepUnsupported) {
      const mode = noSleepMode || "off";
      const note = noSleepUnsupported
        ? `<div class="mobile-error">${escapeHtml(noSleepError || "No-sleep mode is not supported on this host")}</div>`
        : noSleepError
          ? `<div class="mobile-error">${escapeHtml(noSleepError)}</div>`
          : "";
      return `<div class="mobile-settings-group"><h3>Energy</h3><label data-settings-id="noSleepMode"><span>No-sleep mode</span><select onchange="HerdrMobile.setNoSleepMode(this.value)" ${noSleepUnsupported ? "disabled" : ""}><option value="off" ${mode === "off" ? "selected" : ""}>Off</option><option value="auto" ${mode === "auto" ? "selected" : ""}>Auto</option><option value="1h" ${mode === "1h" ? "selected" : ""}>1 hour</option><option value="2h" ${mode === "2h" ? "selected" : ""}>2 hours</option><option value="4h" ${mode === "4h" ? "selected" : ""}>4 hours</option><option value="infinite" ${mode === "infinite" ? "selected" : ""}>Infinite</option></select><small>Prevent computer sleep from the WebUI server. Auto keeps the host awake while agents work.</small></label>${note}</div>`;
    }

    function terminalSection(font, core, links, mouseReporting) {
      return `<div class="mobile-settings-group"><h3>Terminal</h3><label data-settings-id="terminalCore">${rollbackHtml("terminalCore")}${appliedFlashHtml("terminalCore")}<span>Terminal renderer</span><select onchange="HerdrMobile.setTerminalCore(this.value)"><option value="wterm" ${core === "wterm" ? "selected" : ""}>wterm VT core</option><option value="ghostty" ${core === "ghostty" ? "selected" : ""}>Ghostty VT core</option></select></label><label data-settings-id="terminalFontFamily">${rollbackHtml("terminalFontFamily")}${appliedFlashHtml("terminalFontFamily")}<span>Terminal font</span><input placeholder="JetBrainsMono Nerd Font, monospace" value="${escapeHtml(font)}" onchange="HerdrMobile.setTerminalFontFamily(this.value)"></label><label data-settings-id="terminalLinks">${rollbackHtml("terminalLinks")}${appliedFlashHtml("terminalLinks")}<input type="checkbox" ${links ? "checked" : ""} onchange="HerdrMobile.setTerminalLinks(this.checked)"><span>Terminal links</span><small>Detect http/https URLs and open them when tapped.</small></label><label data-settings-id="terminalMouseReporting">${rollbackHtml("terminalMouseReporting")}${appliedFlashHtml("terminalMouseReporting")}<input type="checkbox" ${mouseReporting ? "checked" : ""} onchange="HerdrMobile.setTerminalMouseReporting(this.checked)"><span>Terminal mouse reporting</span><small>Forward mouse input to terminal apps. Disabled by default; scrolling still works.</small></label><small>Add a Nerd Font family name so icon glyphs render. Leave blank for the default stack.</small></div>`;
    }

    function dataSection() {
      return `<div class="mobile-settings-group"><h3>Data</h3><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.refresh()">Refresh data</button><button class="mobile-btn mobile-wide" onclick="location.reload()">Reload selected layout</button></div>`;
    }

    function readOptions() {
      try {
        return globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
      } catch (_) {
        return {};
      }
    }

    function writeOptions(options) {
      if (globalThis.HerdrOptions) globalThis.HerdrOptions.write(options || {});
      else localStorage.setItem("herdr-web-options", JSON.stringify(options || {}));
    }

    function browserNotificationsEnabled() {
      return readOptions().browserNotifications === true;
    }

    function setThemeMode(value) {
      localStorage.setItem("herdr-web-theme", value);
      applyTheme();
      queueAppliedFlash("theme");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setSettingsFilter(value) {
      settingsFilter = String(value || "");
      const needle = settingsFilter.trim().toLowerCase();
      let anyVisible = false;
      document.querySelectorAll(".mobile-settings-disclosure").forEach((node) => {
        const visible = !needle || String(node.dataset.settingsText || "").includes(needle);
        node.hidden = !visible;
        if (visible) {
          anyVisible = true;
          if (needle) node.open = true;
        }
      });
      const empty = document.getElementById("mobileSettingsEmpty");
      if (empty) empty.hidden = anyVisible;
    }

    function setLayoutPreference(value) {
      localStorage.setItem("herdr-web-layout", value);
      queueAppliedFlash("layout");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setEditorEnabled(value) { setBooleanOption("editorEnabled", value); }
    function setEditorWordWrap(value) { setBooleanOption("editorWordWrap", value); }

    function setEditorTabSize(value) {
      const parsed = readOptions();
      parsed.editorTabSize = Math.max(1, Math.min(8, Number(value) || 2));
      writeOptions(parsed);
      queueAppliedFlash("editorTabSize");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setLspEnabled(value) { setBooleanOption("lspEnabled", value); }

    function terminalFontValue() {
      return readOptions().terminalFontFamily || "";
    }

    function terminalCoreValue() {
      return readOptions().terminalCore === "ghostty" ? "ghostty" : "wterm";
    }

    function fileBrowserDepthValue() {
      const value = Number(readOptions().fileBrowserDepth);
      return Math.max(0, Math.min(8, Number.isFinite(value) ? value : 3));
    }

    function fileBrowserLineNumbersEnabled() {
      return readOptions().fileBrowserLineNumbers !== false;
    }

    // Editor options mirror the desktop settings (IDE-review B4).
    function editorEnhancedEnabled() {
      return readOptions().editorEnabled !== false;
    }

    function editorWordWrapEnabled() {
      return readOptions().editorEnabled !== false && readOptions().editorWordWrap !== false;
    }

    function editorTabSizeValue() {
      const value = Number(readOptions().editorTabSize);
      return Math.max(1, Math.min(8, Number.isFinite(value) ? value : 2));
    }

    function lspEnabled() {
      return readOptions().lspEnabled === true;
    }

    function headerSearchEnabled() { return readOptions().headerSearchEnabled !== false; }
    function searchSectionOptionKey(key) {
      return { workspaces: "searchWorkspacesEnabled", files: "searchFilesEnabled", content: "searchContentEnabled" }[key] || "";
    }
    function searchSectionEnabled(key) {
      const optionKey = searchSectionOptionKey(key);
      return !optionKey || readOptions()[optionKey] !== false;
    }
    function normalizeSearchSectionOrder(value) {
      return normalizeOrder(value, ["workspaces", "files", "content"]);
    }
    function searchSectionOrderValue() { return normalizeSearchSectionOrder(readOptions().searchSectionOrder || "workspaces,files,content").join(","); }

    function fileBrowserSearchPageSizeValue() {
      const value = Number(readOptions().fileBrowserSearchPageSize);
      return Math.max(10, Math.min(500, Number.isFinite(value) ? value : 100));
    }

    function contentSearchMinCharsValue() {
      const value = Number(readOptions().fileContentSearchMinChars);
      return Math.max(1, Math.min(20, Number.isFinite(value) ? value : 3));
    }

    function contentSearchPageSizeValue() {
      const value = Number(readOptions().fileContentSearchPageSize);
      return Math.max(10, Math.min(500, Number.isFinite(value) ? value : 50));
    }

    function contentSearchContextLinesValue() {
      const value = Number(readOptions().fileContentSearchContextLines);
      return Math.max(0, Math.min(20, Number.isFinite(value) ? value : 2));
    }

    function contentSearchAutoCollapseFilesValue() {
      const value = Number(readOptions().fileContentSearchAutoCollapseFiles);
      return Math.max(0, Math.min(200, Number.isFinite(value) ? value : 0));
    }

    function contentSearchDefaultExpandedValue() {
      return readOptions().fileContentSearchDefaultExpanded !== false;
    }

    function contentSearchMatchesPerFileValue() {
      const value = Number(readOptions().fileContentSearchMatchesPerFile);
      return Math.max(1, Math.min(50, Number.isFinite(value) ? value : 5));
    }

    function contentSearchMatchCaseValue() {
      return readOptions().fileContentSearchMatchCase === true;
    }

    function contentSearchRegexValue() {
      return readOptions().fileContentSearchRegex === true;
    }

    function worktreeDefaultDirectoryValue() {
      return String(readOptions().worktreeDefaultDirectory || "").trim();
    }

    function explorationDefaultDirectoryValue() {
      return String(readOptions().explorationDefaultDirectory || "").trim();
    }

    function notificationVolumeValue() {
      const value = Number(readOptions().notificationVolume);
      const volume = Number.isFinite(value) ? value : 0.24;
      return Math.round(Math.max(0, Math.min(1, volume)) * 100);
    }

    function terminalLinksEnabled() {
      return readOptions().terminalLinks !== false;
    }

    function terminalMouseReportingEnabled() {
      return readOptions().terminalMouseReporting === true;
    }

    function setWorktreeDefaultDirectory(value) {
      const parsed = readOptions();
      parsed.worktreeDefaultDirectory = String(value || "").trim();
      writeOptions(parsed);
      queueAppliedFlash("worktreeDefaultDirectory");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setExplorationDefaultDirectory(value) {
      const parsed = readOptions();
      parsed.explorationDefaultDirectory = String(value || "").trim();
      writeOptions(parsed);
      queueAppliedFlash("explorationDefaultDirectory");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setNotificationVolume(value) {
      const parsed = readOptions();
      parsed.notificationVolume = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
      writeOptions(parsed);
      queueAppliedFlash("notificationVolume");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setSoundScope(value) {
      const parsed = readOptions();
      parsed.soundScope = value === "all" ? "all" : "current";
      writeOptions(parsed);
      queueAppliedFlash("soundScope");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setAgentSortMode(value) {
      const parsed = readOptions();
      parsed.agentSortMode = ["off", "attention", "attention_inverted"].includes(value)
        ? value
        : "off";
      writeOptions(parsed);
      queueAppliedFlash("agentSortMode");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setStuckWorkingEnabled(value) {
      const parsed = readOptions();
      parsed.stuckWorkingEnabled = !!value;
      writeOptions(parsed);
      queueAppliedFlash("stuckWorkingEnabled");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setWorkingDismissMinutes(value) {
      const parsed = readOptions();
      parsed.workingDismissMinutes = Math.max(
        1,
        Math.min(1440, Number(value) || 30),
      );
      writeOptions(parsed);
      queueAppliedFlash("workingDismissMinutes");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function workingDismissMinutesValue() {
      return Math.max(1, Math.min(1440, Number(readOptions().workingDismissMinutes) || 30));
    }

    async function setNoSleepMode(value) {
      const mode = ["off", "auto", "1h", "2h", "4h", "infinite"].includes(value)
        ? value
        : "off";
      try {
        state.noSleep = await api("/api/no-sleep", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
      } catch (error) {
        state.noSleep = { mode: "off", error: (error && error.message) || String(error), supported: true };
      }
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    async function loadNoSleep() {
      try {
        state.noSleep = await api("/api/no-sleep");
      } catch (_) {
        state.noSleep = { mode: "off", error: null, supported: true };
      }
      return state.noSleep;
    }

    function setFileBrowserDepth(value) {
      const parsed = readOptions();
      parsed.fileBrowserDepth = Math.max(0, Math.min(8, Number(value) || 0));
      writeOptions(parsed);
      queueAppliedFlash("fileBrowserDepth");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserLineNumbers(value) {
      const parsed = readOptions();
      parsed.fileBrowserLineNumbers = !!value;
      writeOptions(parsed);
      queueAppliedFlash("fileBrowserLineNumbers");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setHeaderSearchEnabled(value) {
      const parsed = readOptions();
      parsed.headerSearchEnabled = !!value;
      writeOptions(parsed);
      queueAppliedFlash("headerSearchEnabled");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setBooleanOption(key, value) {
      const parsed = readOptions();
      parsed[key] = !!value;
      writeOptions(parsed);
      queueAppliedFlash(key);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setSearchSectionOrder(value) {
      const parsed = readOptions();
      parsed.searchSectionOrder = normalizeSearchSectionOrder(value).join(",");
      writeOptions(parsed);
      queueAppliedFlash("searchSectionOrder");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function toggleSearchSection(key) {
      const parsed = readOptions();
      const optionKey = searchSectionOptionKey(String(key || ""));
      if (!optionKey) return;
      parsed[optionKey] = parsed[optionKey] === false;
      writeOptions(parsed);
      pendingSearchOrderFlash = String(key);
      queueAppliedFlash("searchSectionOrder");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function moveSearchSection(key, delta) {
      const parsed = readOptions();
      const order = normalizeSearchSectionOrder(parsed.searchSectionOrder);
      const index = order.indexOf(String(key || ""));
      const nextIndex = index + Number(delta || 0);
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
      [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
      parsed.searchSectionOrder = order.join(",");
      writeOptions(parsed);
      pendingSearchOrderFlash = String(key);
      queueAppliedFlash("searchSectionOrder");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserSearchPageSize(value) {
      const parsed = readOptions();
      parsed.fileBrowserSearchPageSize = Math.max(10, Math.min(500, Number(value) || 100));
      writeOptions(parsed);
      queueAppliedFlash("fileBrowserSearchPageSize");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchMinChars(value) {
      const parsed = readOptions();
      parsed.fileContentSearchMinChars = Math.max(1, Math.min(20, Number(value) || 3));
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchMinChars");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchPageSize(value) {
      const parsed = readOptions();
      parsed.fileContentSearchPageSize = Math.max(10, Math.min(500, Number(value) || 50));
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchPageSize");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchContextLines(value) {
      const parsed = readOptions();
      const parsedValue = Number(value);
      parsed.fileContentSearchContextLines = Math.max(0, Math.min(20, Number.isFinite(parsedValue) ? parsedValue : 2));
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchContextLines");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchAutoCollapseFiles(value) {
      const parsed = readOptions();
      const parsedValue = Number(value);
      parsed.fileContentSearchAutoCollapseFiles = Math.max(0, Math.min(200, Number.isFinite(parsedValue) ? parsedValue : 0));
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchAutoCollapseFiles");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchDefaultExpanded(value) {
      const parsed = readOptions();
      parsed.fileContentSearchDefaultExpanded = !!value;
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchDefaultExpanded");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchMatchesPerFile(value) {
      const parsed = readOptions();
      parsed.fileContentSearchMatchesPerFile = Math.max(1, Math.min(50, Number(value) || 5));
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchMatchesPerFile");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchMatchCase(value) {
      const parsed = readOptions();
      parsed.fileContentSearchMatchCase = !!value;
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchMatchCase");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchRegex(value) {
      const parsed = readOptions();
      parsed.fileContentSearchRegex = !!value;
      writeOptions(parsed);
      queueAppliedFlash("fileContentSearchRegex");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setTerminalFontFamily(value) {
      try {
        const parsed = readOptions();
        parsed.terminalFontFamily = String(value || "").trim();
        writeOptions(parsed);
        queueAppliedFlash("terminalFontFamily");
      } catch (_) {}
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.applyTerminalFontFamily)
        globalThis.HerdrMobile.applyTerminalFontFamily();
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setTerminalCore(value) {
      const parsed = readOptions();
      parsed.terminalCore = value === "ghostty" ? "ghostty" : "wterm";
      writeOptions(parsed);
      queueAppliedFlash("terminalCore");
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.reloadTerminal)
        globalThis.HerdrMobile.reloadTerminal();
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setTerminalLinks(value) {
      const parsed = readOptions();
      parsed.terminalLinks = !!value;
      writeOptions(parsed);
      queueAppliedFlash("terminalLinks");
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.applyTerminalLinks)
        globalThis.HerdrMobile.applyTerminalLinks();
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setTerminalMouseReporting(value) {
      const parsed = readOptions();
      parsed.terminalMouseReporting = !!value;
      writeOptions(parsed);
      queueAppliedFlash("terminalMouseReporting");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
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
      queueAppliedFlash("browserNotifications", enabled ? "Applied" : "Denied");
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    return {
      render,
      rollbackSetting,
      resetSettingBaselines,
      setBrowserNotifications,
      setExplorationDefaultDirectory,
      loadNoSleep,
      setNoSleepMode,
      setAgentSortMode,
      setSoundScope,
      setStuckWorkingEnabled,
      setWorkingDismissMinutes,
      setFileBrowserDepth,
      setFileBrowserLineNumbers,
      setFileBrowserSearchPageSize,
      setHeaderSearchEnabled,
      setSearchWorkspacesEnabled(value) { setBooleanOption("searchWorkspacesEnabled", value); },
      setSearchFilesEnabled(value) { setBooleanOption("searchFilesEnabled", value); },
      setSearchFoldersEnabled(value) { setBooleanOption("searchFoldersEnabled", value); },
      setSearchContentEnabled(value) { setBooleanOption("searchContentEnabled", value); },
      moveSearchSection,
      setSearchSectionOrder,
      setSettingsFilter,
      toggleSearchSection,
      setFileContentSearchMinChars,
      setFileContentSearchPageSize,
      setFileContentSearchAutoCollapseFiles,
      setFileContentSearchDefaultExpanded,
      setFileContentSearchContextLines,
      setFileContentSearchMatchesPerFile,
      setFileContentSearchMatchCase,
      setFileContentSearchRegex,
      setLayoutPreference,
      setEditorEnabled,
      setEditorWordWrap,
      setEditorTabSize,
      setLspEnabled,
      setNotificationVolume,
      setTerminalFontFamily,
      setTerminalCore,
      setTerminalLinks,
      setTerminalMouseReporting,
      setThemeMode,
      setWorktreeDefaultDirectory,
    };
  }

  globalThis.HerdrMobileSettings = { create: createMobileSettings };
})();
