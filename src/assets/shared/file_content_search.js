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

  function matchLineNumber(match) {
    return Math.max(1, Number(match && (match.line || match.start_line)) || 1);
  }

  function matchRows(match, query) {
    const textLine = matchLineNumber(match);
    const before = match.before || [];
    const after = match.after || [];
    const rows = [];
    const firstBeforeLine = textLine - before.length;
    before.forEach((line, index) => rows.push({ line: firstBeforeLine + index, text: line, matched: false, match: null }));
    rows.push({ line: textLine, text: match.text || "", matched: true, match });
    after.forEach((line, index) => rows.push({ line: textLine + index + 1, text: line, matched: false, match: null }));
    return rows.filter((row) => row.line > 0).map((row) => Object.assign(row, { html: row.matched ? highlightLine(row.text, row.match, query) : esc(row.text) }));
  }

  function lineChunks(file, state) {
    const chunks = [];
    const matches = [...(file.matches || [])].sort((a, b) => matchLineNumber(a) - matchLineNumber(b));
    for (const match of matches) {
      const rows = matchRows(match, state.query);
      if (!rows.length) continue;
      const chunk = { start: rows[0].line, end: rows[rows.length - 1].line, rows, matches: [match] };
      if (globalThis.HerdrLineContext && globalThis.HerdrLineContext.pushMergedChunk) globalThis.HerdrLineContext.pushMergedChunk(chunks, chunk);
      else {
        const last = chunks[chunks.length - 1];
        if (last && chunk.start <= last.end + 1) mergeChunk(last, chunk);
        else chunks.push(chunk);
      }
    }
    return chunks;
  }

  function mergeChunk(target, source) {
    const byLine = new Map(target.rows.map((row) => [row.line, row]));
    for (const row of source.rows) {
      const existing = byLine.get(row.line);
      if (!existing || (!existing.matched && row.matched)) byLine.set(row.line, row);
    }
    target.rows = [...byLine.values()].sort((a, b) => a.line - b.line);
    target.start = target.rows[0].line;
    target.end = target.rows[target.rows.length - 1].line;
    target.matches.push(...source.matches);
  }

  function renderLineChunk(file, chunk, state, opts) {
    const callback = opts.callback || "HerdrContentSearch";
    const firstMatch = chunk.matches[0] || {};
    const canExpand = !opts.disableSnippetExpand;
    const above = canExpand && chunk.start > 1
      ? `<button class="git-ui-context-arrow herdr-content-search-context-arrow" title="Show more above; chunks merge when context overlaps" aria-label="Show more above" onclick="${callback}.expandSnippet('${arg(file.path)}','${arg(firstMatch.id)}','up')">↑</button>`
      : "";
    const below = canExpand && chunk.rows.length
      ? `<button class="git-ui-context-arrow herdr-content-search-context-arrow" title="Show more below; chunks merge when context overlaps" aria-label="Show more below" onclick="${callback}.expandSnippet('${arg(file.path)}','${arg(firstMatch.id)}','down')">↓</button>`
      : "";
    return `<div class="herdr-content-search-preview herdr-content-search-chunk">
      ${chunk.rows.map((row, index) => {
        const top = index === 0 ? above : "";
        const bottom = index === chunk.rows.length - 1 ? below : "";
        const open = row.matched && row.match ? ` ondblclick="${callback}.openMatch('${arg(file.path)}','${arg(row.match.id)}')" title="Double-click to open this match"` : "";
        return `<div class="herdr-content-search-line ${row.matched ? "matched" : "muted"}"${open}><div class="herdr-content-search-context-cell">${top}${bottom}</div><span>${row.line}</span><code>${row.html}</code></div>`;
      }).join("")}
    </div>`;
  }

  function renderFile(file, state, opts) {
    const callback = opts.callback || "HerdrContentSearch";
    const expanded = !!(state.expanded && state.expanded[file.path]);
    const chunks = expanded ? lineChunks(file, state) : [];
    const load = expanded && file.truncated ? `<button class="git-ui-btn" onclick="${callback}.loadFile('${arg(file.path)}')">Load all matches</button>` : "";
    return `<section class="herdr-content-search-file ${expanded ? "expanded" : "collapsed"}">
      <button class="herdr-content-search-file-head" onclick="${callback}.toggleFile('${arg(file.path)}')" aria-expanded="${expanded ? "true" : "false"}">
        <span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>
        <strong>${esc(file.path)}</strong>
        <span>${Number(file.match_count || 0)} match${Number(file.match_count || 0) === 1 ? "" : "es"}</span>
      </button>
      <div class="herdr-content-search-file-actions"><button class="git-ui-btn" onclick="${callback}.openFile('${arg(file.path)}')">Open full file</button>${load}</div>
      ${expanded ? `<div class="herdr-content-search-matches">${chunks.map((chunk) => renderLineChunk(file, chunk, state, opts)).join("")}</div>` : ""}
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
      <div class="herdr-content-search-tools"><span>${esc(summary)}</span></div>
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
