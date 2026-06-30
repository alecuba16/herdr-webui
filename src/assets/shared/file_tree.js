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

  function highlight(value, query) {
    const text = String(value == null ? "" : value);
    const needle = String(query || "").trim();
    if (!needle) return esc(text);
    const source = /[A-Z]/.test(needle) ? text : text.toLowerCase();
    const target = /[A-Z]/.test(needle) ? needle : needle.toLowerCase();
    const index = source.indexOf(target);
    if (index < 0) return esc(text);
    return `${esc(text.slice(0, index))}<mark class="herdr-tree-highlight">${esc(text.slice(index, index + needle.length))}</mark>${esc(text.slice(index + needle.length))}`;
  }

  function icon(kind) {
    const safe = kind === "dir" ? "folder" : kind === "up" ? "folder-up" : kind === "open" ? "chevron-down" : kind === "closed" ? "chevron-right" : "file";
    return `<span class="herdr-tree-icon herdr-tree-icon-${safe}" aria-hidden="true"></span>`;
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

  function statusBadge(status) {
    if (!status) return "";
    const map = {
      added: "+",
      modified: "✎",
      deleted: "−",
      conflict: "!",
      staged: "S",
      untracked: "+",
    };
    return `<span class="herdr-tree-status ${esc(status)}">${esc(map[status] || status)}</span>`;
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
        return `<div class="herdr-tree-row dir${dirClass}" role="treeitem" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}" style="${indentStyle(level, opts)}" onclick="${callback}.${opts.toggleMethod || "toggle"}('${arg(dirPath)}')"${keydown}><span class="herdr-tree-caret">${icon(collapsed ? "closed" : "open")}</span><span class="herdr-tree-kind">${icon("dir")}</span><span class="herdr-tree-name">${name}</span></div>${collapsed ? "" : renderPathNode(compact.child, dirPath, opts, level + 1)}`;
      }
      const selected = opts.selectedPath === entry.path && (!opts.selectedKind || opts.selectedKind === opts.kind);
      const meta = typeof opts.metaForPath === "function" ? opts.metaForPath(entry.path, opts.kind) : "";
      const status = typeof opts.statusForPath === "function" ? opts.statusForPath(entry.path, opts.kind) : opts.status;
      const keydown = opts.activateMethod ? ` onkeydown="${callback}.${opts.activateMethod}(event)"` : "";
      const context = opts.contextMethod ? ` oncontextmenu="return ${callback}.${opts.contextMethod}(event,'${arg(entry.path)}'${kindArg})"` : "";
      const data = opts.dataPrefix ? ` data-${opts.dataPrefix}-path="${esc(entry.path)}" data-${opts.dataPrefix}-kind="${esc(opts.kind || "")}"` : "";
      const rowClass = opts.rowClass ? ` ${opts.rowClass}` : "";
      return `<div class="herdr-tree-row file${rowClass}${selected ? " active" : ""}" role="treeitem" tabindex="0"${data} style="${indentStyle(level, opts)}" title="${esc(entry.path)}" onclick="${callback}.${opts.selectMethod || "select"}('${arg(entry.path)}'${kindArg})"${keydown}${context}><span class="herdr-tree-caret"></span><span class="herdr-tree-kind">${icon("file")}</span><span class="herdr-tree-name">${highlight(entry.name, opts.highlightQuery)}</span>${statusBadge(status)}${meta}</div>`;
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
    if (!parts || parts.length <= 1 || !opts.expandCompactMethod) return highlight((parts && parts[0] && parts[0].name) || "", opts.highlightQuery);
    return parts.map((part, index) => `<button type="button" class="herdr-tree-crumb" onclick="event.stopPropagation();${callback}.${opts.expandCompactMethod}('${arg(part.path)}')">${highlight(part.name, opts.highlightQuery)}</button>${index < parts.length - 1 ? '<span class="herdr-tree-sep">/</span>' : ""}`).join("");
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
    return `<button class="herdr-tree-row ${kind}${entry.kind === "up" ? " up" : ""}${active}" role="treeitem" style="${indentStyle(level, opts)}" title="${esc(path)}"${click}${dbl}${context}>${caret}<span class="herdr-tree-kind">${icon(entry.kind === "up" ? "up" : kind)}</span><span class="herdr-tree-name">${highlight(entry.name || basename(path), opts.highlightQuery)}</span>${statusBadge(entry.status)}${meta}</button>`;
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

  window.HerdrFileTree = {
    arg,
    basename,
    buildGitEntries,
    esc,
    formatBytes,
    highlight,
    renderEntries,
    renderPathTree,
  };
})();
