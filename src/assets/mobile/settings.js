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
      const lineNumbers = fileBrowserLineNumbersEnabled();
      const headerSearch = headerSearchEnabled();
      const searchOrder = searchSectionOrderValue();
      const pathSearch = fileBrowserPathSearchEnabled();
      const pathSearchPageSize = fileBrowserSearchPageSizeValue();
      const minChars = contentSearchMinCharsValue();
      const contentPageSize = contentSearchPageSizeValue();
      const contextLines = contentSearchContextLinesValue();
      const autoCollapse = contentSearchAutoCollapseFilesValue();
      const defaultExpanded = contentSearchDefaultExpandedValue();
      const matchesPerFile = contentSearchMatchesPerFileValue();
      const worktreeDirectory = worktreeDefaultDirectoryValue();
      const explorationDirectory = explorationDefaultDirectoryValue();
      const volume = notificationVolumeValue();
      const links = terminalLinksEnabled();
      return `<section class="mobile-section mobile-form"><h2>Settings</h2>${appearanceSection(theme)}${layoutSection(layout)}${filesSection(depth, lineNumbers, headerSearch, searchOrder, pathSearch, pathSearchPageSize, minChars, contentPageSize, contextLines, autoCollapse, defaultExpanded, matchesPerFile)}${workspacesSection(worktreeDirectory, explorationDirectory)}${alertsSection(notifications, volume)}${terminalSection(font, links)}${dataSection()}${state.error ? `<div class="mobile-error">${escapeHtml(state.error)}</div>` : ""}</section>`;
    }

    function appearanceSection(theme) {
      return `<div class="mobile-settings-group"><h3>Appearance</h3><label><span>Theme</span><select onchange="HerdrMobile.setThemeMode(this.value)"><option value="auto" ${theme === "auto" ? "selected" : ""}>Auto</option><option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${theme === "light" ? "selected" : ""}>Light</option></select></label></div>`;
    }

    function layoutSection(layout) {
      return `<div class="mobile-settings-group"><h3>Layout</h3><label><span>Layout mode</span><select onchange="HerdrMobile.setLayoutPreference(this.value)"><option value="auto" ${layout === "auto" ? "selected" : ""}>Auto</option><option value="mobile" ${layout === "mobile" ? "selected" : ""}>Mobile</option><option value="desktop" ${layout === "desktop" ? "selected" : ""}>Desktop</option></select><small>Auto uses viewport width, not user agent.</small></label></div>`;
    }

    function filesSection(depth, lineNumbers, headerSearch, searchOrder, pathSearch, pathSearchPageSize, minChars, contentPageSize, contextLines, autoCollapse, defaultExpanded, matchesPerFile) {
      return `<div class="mobile-settings-group"><h3>Files and search</h3><label><span>Browser depth</span><input type="number" min="0" max="8" step="1" value="${depth}" onchange="HerdrMobile.setFileBrowserDepth(this.value)"></label><small>0 shows current folder only. 3 expands three folder levels.</small><label><input type="checkbox" ${lineNumbers ? "checked" : ""} onchange="HerdrMobile.setFileBrowserLineNumbers(this.checked)"><span>Line numbers</span><small>Show line numbers when previewing text files.</small></label><label><input type="checkbox" ${headerSearch ? "checked" : ""} onchange="HerdrMobile.setHeaderSearchEnabled(this.checked)"><span>Header search button</span><small>Show the search action and allow the palette to open.</small></label><div><span>Search section order</span>${renderSearchSectionOrder(searchOrder)}</div><small>Use arrows to move sections. Use Shown/Hidden to include or remove a section.</small><label><input type="checkbox" ${pathSearch ? "checked" : ""} onchange="HerdrMobile.setFileBrowserPathSearch(this.checked)"><span>File/folder backend search</span><small>Enable backend path search for the search file and folder sections.</small></label><label><span>File/folder page size</span><input type="number" min="10" max="500" step="10" value="${pathSearchPageSize}" onchange="HerdrMobile.setFileBrowserSearchPageSize(this.value)"></label><label><span>Content minimum characters</span><input type="number" min="1" max="20" step="1" value="${minChars}" onchange="HerdrMobile.setFileContentSearchMinChars(this.value)"></label><label><span>Content page size</span><input type="number" min="10" max="500" step="10" value="${contentPageSize}" onchange="HerdrMobile.setFileContentSearchPageSize(this.value)"></label><label><span>Content context lines</span><input type="number" min="0" max="20" step="1" value="${contextLines}" onchange="HerdrMobile.setFileContentSearchContextLines(this.value)"></label><label><span>Content auto-collapse files</span><input type="number" min="0" max="200" step="1" value="${autoCollapse}" onchange="HerdrMobile.setFileContentSearchAutoCollapseFiles(this.value)"></label><label><input type="checkbox" ${defaultExpanded ? "checked" : ""} onchange="HerdrMobile.setFileContentSearchDefaultExpanded(this.checked)"><span>Content results expanded by default</span><small>Expand each file group when content results load.</small></label><label><span>Content matches per file</span><input type="number" min="1" max="50" step="1" value="${matchesPerFile}" onchange="HerdrMobile.setFileContentSearchMatchesPerFile(this.value)"></label></div>`;
    }

    function renderSearchSectionOrder(value) {
      const labels = { workspaces: "Workspaces", files: "Files", content: "Content" };
      const order = normalizeSearchSectionOrder(value);
      return `<div class="mobile-actions mobile-search-order">${order.map((key, index) => {
        const enabled = searchSectionEnabled(key);
        return `<span class="mobile-btn mobile-search-order-row"><strong>${escapeHtml(labels[key] || key)}</strong><button class="mobile-btn" ${index === 0 ? "disabled" : ""} onclick="HerdrMobile.moveSearchSection('${key}',-1)">↑</button><button class="mobile-btn ${enabled ? "active" : ""}" onclick="HerdrMobile.toggleSearchSection('${key}')">${enabled ? "Shown" : "Hidden"}</button><button class="mobile-btn" ${index === order.length - 1 ? "disabled" : ""} onclick="HerdrMobile.moveSearchSection('${key}',1)">↓</button></span>`;
      }).join("")}</div>`;
    }

    function workspacesSection(worktreeDirectory, explorationDirectory) {
      return `<div class="mobile-settings-group"><h3>Workspaces</h3><label><span>Worktree default directory</span><input placeholder="../worktrees" value="${escapeHtml(worktreeDirectory)}" onchange="HerdrMobile.setWorktreeDefaultDirectory(this.value)"></label><small>Base for generated worktree checkout paths.</small><label><span>Exploration default directory</span><input placeholder="~/Documents/code" value="${escapeHtml(explorationDirectory)}" onchange="HerdrMobile.setExplorationDefaultDirectory(this.value)"></label><small>Prefills worktree discovery paths.</small></div>`;
    }

    function alertsSection(notifications, volume) {
      return `<div class="mobile-settings-group"><h3>Alerts</h3><label><input type="checkbox" ${notifications ? "checked" : ""} onchange="HerdrMobile.setBrowserNotifications(this.checked)"><span>Browser notifications</span><small>Show system notifications when an agent is blocked or done.</small></label><label><span>Notification volume (${volume}%)</span><input type="range" min="0" max="100" step="1" value="${volume}" onchange="HerdrMobile.setNotificationVolume(this.value)"></label><small>Controls the local attention tone volume.</small></div>`;
    }

    function terminalSection(font, links) {
      return `<div class="mobile-settings-group"><h3>Terminal</h3><label><span>Terminal font</span><input placeholder="JetBrainsMono Nerd Font, monospace" value="${escapeHtml(font)}" onchange="HerdrMobile.setTerminalFontFamily(this.value)"></label><label><input type="checkbox" ${links ? "checked" : ""} onchange="HerdrMobile.setTerminalLinks(this.checked)"><span>Terminal links</span><small>Detect http/https URLs and open them when tapped.</small></label><small>Add a Nerd Font family name so icon glyphs render. Leave blank for the default stack.</small></div>`;
    }

    function dataSection() {
      return `<div class="mobile-settings-group"><h3>Data</h3><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.refresh()">Refresh data</button><button class="mobile-btn mobile-wide" onclick="location.reload()">Reload selected layout</button></div>`;
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

    function fileBrowserLineNumbersEnabled() {
      return readOptions().fileBrowserLineNumbers !== false;
    }

    function fileBrowserPathSearchEnabled() {
      return readOptions().fileBrowserPathSearch !== false;
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
      const allowed = ["workspaces", "files", "content"];
      const seen = new Set();
      const order = [];
      for (const part of String(value || "").split(",")) {
        const key = part.trim().toLowerCase();
        if (allowed.includes(key) && !seen.has(key)) {
          seen.add(key);
          order.push(key);
        }
      }
      for (const key of allowed) if (!seen.has(key)) order.push(key);
      return order;
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

    function setWorktreeDefaultDirectory(value) {
      const parsed = readOptions();
      parsed.worktreeDefaultDirectory = String(value || "").trim();
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setExplorationDefaultDirectory(value) {
      const parsed = readOptions();
      parsed.explorationDefaultDirectory = String(value || "").trim();
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setNotificationVolume(value) {
      const parsed = readOptions();
      parsed.notificationVolume = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserDepth(value) {
      const parsed = readOptions();
      parsed.fileBrowserDepth = Math.max(0, Math.min(8, Number(value) || 0));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserLineNumbers(value) {
      const parsed = readOptions();
      parsed.fileBrowserLineNumbers = !!value;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserPathSearch(value) {
      const parsed = readOptions();
      parsed.fileBrowserPathSearch = !!value;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setHeaderSearchEnabled(value) {
      const parsed = readOptions();
      parsed.headerSearchEnabled = !!value;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setBooleanOption(key, value) {
      const parsed = readOptions();
      parsed[key] = !!value;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setSearchSectionOrder(value) {
      const parsed = readOptions();
      parsed.searchSectionOrder = normalizeSearchSectionOrder(value).join(",");
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function toggleSearchSection(key) {
      const parsed = readOptions();
      const optionKey = searchSectionOptionKey(String(key || ""));
      if (!optionKey) return;
      parsed[optionKey] = parsed[optionKey] === false;
      writeOptions(parsed);
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
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileBrowserSearchPageSize(value) {
      const parsed = readOptions();
      parsed.fileBrowserSearchPageSize = Math.max(10, Math.min(500, Number(value) || 100));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchMinChars(value) {
      const parsed = readOptions();
      parsed.fileContentSearchMinChars = Math.max(1, Math.min(20, Number(value) || 3));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchPageSize(value) {
      const parsed = readOptions();
      parsed.fileContentSearchPageSize = Math.max(10, Math.min(500, Number(value) || 50));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchContextLines(value) {
      const parsed = readOptions();
      const parsedValue = Number(value);
      parsed.fileContentSearchContextLines = Math.max(0, Math.min(20, Number.isFinite(parsedValue) ? parsedValue : 2));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchAutoCollapseFiles(value) {
      const parsed = readOptions();
      const parsedValue = Number(value);
      parsed.fileContentSearchAutoCollapseFiles = Math.max(0, Math.min(200, Number.isFinite(parsedValue) ? parsedValue : 0));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchDefaultExpanded(value) {
      const parsed = readOptions();
      parsed.fileContentSearchDefaultExpanded = !!value;
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setFileContentSearchMatchesPerFile(value) {
      const parsed = readOptions();
      parsed.fileContentSearchMatchesPerFile = Math.max(1, Math.min(50, Number(value) || 5));
      writeOptions(parsed);
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    function setTerminalFontFamily(value) {
      try {
        const parsed = readOptions();
        parsed.terminalFontFamily = String(value || "").trim();
        writeOptions(parsed);
      } catch (_) {}
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.applyTerminalFontFamily)
        globalThis.HerdrMobile.applyTerminalFontFamily();
    }

    function setTerminalLinks(value) {
      const parsed = readOptions();
      parsed.terminalLinks = !!value;
      writeOptions(parsed);
      if (globalThis.HerdrMobile && globalThis.HerdrMobile.applyTerminalLinks)
        globalThis.HerdrMobile.applyTerminalLinks();
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
      if (globalThis.HerdrMobile) globalThis.HerdrMobile.refresh();
    }

    return {
      render,
      setBrowserNotifications,
      setExplorationDefaultDirectory,
      setFileBrowserDepth,
      setFileBrowserLineNumbers,
      setFileBrowserPathSearch,
      setFileBrowserSearchPageSize,
      setHeaderSearchEnabled,
      setSearchWorkspacesEnabled(value) { setBooleanOption("searchWorkspacesEnabled", value); },
      setSearchFilesEnabled(value) { setBooleanOption("searchFilesEnabled", value); },
      setSearchFoldersEnabled(value) { setBooleanOption("searchFoldersEnabled", value); },
      setSearchContentEnabled(value) { setBooleanOption("searchContentEnabled", value); },
      moveSearchSection,
      setSearchSectionOrder,
      toggleSearchSection,
      setFileContentSearchMinChars,
      setFileContentSearchPageSize,
      setFileContentSearchAutoCollapseFiles,
      setFileContentSearchDefaultExpanded,
      setFileContentSearchContextLines,
      setFileContentSearchMatchesPerFile,
      setLayoutPreference,
      setNotificationVolume,
      setTerminalFontFamily,
      setTerminalLinks,
      setThemeMode,
      setWorktreeDefaultDirectory,
    };
  }

  globalThis.HerdrMobileSettings = { create: createMobileSettings };
})();
