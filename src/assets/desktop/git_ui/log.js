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

  function render(options) {
    const rows = rowsFromData(options.data || {});
    const selected = options.selected || [];
    const baseBranch = options.baseBranch || "master";
    const currentLabel = `${baseBranch} + current`;
    const esc = options.esc;
    const scope = `<div class="git-ui-log-scope-head"><span class="git-ui-toolbar-title">History scope</span><button class="git-ui-btn ${!options.logAll ? "active" : ""}" title="Show ${esc(baseBranch)} first, then the current branch" onclick="HerdrGitUi.setLogAll(false)">${esc(currentLabel)}</button><button class="git-ui-btn ${options.logAll ? "active" : ""}" title="Show every branch and remote ref" onclick="HerdrGitUi.setLogAll(true)">All branches</button>${options.actionsHtml || ""}</div>`;
    const header = `<div class="git-ui-log-table-head"><span>Graph</span><span>Description</span><span>Date</span><span>Author</span></div>`;
    const body = rows.length
      ? rows.map((row) => renderRow(row, selected, options)).join("")
      : `<div class="git-ui-empty-row">No commits found.</div>`;
    return `${scope}<div class="git-ui-log git-ui-log-table">${header}${body}</div>`;
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

  function renderRow(row, selected, options) {
    const esc = options.esc;
    const arg = options.arg;
    const hash = String(row.hash || "");
    const selectedClass = hash && selected.includes(hash) ? " selected" : "";
    const graphOnly = hash ? "" : " graph-only";
    const currentClass = row.current ? " current" : "";
    const lane = Number.isFinite(Number(row.lane)) ? Number(row.lane) : graphLane(row.graph);
    const color = laneColor(lane);
    const title = row.title || row.message || "";
    const click = hash ? ` onclick="HerdrGitUi.selectLogCommit(event,'${arg(hash)}')"` : "";
    return `<div class="git-ui-log-row${selectedClass}${graphOnly}${currentClass}" data-log-hash="${esc(hash)}" style="--lane:${color}" title="${esc(title)}"${click}>${renderGraph(row.graph, !!hash)}<span class="git-ui-log-desc">${renderLabels(row.labels || [], row.current, esc)}<span class="git-ui-log-title">${esc(title)}</span></span><span class="git-ui-log-date">${esc(row.date || "")}</span><span class="git-ui-log-author">${esc(row.author || "")}</span></div>`;
  }

  function renderLabels(labels, current, esc) {
    return `<span class="git-ui-log-labels">${labels.map((label) => renderLabel(label, current, esc)).join("")}</span>`;
  }

  function renderLabel(label, current, esc) {
    const normalized = normalizeLabel(label);
    const kind = labelKind(normalized, current);
    return `<span class="git-ui-log-ref ${kind}">${esc(normalized)}</span>`;
  }

  function normalizeLabel(label) {
    return String(label || "")
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\//, "")
      .replace(/^origin\//, "origin/")
      .trim();
  }

  function labelKind(label, current) {
    if (label === "HEAD" || label.startsWith("HEAD -> ") || current) return "current";
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

  window.HerdrGitLog = { render, scrollToCommit, rowsFromData, laneColor };
})();
