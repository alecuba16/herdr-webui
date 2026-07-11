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

  function snippetKey(path, match) {
    return `${path}:${match && match.id ? match.id : `${match.start_line || 0}:${match.line || 0}`}`;
  }

  function highlightLine(line, match, query) {
    const text = String(line || "");
    const start = Number(match && match.match_start);
    const end = Number(match && match.match_end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0 && end <= text.length) {
      return `${esc(text.slice(0, start))}<mark class="herdr-content-search-hit">${esc(text.slice(start, end))}</mark>${esc(text.slice(end))}`;
    }
    const needle = String(query || "").toLowerCase();
    const index = needle ? text.toLowerCase().indexOf(needle) : -1;
    if (index < 0) return esc(text);
    return `${esc(text.slice(0, index))}<mark class="herdr-content-search-hit">${esc(text.slice(index, index + needle.length))}</mark>${esc(text.slice(index + needle.length))}`;
  }

  function linePreview(match, query) {
    const before = (match.before || []).map((line, index) => `<div class="herdr-content-search-line muted"><span>${Number(match.start_line || 1) + index}</span><code>${esc(line)}</code></div>`).join("");
    const textLineNo = Number(match.line || match.start_line || 1);
    const text = `<div class="herdr-content-search-line matched"><span>${textLineNo}</span><code>${highlightLine(match.text || "", match, query)}</code></div>`;
    const afterStart = textLineNo + 1;
    const after = (match.after || []).map((line, index) => `<div class="herdr-content-search-line muted"><span>${afterStart + index}</span><code>${esc(line)}</code></div>`).join("");
    return `<div class="herdr-content-search-preview">${before}${text}${after}</div>`;
  }

  function renderMatch(file, match, state, opts) {
    const callback = opts.callback || "HerdrContentSearch";
    const key = snippetKey(file.path, match);
    const snippet = (state.snippets && state.snippets[key]) || {};
    const editing = !!snippet.editing;
    const dirty = !!snippet.dirty;
    const saving = !!snippet.saving;
    const editorId = `${opts.idPrefix || "contentSearchSnippet"}-${hashId(key)}`;
    const openHere = `<button class="git-ui-btn" onclick="${callback}.openMatch('${arg(file.path)}','${arg(match.id)}')">Open here</button>`;
    const editControls = opts.disableSnippetEditing
      ? ""
      : editing
        ? `<button class="git-ui-btn primary" ${saving ? "disabled" : ""} onclick="${callback}.saveSnippet('${arg(file.path)}','${arg(match.id)}')">${saving ? "Saving..." : "Save"}</button><button class="git-ui-btn" onclick="${callback}.cancelSnippet('${arg(file.path)}','${arg(match.id)}')">Cancel</button>`
        : `<button class="git-ui-btn" onclick="${callback}.editSnippet('${arg(file.path)}','${arg(match.id)}')">Edit</button>`;
    const expandControls = opts.disableSnippetExpand
      ? ""
      : `<span class="herdr-content-search-context-controls" aria-label="Expand match context"><button class="git-ui-context-arrow herdr-content-search-context-arrow" title="Show more above" aria-label="Show more above" onclick="${callback}.expandSnippet('${arg(file.path)}','${arg(match.id)}','up')">↑</button><button class="git-ui-context-arrow herdr-content-search-context-arrow" title="Show more below" aria-label="Show more below" onclick="${callback}.expandSnippet('${arg(file.path)}','${arg(match.id)}','down')">↓</button></span>`;
    return `<article class="herdr-content-search-match${dirty ? " dirty" : ""}" data-snippet-key="${esc(key)}" data-editor-id="${esc(editorId)}">
      <header><strong>Line ${Number(match.line || 0)}</strong><span>${esc(file.path)}</span><div class="herdr-content-search-actions">${openHere}${editControls}${expandControls}</div></header>
      ${snippet.error ? `<div class="file-browser-error">${esc(snippet.error)}</div>` : ""}
      ${editing ? `<div id="${esc(editorId)}" class="herdr-content-search-editor"></div>` : linePreview(match, state.query)}
    </article>`;
  }

  function renderFile(file, state, opts) {
    const callback = opts.callback || "HerdrContentSearch";
    const expanded = !!(state.expanded && state.expanded[file.path]);
    const matches = expanded ? (file.matches || []) : [];
    const load = expanded && file.truncated ? `<button class="git-ui-btn" onclick="${callback}.loadFile('${arg(file.path)}')">Load all matches</button>` : "";
    return `<section class="herdr-content-search-file ${expanded ? "expanded" : "collapsed"}">
      <button class="herdr-content-search-file-head" onclick="${callback}.toggleFile('${arg(file.path)}')" aria-expanded="${expanded ? "true" : "false"}">
        <span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>
        <strong>${esc(file.path)}</strong>
        <span>${Number(file.match_count || 0)} match${Number(file.match_count || 0) === 1 ? "" : "es"}</span>
      </button>
      <div class="herdr-content-search-file-actions"><button class="git-ui-btn" onclick="${callback}.openFile('${arg(file.path)}')">Open full file</button>${load}</div>
      ${expanded ? `<div class="herdr-content-search-matches">${matches.map((match) => renderMatch(file, match, state, opts)).join("")}</div>` : ""}
    </section>`;
  }

  function render(state, opts) {
    const callback = opts.callback || "HerdrContentSearch";
    const files = state.files || [];
    const query = String(state.query || "");
    const summary = query ? `${Number(state.total_matches || 0)} matches in ${Number(state.total_files || files.length || 0)} files` : "Type a content query";
    const head = opts.hideInput ? "" : `<div class="herdr-content-search-head">
        <label class="file-browser-filter"><span class="file-browser-search-icon ${state.loading ? "searching" : ""}" aria-hidden="true"></span><input id="${esc(opts.inputId || "fileContentSearchInput")}" value="${esc(query)}" placeholder="Search file contents" oninput="${callback}.setQuery(this.value)" onkeydown="${callback}.inputKeydown(event)"></label>
        <button class="git-ui-btn primary" onclick="${callback}.run()">Search</button>
        <button class="git-ui-btn" onclick="${callback}.clear()">Clear</button>
      </div>`;
    const body = !query
      ? `<div class="file-browser-empty">Search inside files from this workspace.</div>`
      : state.loading && !files.length
        ? `<div class="file-browser-empty">Searching...</div>`
        : files.length
          ? files.map((file) => renderFile(file, state, opts)).join("")
          : `<div class="file-browser-empty">No content matches.</div>`;
    return `<div class="herdr-content-search">
      ${head}
      <div class="herdr-content-search-tools"><span>${esc(summary)}</span><button class="git-ui-btn" onclick="${callback}.expandAll()">Expand all</button><button class="git-ui-btn" onclick="${callback}.collapseAll()">Collapse all</button></div>
      ${state.error ? `<div class="file-browser-error">${esc(state.error)}</div>` : ""}
      <div class="herdr-content-search-results">${body}</div>
      ${query && !state.done ? `<button class="git-ui-btn file-browser-more" onclick="${callback}.loadMore()">Load more files</button>` : ""}
    </div>`;
  }

  function hashId(value) {
    let hash = 0;
    for (const ch of String(value || "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return Math.abs(hash).toString(36);
  }

  function findMatch(file, matchId) {
    return (file && file.matches || []).find((match) => String(match.id) === String(matchId)) || null;
  }

  window.HerdrContentSearch = { render, snippetKey, hashId, findMatch };
})();
