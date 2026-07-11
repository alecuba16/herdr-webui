(function () {
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function arg(value) {
    return encodeURIComponent(String(value == null ? "" : value)).replace(/'/g, "%27");
  }

  function basename(path) {
    const parts = String(path || "").replace(/\/+$/, "").split("/").filter(Boolean);
    return parts[parts.length - 1] || String(path || "");
  }

  function icon(kind, pathOrName) {
    if (kind === "open" || kind === "closed" || kind === "up") {
      const safe = kind === "open" ? "chevron-down" : kind === "closed" ? "chevron-right" : "folder-up";
      return `<span class="herdr-tree-icon herdr-tree-icon-${safe}" aria-hidden="true"></span>`;
    }
    if (kind === "dir") {
      const icons = window.HerdrFileIcons;
      const folderType = icons && icons.folderType ? icons.folderType(pathOrName) : "";
      const extra = folderType ? ` herdr-tree-icon-folder-${folderType}` : "";
      return `<span class="herdr-tree-icon herdr-tree-icon-folder${extra}" aria-hidden="true"></span>`;
    }
    const icons = window.HerdrFileIcons;
    const fileType = icons && icons.fileType ? icons.fileType(pathOrName) : null;
    if (fileType) return `<span class="herdr-tree-icon herdr-tree-icon-filetype herdr-tree-icon-filetype-${fileType.type}" data-glyph="${esc(fileType.glyph)}" aria-hidden="true"></span>`;
    return `<span class="herdr-tree-icon herdr-tree-icon-file" aria-hidden="true"></span>`;
  }

  function indentStyle(level, opts) {
    const value = Number(level || 0) * ((opts && opts.indentPx) || treeIndentPx());
    return `--tree-offset:${Math.max(0, Math.round(value))}px`;
  }

  function treeIndentPx() {
    try {
      const raw = getComputedStyle(document.body).getPropertyValue("--herdr-tree-indent");
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value)) return Math.max(0, Math.min(40, value));
    } catch (_) {}
    return 14;
  }

  function statusBadge(_status) {
    return "";
  }

  function highlight(value, term) {
    const text = String(value || "");
    const needle = String(term || "").trim();
    if (!needle) return esc(text);
    const index = text.toLowerCase().indexOf(needle.toLowerCase());
    if (index < 0) return esc(text);
    return `${esc(text.slice(0, index))}<mark class="herdr-tree-hit">${esc(text.slice(index, index + needle.length))}</mark>${esc(text.slice(index + needle.length))}`;
  }

  function renderEntries(entries, options) {
    const opts = Object.assign({ indentPx: treeIndentPx() }, options || {});
    const selected = opts.selectedPath || "";
    const callback = opts.callback || "HerdrFileTree";
    return `<div class="herdr-file-tree" role="tree">${(entries || [])
      .map((entry) => renderEntry(entry, selected, callback, opts))
      .join("")}</div>`;
  }

  function renderPathTree(files, options) {
    const opts = Object.assign({ indentPx: treeIndentPx() }, options || {});
    const root = { dirs: new Map(), files: [] };
    for (const file of files || []) {
      const parts = String(file).split("/").filter(Boolean);
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts[parts.length - 1] || file, path: file });
    }
    return renderPathNode(root, "", opts, 0);
  }

  function renderPathNode(node, path, opts, level) {
    const callback = opts.callback || "HerdrFileTree";
    const kindArg = opts.kind == null ? "" : `,'${esc(opts.kind)}'`;
    const entries = [
      ...Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([dir, child]) => ({ type: "dir", name: dir, child })),
      ...node.files.sort((a, b) => a.name.localeCompare(b.name)).map((file) => ({ type: "file", name: file.name, path: file.path })),
    ];
    return entries.map((entry) => {
      if (entry.type === "dir") {
        const compact = compactDirChain(entry, path, opts);
        const dirPath = compact.path;
        const collapsed = !!((opts.collapsedDirs || {})[dirPath]);
        const keydown = opts.activateMethod ? ` onkeydown="${callback}.${opts.activateMethod}(event)"` : "";
        const dirClass = opts.dirClass ? ` ${opts.dirClass}` : "";
        const name = renderCompactDirName(compact.parts, opts, callback);
        return `<div class="herdr-tree-row dir${dirClass}" role="treeitem" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}" style="${indentStyle(level, opts)}" onclick="${callback}.${opts.toggleMethod || "toggle"}('${arg(dirPath)}')"${keydown}><span class="herdr-tree-caret">${icon(collapsed ? "closed" : "open")}</span><span class="herdr-tree-kind">${icon("dir", dirPath)}</span><span class="herdr-tree-name">${name}</span></div>${collapsed ? "" : renderPathNode(compact.child, dirPath, opts, level + 1)}`;
      }
      const selected = opts.selectedPath === entry.path && (!opts.selectedKind || opts.selectedKind === opts.kind);
      const meta = typeof opts.metaForPath === "function" ? opts.metaForPath(entry.path, opts.kind) : "";
      const status = typeof opts.statusForPath === "function" ? opts.statusForPath(entry.path, opts.kind) : opts.status;
      const keydown = opts.activateMethod ? ` onkeydown="${callback}.${opts.activateMethod}(event)"` : "";
      const context = opts.contextMethod ? ` oncontextmenu="return ${callback}.${opts.contextMethod}(event,'${arg(entry.path)}'${kindArg})"` : "";
      const data = opts.dataPrefix ? ` data-${opts.dataPrefix}-path="${esc(entry.path)}" data-${opts.dataPrefix}-kind="${esc(opts.kind || "")}"` : "";
      const rowClass = opts.rowClass ? ` ${opts.rowClass}` : "";
      return `<div class="herdr-tree-row file${rowClass}${selected ? " active" : ""}${status ? ` git-${status}` : ""}" role="treeitem" tabindex="0"${data} style="${indentStyle(level, opts)}" title="${esc(entry.path)}" onclick="${callback}.${opts.selectMethod || "select"}('${arg(entry.path)}'${kindArg})"${keydown}${context}><span class="herdr-tree-caret"></span><span class="herdr-tree-kind">${icon("file", entry.path || entry.name)}</span><span class="herdr-tree-name">${highlight(entry.name, opts.filterTerm)}</span>${statusBadge(status)}${meta}</div>`;
    }).join("");
  }

  function compactDirChain(entry, parentPath, opts) {
    const parts = [];
    let name = entry.name;
    let child = entry.child;
    let path = parentPath ? `${parentPath}/${name}` : name;
    parts.push({ name, path });
    while (opts.compactSingleChildDirs !== false && !((opts.expandedCompactDirs || {})[path]) && child && child.files && child.files.length === 0 && child.dirs && child.dirs.size === 1) {
      const next = Array.from(child.dirs.entries())[0];
      name = next[0];
      child = next[1];
      path = `${path}/${name}`;
      parts.push({ name, path });
    }
    return { parts, path, child };
  }

  function renderCompactDirName(parts, opts, callback) {
    if (!parts || parts.length <= 1 || !opts.expandCompactMethod) return esc((parts && parts[0] && parts[0].name) || "");
    return parts.map((part, index) => `<button type="button" class="herdr-tree-crumb" onclick="event.stopPropagation();${callback}.${opts.expandCompactMethod}('${arg(part.path)}')">${esc(part.name)}</button>${index < parts.length - 1 ? '<span class="herdr-tree-sep">/</span>' : ""}`).join("");
  }

  function renderEntry(entry, selected, callback, opts) {
    const kind = entry.kind === "dir" || entry.kind === "up" ? "dir" : "file";
    const path = entry.path || entry.name || "";
    const level = Number(entry.level || 0);
    const active = selected === path ? " active" : "";
    const expanded = !!entry.expanded;
    const toggleMethod = opts.toggleMethod || "toggle";
    const selectMethod = opts.selectMethod || "select";
    const dirClickMethod = opts.dirClickMethod === "none" ? "" : opts.dirClickMethod || toggleMethod;
    const dbl = kind === "dir" && entry.kind !== "up" && opts.dirDoubleClickMethod ? ` ondblclick="event.preventDefault();event.stopPropagation();${callback}.${opts.dirDoubleClickMethod}('${arg(path)}')"` : "";
    const context = opts.contextMethod && entry.kind !== "up" ? ` oncontextmenu="return ${callback}.${opts.contextMethod}(event,'${arg(path)}','${entry.kind === "dir" ? "dir" : "file"}')"` : "";
    const caret = entry.kind === "up" ? '<span class="herdr-tree-caret"></span>' : kind === "dir" ? `<span class="herdr-tree-caret" onclick="event.preventDefault();event.stopPropagation();${callback}.${toggleMethod}('${arg(path)}')">${icon(expanded ? "open" : "closed")}</span>` : '<span class="herdr-tree-caret"></span>';
    const action = entry.kind === "up" ? "up" : kind === "dir" ? dirClickMethod : selectMethod;
    const click = action ? ` onclick="${callback}.${action}('${arg(path)}'${kind === "file" && opts.shiftSelectMode ? `,event.shiftKey?'split':''` : ""})"` : "";
    const meta = opts.showMeta && entry.size != null ? `<span class="herdr-tree-meta">${formatBytes(entry.size)}</span>` : "";
    return `<button class="herdr-tree-row ${kind}${entry.kind === "up" ? " up" : ""}${active}${entry.status ? ` git-${entry.status}` : ""}" role="treeitem" style="${indentStyle(level, opts)}" title="${esc(path)}"${click}${dbl}${context}>${caret}<span class="herdr-tree-kind">${icon(entry.kind === "up" ? "up" : kind, path || entry.name)}</span><span class="herdr-tree-name">${highlight(entry.name || basename(path), opts.filterTerm)}</span>${statusBadge(entry.status)}${meta}</button>`;
  }

  function buildGitEntries(files, status) {
    return (files || []).map((path) => ({
      name: basename(path),
      path,
      kind: "file",
      status: status || "modified",
    }));
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
    return `${Math.round(value / 1024 / 102.4) / 10} MB`;
  }

  function parentPath(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }

  function parentDirectory(path) {
    const value = String(path || "").replace(/\/+$/, "");
    if (!value || value === "/") return value || "/";
    const index = value.lastIndexOf("/");
    if (index <= 0) return "/";
    return value.slice(0, index);
  }

  function upEntry(path, level) {
    return { kind: "up", name: "...", path: parentPath(path || ""), level: level || 0, expanded: false };
  }

  function searchTreeEntries(entries) {
    const rows = [];
    const seenDirs = new Set();
    for (const entry of entries || []) {
      const parts = String(entry.path || entry.name || "").split("/").filter(Boolean);
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        if (seenDirs.has(prefix)) continue;
        seenDirs.add(prefix);
        rows.push({ kind: "dir", name: parts[i], path: prefix, level: i, expanded: true });
      }
      rows.push(Object.assign({}, entry, { name: parts[parts.length - 1] || entry.name, level: Math.max(0, parts.length - 1), expanded: false }));
    }
    return rows;
  }

  function normalizeSearchKind(kind) {
    return kind === "dir" ? "dir" : "file";
  }

  function toggleSearchKind(kind) {
    return normalizeSearchKind(kind) === "dir" ? "file" : "dir";
  }

  function searchKindLabel(kind) {
    return normalizeSearchKind(kind) === "dir" ? "Folders" : "Files";
  }

  function searchKindNoun(kind) {
    return normalizeSearchKind(kind) === "dir" ? "folder" : "file";
  }

  function searchKindQuery(kind) {
    return `search_kind=${encodeURIComponent(normalizeSearchKind(kind))}`;
  }

  function entryMatchesTerm(entry, term) {
    const needle = String(term || "").trim().toLowerCase();
    if (!needle) return true;
    return String(entry.name || "").toLowerCase().includes(needle)
      || String(entry.path || "").toLowerCase().includes(needle);
  }

  function searchTreeEntriesByKind(entries, kind, term) {
    const normalized = normalizeSearchKind(kind);
    if (normalized === "file") return searchTreeEntries((entries || []).filter((entry) => entry.kind !== "dir"));
    return searchTreeEntries((entries || []).filter((entry) => entry.kind === "dir" && entryMatchesTerm(entry, term)));
  }

  function replacePathPrefix(value, from, to) {
    if (value === from) return to;
    return String(value || "").startsWith(`${from}/`) ? `${to}${String(value).slice(String(from).length)}` : value;
  }

  function removePathFromEntries(entries, path) {
    return (entries || []).filter((entry) => entry.path !== path && !String(entry.path || "").startsWith(`${path}/`));
  }

  function renamePathInEntries(entries, from, to, nextName) {
    return (entries || []).map((entry) => {
      if (entry.path !== from && !String(entry.path || "").startsWith(`${from}/`)) return entry;
      const next = Object.assign({}, entry, { path: replacePathPrefix(entry.path, from, to) });
      if (entry.path === from) next.name = nextName;
      return next;
    });
  }

  function remapPathMap(map, from, to, mapper) {
    const next = {};
    for (const [key, value] of Object.entries(map || {})) {
      next[replacePathPrefix(key, from, to)] = mapper ? mapper(value) : value;
    }
    return next;
  }

  function prunePathMap(map, path, mapper) {
    const next = {};
    for (const [key, value] of Object.entries(map || {})) {
      if (key === path || key.startsWith(`${path}/`)) continue;
      next[key] = mapper ? mapper(value) : value;
    }
    return next;
  }

  function applyGitStatus(entries, gitStatus) {
    if (!gitStatus || typeof gitStatus !== "object") return entries;
    return (entries || []).map((entry) => {
      const next = Object.assign({}, entry);
      const path = String(entry.path || entry.name || "");
      if (gitStatus[path]) next.status = gitStatus[path];
      return next;
    });
  }

  window.HerdrFileTree = {
    applyGitStatus,
    arg,
    basename,
    buildGitEntries,
    esc,
    formatBytes,
    highlight,
    parentDirectory,
    parentPath,
    renderEntries,
    renderPathTree,
    normalizeSearchKind,
    prunePathMap,
    remapPathMap,
    removePathFromEntries,
    renamePathInEntries,
    replacePathPrefix,
    searchKindLabel,
    searchKindNoun,
    searchKindQuery,
    searchTreeEntries,
    searchTreeEntriesByKind,
    toggleSearchKind,
    upEntry,
  };
})();
