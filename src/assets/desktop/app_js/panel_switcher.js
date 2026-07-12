function isDefaultPanelTitle(label) {
  const value = String(label || "").trim().toLowerCase();
  return !value || value === "shell" || value === "terminal" || /^tab\s+\d+$/.test(value);
}

function panelNumberLabel(tab, index, tabs = state.tabs || []) {
  const number = Number(tab && tab.number);
  if (Number.isFinite(number) && number > 0) return String(number);
  const fallbackIndex = Number.isFinite(index)
    ? index
    : tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id);
  return String((fallbackIndex >= 0 ? fallbackIndex : 0) + 1);
}

function panelVisibleLabel(tab, index, tabs = state.tabs || []) {
  const label = String((tab && tab.label) || "").trim();
  return isDefaultPanelTitle(label) ? panelNumberLabel(tab, index, tabs) : label;
}

function panelRenameInitialLabel(tab) {
  const label = String((tab && tab.label) || "").trim();
  return isDefaultPanelTitle(label) ? "" : label;
}

function panelTooltip(tab, index, tabs = state.tabs || []) {
  const visible = panelVisibleLabel(tab, index, tabs);
  const title = tabTitle(tab);
  return visible === title
    ? `Current panel: ${visible}. Double-click to rename.`
    : `Current panel: ${visible} · ${title}. Double-click to rename.`;
}

function renderPanelField() {
  if (!state.ws) return '<span class="panel-field-empty">No panel</span>';
  const tabs = state.tabs || [];
  const current = tabs.find((t) => t.tab_id === state.tab) || tabs[0] || null;
  const currentIndex = current ? tabs.findIndex((t) => t.tab_id === current.tab_id) : -1;
  const currentLabel = current ? panelVisibleLabel(current, currentIndex, tabs) : "No panel";
  const hasSwitcher = tabs.length > 1;
  if (current && state.editingTab === current.tab_id)
    return `<div class="panel-field"><input class="panel-label panel-rename-input tab-rename-input" value="${escapeAttr(state.editingTabValue)}" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitTabRename('${current.tab_id}')" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${current.tab_id}')"><button class="mini panel-add" title="New panel" onclick="event.preventDefault();event.stopPropagation();newTab()">+</button><button class="mini warn panel-close" title="Close current panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${current.tab_id}')">✕</button></div>`;
  const menu = hasSwitcher && state.panelMenuOpen
    ? `<div class="panel-menu">${tabs.map((tab, index) => `<button class="panel-menu-item${tab.tab_id === state.tab ? " active" : ""}" title="${escapeAttr(tabTitle(tab))}" onclick="event.preventDefault();event.stopPropagation();state.panelMenuOpen=false;go(state.ws,decodeURIComponent('${encodeURIComponent(tab.tab_id)}'))">${escapeHtml(panelVisibleLabel(tab, index, tabs))}</button>`).join("")}</div>`
    : "";
  const caret = hasSwitcher ? '<span class="panel-caret">▼</span>' : "";
  const click = hasSwitcher ? "togglePanelMenu()" : "";
  const close = current
    ? `<button class="mini warn panel-close" title="Close current panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${current.tab_id}')">✕</button>`
    : "";
  return `<div class="panel-field"><button class="panel-label" title="${escapeAttr(current ? panelTooltip(current, currentIndex, tabs) : "No panel")}" onclick="event.preventDefault();event.stopPropagation();${click}" ondblclick="event.preventDefault();event.stopPropagation();state.panelMenuOpen=false;${current ? `startTabRename('${current.tab_id}','${escapeAttr(panelRenameInitialLabel(current))}')` : ""}"><span>${escapeHtml(currentLabel)}</span>${caret}</button>${menu}<button class="mini panel-add" title="New panel" onclick="event.preventDefault();event.stopPropagation();newTab()">+</button>${close}</div>`;
}

function togglePanelMenu() {
  state.panelMenuOpen = !state.panelMenuOpen;
  render();
}
