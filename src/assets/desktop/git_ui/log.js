(function () {
  const LANE_COLORS = [
    "var(--accent)",
    "#7dd3fc",
    "#c084fc",
    "#fbbf24",
    "#34d399",
    "#fb7185",
    "#a3e635",
    "#f472b6",
  ];
  const FILTER_FIELDS = ["description", "date", "author"];

  function logCommitCount(data, rows) {
    if (Array.isArray(data.commits)) return data.commits.length;
    return rows.filter((row) => row && row.hash).length;
  }

  function render(options) {
    const rows = rowsFromData(options.data || {});
    const selected = options.selected || [];
    const filters = normalizeFilters(options.filters || {});
    const baseBranch = options.baseBranch || "master";
    const currentLabel = `${baseBranch} + current`;
    const esc = options.esc;
    const scope = `<div class="git-ui-log-scope-head"><span class="git-ui-toolbar-title">History scope</span><button class="git-ui-btn ${!options.logAll ? "active" : ""}" title="Show ${esc(baseBranch)} first, then the current branch" onclick="HerdrGitUi.setLogAll(false)">${esc(currentLabel)}</button><button class="git-ui-btn ${options.logAll ? "active" : ""}" title="Show every branch and remote ref" onclick="HerdrGitUi.setLogAll(true)">All branches</button>${options.actionsHtml || ""}</div>`;
    const header = `<div class="git-ui-log-table-head"><span>Graph</span><span>Description</span><span>Date</span><span>Author</span></div>${renderFilterRow(filters, esc)}`;
    const body = rows.length
      ? rows.map((row) => renderRow(row, selected, filters, options, baseBranch)).join("")
      : `<div class="git-ui-empty-row">No commits found.</div>`;
    const footer = renderLoadMore(options.data || {}, rows, options, esc);
    return `${scope}<div class="git-ui-log git-ui-log-table">${header}${body}${footer}</div>`;
  }

  function renderLoadMore(data, rows, options, esc) {
    const count = logCommitCount(data || {}, rows || []);
    const limit = Number(data.limit || options.logLimit || count || 0);
    const hasMore = !!(data && data.has_more);
    const disabled = options.logLoadingMore ? "disabled" : "";
    const label = options.logLoadingMore ? "Loading more changes…" : "Load more changes";
    return `<div class="git-ui-log-load-more"><span>Showing ${esc(String(count))}${limit ? ` of ${esc(String(limit))} requested` : ""} commits</span><button class="git-ui-btn" onclick="HerdrGitUi.loadMoreLog()" ${hasMore ? disabled : "disabled"}>${hasMore ? label : "No more changes"}</button></div>`;
  }

  function renderFilterRow(filters, esc) {
    const input = (field, label) => `<label class="git-ui-log-filter"><span>${label}</span><input value="${esc(filters[field] || "")}" placeholder="Filter ${label.toLowerCase()}" oninput="HerdrGitUi.setLogFilter('${field}',this.value)"></label>`;
    return `<div class="git-ui-log-filter-row"><span class="git-ui-log-filter-spacer" aria-hidden="true"></span>${input("description", "Description")}${input("date", "Date")}${input("author", "Author")}</div>`;
  }

  function rowsFromData(data) {
    if (Array.isArray(data.rows) && data.rows.length) return data.rows;
    return (data.lines || []).map(rowFromLegacyLine).filter(Boolean);
  }

  function rowFromLegacyLine(line) {
    const parsed = parseLegacyLine(line);
    if (!parsed) return null;
    const detail = splitDecorations(parsed.message || "");
    return {
      graph: parsed.graph,
      hash: parsed.hash,
      title: detail.title,
      labels: detail.labels,
      date: "",
      exact_date: "",
      author: "",
      lane: graphLane(parsed.graph),
      current: detail.labels.some((label) => label === "HEAD" || label.startsWith("HEAD -> ")),
    };
  }

  function parseLegacyLine(line) {
    const raw = String(line || "");
    const match = raw.match(/[a-f0-9]{7,}/i);
    if (!match) return /^[|\\/ *._-]+$/.test(raw) ? { graph: raw, hash: "", message: "" } : null;
    const hash = match[0];
    return {
      graph: raw.slice(0, match.index),
      hash,
      message: raw.slice((match.index || 0) + hash.length).replace(/^[\s|\\/_.*-]+/, "").trim(),
    };
  }

  function splitDecorations(value) {
    const text = String(value || "").trim();
    const match = text.match(/^\(([^)]+)\)\s*(.*)$/);
    if (!match) return { labels: [], title: text };
    return {
      labels: match[1].split(",").map((label) => label.trim()).filter(Boolean),
      title: match[2].trim(),
    };
  }

  function renderRow(row, selected, filters, options, baseBranch) {
    const esc = options.esc;
    const arg = options.arg;
    const hash = String(row.hash || "");
    const selectedClass = hash && selected.includes(hash) ? " selected" : "";
    const graphOnly = hash ? "" : " graph-only";
    const currentClass = row.current ? " current" : "";
    const lane = Number.isFinite(Number(row.lane)) ? Number(row.lane) : graphLane(row.graph);
    const color = laneColor(lane);
    const title = row.title || row.message || "";
    const filterText = filterFields(row);
    const hidden = matchesFilters(filterText, filters) ? "" : " hidden";
    const click = hash ? ` onclick="HerdrGitUi.selectLogCommit(event,'${arg(hash)}')"` : "";
    const hover = renderHover(row, color, esc, baseBranch);
    const tooltip = hoverText(row);
    return `<div class="git-ui-log-row${selectedClass}${graphOnly}${currentClass}${hidden}" data-log-hash="${esc(hash)}" data-log-filter-description="${esc(filterText.description)}" data-log-filter-date="${esc(filterText.date)}" data-log-filter-author="${esc(filterText.author)}" style="--lane:${color}" title="${esc(tooltip)}"${click}>${renderGraph(row.graph, !!hash)}<span class="git-ui-log-desc">${renderLabels(row.labels || [], row.current, esc, baseBranch)}<span class="git-ui-log-title">${esc(title)}</span></span><span class="git-ui-log-date">${esc(row.date || "")}</span><span class="git-ui-log-author">${esc(row.author || "")}</span>${hover}</div>`;
  }

  function renderHover(row, color, esc, baseBranch) {
    if (!row.hash) return "";
    const labels = row.labels || [];
    return `<div class="git-ui-log-hover-card" style="--lane:${color}"><div class="git-ui-log-hover-labels">${labels.map((label) => renderLabel(label, row.current, esc, baseBranch)).join("")}</div><div><strong>${esc(row.hash || "")}</strong></div><div>${esc(row.title || row.message || "")}</div><div>${esc(row.exact_date || row.date || "")}</div><div>${esc(row.author || "")}</div></div>`;
  }

  function hoverText(row) {
    const labels = (row.labels || []).map(normalizeLabel).filter(Boolean).join(", ");
    return [`[${labels || "no branch"}] ${row.hash || ""}`, row.exact_date || row.date || "", row.author || "", row.title || row.message || ""].filter(Boolean).join("\n");
  }

  function filterFields(row) {
    const labels = (row.labels || []).map(normalizeLabel).join(" ");
    const title = row.title || row.message || "";
    return {
      description: `${labels} ${title}`,
      date: `${row.date || ""} ${row.exact_date || ""}`,
      author: row.author || "",
    };
  }

  function normalizeFilters(filters) {
    return FILTER_FIELDS.reduce((next, field) => {
      next[field] = String(filters[field] || "").trim().toLowerCase();
      return next;
    }, {});
  }

  function matchesFilters(text, filters) {
    return FILTER_FIELDS.every((field) => {
      const needle = filters[field];
      return !needle || String(text[field] || "").toLowerCase().includes(needle);
    });
  }

  function applyFilters(filters) {
    const normalized = normalizeFilters(filters || {});
    for (const row of document.querySelectorAll(".git-ui-log-row")) {
      const text = FILTER_FIELDS.reduce((next, field) => {
        next[field] = row.dataset[`logFilter${field[0].toUpperCase()}${field.slice(1)}`] || "";
        return next;
      }, {});
      row.hidden = !matchesFilters(text, normalized);
    }
  }

  function renderLabels(labels, current, esc, baseBranch) {
    return `<span class="git-ui-log-labels">${labels.map((label) => renderLabel(label, current, esc, baseBranch)).join("")}</span>`;
  }

  function renderLabel(label, current, esc, baseBranch) {
    const normalized = normalizeLabel(label);
    const kind = labelKind(normalized, current, baseBranch);
    return `<span class="git-ui-log-ref ${kind}">${esc(normalized)}</span>`;
  }

  function normalizeLabel(label) {
    return String(label || "")
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\//, "")
      .replace(/^origin\//, "origin/")
      .trim();
  }

  function labelKind(label, current, baseBranch) {
    const base = String(baseBranch || "master");
    if (label === "HEAD" || label.startsWith("HEAD -> ")) return "current";
    if (label === base || label === `origin/${base}` || label === "main" || label === "origin/main" || label === "master" || label === "origin/master") return "main";
    if (label.startsWith("tag:")) return "tag";
    if (label.includes("/")) return "remote";
    return "branch";
  }

  function renderGraph(graph, hasCommit) {
    const chars = String(graph || "* ").split("");
    const cells = [];
    for (let i = 0; i < Math.min(chars.length, 24); i++) {
      const ch = chars[i];
      let cls = "git-ui-lane";
      let mark = "";
      if (ch === "*") {
        cls += " commit";
        mark = '<i class="git-ui-log-dot"></i>';
      } else if (ch === "|") cls += " vertical";
      else if (ch === "/") cls += " merge-left";
      else if (ch === "\\") cls += " merge-right";
      else if (ch === "_" || ch === "-" || ch === ".") cls += " horizontal";
      cells.push(`<span class="${cls}" style="--lane:${laneColor(i)}">${mark}</span>`);
    }
    if (hasCommit && !String(graph || "").includes("*")) {
      cells.unshift('<span class="git-ui-lane commit" style="--lane:var(--accent)"><i class="git-ui-log-dot"></i></span>');
    }
    return `<span class="git-ui-log-graph" aria-hidden="true">${cells.join("")}</span>`;
  }

  function graphLane(graph) {
    const chars = String(graph || "").split("");
    const star = chars.indexOf("*");
    if (star >= 0) return star;
    const line = chars.indexOf("|");
    return line >= 0 ? line : 0;
  }

  function laneColor(index) {
    return LANE_COLORS[Math.max(0, index) % LANE_COLORS.length];
  }

  function scrollToCommit(hash) {
    const nodes = Array.from(document.querySelectorAll(".git-ui-log-row[data-log-hash]"));
    const target = nodes.find((node) => (node.dataset.logHash || "").startsWith(hash));
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  window.HerdrGitLog = { render, scrollToCommit, rowsFromData, laneColor, applyFilters, logCommitCount };
})();
