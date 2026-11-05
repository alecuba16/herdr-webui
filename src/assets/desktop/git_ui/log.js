(function () {
  const LANE_COLORS = [
    "var(--accent)",
    "var(--git-log-lane-1, #7dd3fc)",
    "var(--git-log-lane-2, #c084fc)",
    "var(--git-log-lane-3, #fbbf24)",
    "var(--git-log-lane-4, #34d399)",
    "var(--git-log-lane-5, #fb7185)",
    "var(--git-log-lane-6, #a3e635)",
    "var(--git-log-lane-7, #f472b6)",
  ];
  const FILTER_FIELDS = ["description", "date", "author"];
  let searchCaseSensitive = false;
  let searchPosition = -1;
  let searchHash = "";
  let activeFilters = {};
  const inputAttrs = (hint) => globalThis.HerdrAppHelpers
    ? globalThis.HerdrAppHelpers.inputAttrs(hint)
    : ' autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"';
  // "tag: x" decorations git puts in %D; one regex shared by the tag
  // extraction (hover card Tags row) and the chip-row filter that hides tags
  // from the label chips so they do not render twice.
  const TAG_LABEL = /^tag:\s*/i;
  // encodeURIComponent leaves ' unescaped, and these strings land inside
  // single-quoted JS strings in onclick attributes (git refnames and
  // authors may contain '). %27 keeps the JS string intact and
  // decodeURIComponent still yields the original char.
  const jsArg = (value) => encodeURIComponent(String(value ?? "")).replace(/'/g, "%27");

  function logCommitCount(data, rows) {
    if (Array.isArray(data.commits)) return data.commits.length;
    return rows.filter((row) => row && row.hash).length;
  }

  function render(options) {
    const rows = rowsFromData(options.data || {});
    const selected = options.selected || [];
    const filters = normalizeFilters(options.filters || {});
    activeFilters = filters;
    const baseBranch = options.baseBranch || "master";
    const logScope = normalizeLogScope(options.logScope || (options.logAll ? "all" : "base-current"));
    const esc = options.esc;
    const upstreamRef = upstreamRefFromStatus(options.status || {});
    // Traceable branch lines: the current branch's lane paints red and the
    // base branch's lane paints blue down from their tip rows, so the two
    // lines stay identifiable past the tip chips the way Zed keeps HEAD
    // findable via its check icon (we use line color instead of an icon).
    const lanePainting = computeLanePainting(rows, baseBranch);
    const scopeButton = `<span class="git-ui-log-scope-control"><span>Scope:</span><button class="git-ui-btn active" title="Toggle history scope: Master + Branch, All, Branch" onclick="HerdrGitUi.cycleLogScope()">${esc(logScopeLabel(logScope, baseBranch))}</button>${options.filePath ? `<button class="git-ui-btn git-ui-log-file-clear" title="Show log for the whole repository" onclick="HerdrGitUi.clearLogFileHistory()">× ${esc(options.filePath)}</button>` : ""}</span>`;
    const header = `<div class="git-ui-log-table-head"><span class="git-ui-log-cell-refs">Refs</span><span class="git-ui-log-cell-graph">Graph</span><span class="git-ui-log-cell-description">Description</span><span class="git-ui-log-cell-date">Date</span><span class="git-ui-log-cell-author">Author</span><span class="git-ui-log-cell-hash">Commit</span></div>`;
    const matches = rows.filter((row) => row.hash && matchesFilters(filterFields(row), filters));
    searchPosition = matches.findIndex((row) => row.hash === searchHash);
    if (searchPosition < 0) searchHash = "";
    const renderOptions = Object.assign({}, options, { upstreamRef });
    const body = rows.length
      ? rows.map((row, index) => renderRow(row, index, selected, filters, renderOptions, baseBranch, lanePainting)).join("")
      : `<div class="git-ui-empty-row">No commits found.</div>`;
    const footer = renderLoadMore(options.data || {}, rows, options, esc);
    const count = `${searchPosition >= 0 ? searchPosition + 1 : 0} / ${matches.length}`;
    const disabled = matches.length ? "" : " disabled";
    const search = `<div class="git-ui-log-searchbar">${scopeButton}<label class="git-ui-log-search-input"><span>Search commits</span><input name="git-log-search" aria-label="Search commits" value="${esc(filters.description || "")}"${inputAttrs("search")} oninput="HerdrGitLog.setSearch(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();HerdrGitLog.navigateSearch(event.shiftKey?-1:1)}"></label><button type="button" class="git-ui-log-search-case" aria-label="Match case" aria-pressed="${searchCaseSensitive}" onclick="HerdrGitLog.toggleSearchCase()">Aa</button><button type="button" class="git-ui-log-search-previous" aria-label="Previous matching commit" onclick="HerdrGitLog.navigateSearch(-1)"${disabled}>↑</button><button type="button" class="git-ui-log-search-next" aria-label="Next matching commit" onclick="HerdrGitLog.navigateSearch(1)"${disabled}>↓</button><output class="git-ui-log-search-count" aria-live="polite">${count}</output><details class="git-ui-log-advanced-filters"><summary>Filters</summary>${renderFilterRow(filters, esc)}</details></div>`;
    return `<section class="git-ui-log-workbench" data-git-log-design="zed" data-log-scope="${logScope}" data-has-selection="${selected.length > 0}" data-has-details="${selected.length === 1}"><div class="git-ui-log-layout"><div class="git-ui-log-browser">${search}<div class="git-ui-log git-ui-log-table">${header}${body}${footer}</div></div>${selected.length === 1 ? detailsSeparator() : ""}${renderDetails(options)}</div></section>`;
  }

  function renderPerson(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="10" r="5" stroke="currentColor" stroke-width="2"/><path d="M6 28v-3a10 10 0 0 1 20 0v3" stroke="currentColor" stroke-width="2"/></svg>`;
  }

  function copyButton(value, kind) {
    return `<button type="button" class="git-ui-log-copy-hash" aria-label="Copy ${kind}" title="Copy ${kind}" onclick="HerdrGitUi.copyScopeValue(event,'${jsArg(value)}','${jsArg(kind)}')">Copy</button>`;
  }

  function commitWebUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch {
      return "";
    }
  }

  // Resizable details split. The pane lives in its own grid track and a
  // separator between list and details resizes it. CSS owns the axis:
  // wide workbenches keep the pane as a right column (col-resize) and
  // container queries stack it above the list on narrow ones (row-resize),
  // so the drag reads the separator's computed cursor mid-gesture instead
  // of guessing the layout mode. The size is a layout preference and
  // survives re-renders; double-click resets it to the CSS default.
  let detailsResize = null;
  let detailsPaneSize = { width: 0, height: 0 };

  function separatorNode() {
    if (typeof document === "undefined" || !document || typeof document.querySelector !== "function") return null;
    return document.querySelector(".git-ui-log-separator");
  }

  function separatorAxis(separator) {
    // Test contexts without getComputedStyle fall back to the wide
    // layout, which is also the axis a live drag keeps if the container
    // flips mid-gesture.
    const styles = typeof getComputedStyle === "function" ? getComputedStyle(separator) : null;
    return styles && styles.cursor ? (styles.cursor.includes("row") ? "row" : "column") : "column";
  }

  function paneRects() {
    const separator = separatorNode();
    if (!separator) return null;
    const layout = separator.parentElement && separator.parentElement.getBoundingClientRect ? separator.parentElement.getBoundingClientRect() : null;
    const details = document.querySelector(".git-ui-log-details");
    const detailsRect = details && details.getBoundingClientRect ? details.getBoundingClientRect() : null;
    if (!layout || !detailsRect) return null;
    return { layout, details: detailsRect };
  }

  function paneSizeBounds(axis, layoutRect) {
    if (!layoutRect || !layoutRect.width || !layoutRect.height) return null;
    if (axis === "row") {
      const min = 96;
      return { min, max: Math.max(min, Math.round(layoutRect.height * 0.8)) };
    }
    const min = 180;
    return { min, max: Math.max(min, Math.round(layoutRect.width * 0.8)) };
  }

  function clampPaneSize(size, axis, layoutRect, detailsRect) {
    const bounds = paneSizeBounds(axis, layoutRect);
    if (!bounds || !detailsRect) return size;
    if (axis === "row") return { width: size.width, height: Math.max(bounds.min, Math.min(size.height, bounds.max)) };
    return { width: Math.max(bounds.min, Math.min(size.width, bounds.max)), height: size.height };
  }

  function beginDetailsResize(event) {
    if (!event || event.type === "click" || (event.pointerType === "mouse" && event.button !== 0)) return;
    const separator = separatorNode();
    if (!separator) return;
    // Pointer capture keeps the move/up stream on the separator even
    // after the pointer crosses into the list or the pane.
    if (separator.setPointerCapture && event.pointerId != null) separator.setPointerCapture(event.pointerId);
    const axis = separatorAxis(separator);
    syncSeparatorAria(separator);
    const rects = paneRects() || {};
    // Only the live axis gets a gesture baseline. Capturing both
    // dimensions would write the stacked layout's squeezed width into
    // the column var (and vice versa), so a resize while narrow would
    // poison the wide layout after the container flips back.
    const baseline = axis === "row"
      ? (detailsPaneSize.height || Math.round(rects.details ? rects.details.height : 0))
      : (detailsPaneSize.width || Math.round(rects.details ? rects.details.width : 0));
    detailsResize = {
      axis,
      x: event.clientX,
      y: event.clientY,
      width: axis === "row" ? 0 : baseline,
      height: axis === "row" ? baseline : 0,
    };
    setDetailsResizing(true);
  }

  function setDetailsResizing(active) {
    const separator = separatorNode();
    if (!separator || !separator.setAttribute) return;
    separator.setAttribute("data-resizing", active ? "true" : "false");
  }

  function moveDetailsResize(event) {
    if (!detailsResize) return;
    event.preventDefault();
    const rects = paneRects();
    // The cross axis keeps its saved size: only the live axis moves.
    const size = detailsResize.axis === "row"
      ? { width: detailsPaneSize.width, height: detailsResize.height + (event.clientY - detailsResize.y) }
      : { width: detailsResize.width + (detailsResize.x - event.clientX), height: detailsPaneSize.height };
    detailsPaneSize = clampPaneSize(size, detailsResize.axis, rects && rects.layout, rects && rects.details);
    applyDetailsPaneSize();
    syncSeparatorAria(separatorNode());
  }

  function endDetailsResize() {
    if (!detailsResize) return;
    detailsResize = null;
    setDetailsResizing(false);
  }

  function moveDetailsResizeKeyboard(event) {
    if (event && event.key === "Home") {
      event.preventDefault();
      resetDetailsPaneSize();
      return;
    }
    const step = event && event.shiftKey ? 48 : 16;
    const delta = { ArrowLeft: { axis: "column", amount: step }, ArrowRight: { axis: "column", amount: -step }, ArrowUp: { axis: "row", amount: -step }, ArrowDown: { axis: "row", amount: step } }[event && event.key];
    if (!delta) return;
    event.preventDefault();
    const separator = separatorNode();
    if (!separator) return;
    const axis = separatorAxis(separator);
    if (axis !== delta.axis) return;
    const rects = paneRects();
    const size = axis === "row"
      ? { width: detailsPaneSize.width, height: (detailsPaneSize.height || Math.round(rects && rects.details ? rects.details.height : 0)) + delta.amount }
      : { width: (detailsPaneSize.width || Math.round(rects && rects.details ? rects.details.width : 0)) + delta.amount, height: detailsPaneSize.height };
    detailsPaneSize = clampPaneSize(size, axis, rects && rects.layout, rects && rects.details);
    applyDetailsPaneSize();
    syncSeparatorAria(separator);
  }

  function resetDetailsPaneSize() {
    detailsPaneSize = { width: 0, height: 0 };
    applyDetailsPaneSize();
    const separator = separatorNode();
    if (separator) syncSeparatorAria(separator);
  }

  function applyDetailsPaneSize() {
    // The grid tracks that consume the size vars live on the layout
    // element, so the vars must be set there; custom properties only
    // inherit down the tree.
    const separator = separatorNode();
    const layout = separator && separator.parentElement && separator.parentElement.style ? separator.parentElement : null;
    if (!layout) return;
    if (detailsPaneSize.width) layout.style.setProperty("--git-log-pane-width", `${detailsPaneSize.width}px`);
    else layout.style.removeProperty("--git-log-pane-width");
    if (detailsPaneSize.height) layout.style.setProperty("--git-log-pane-height", `${detailsPaneSize.height}px`);
    else layout.style.removeProperty("--git-log-pane-height");
  }

  // Runs after every log mount: the separator is re-created by each
  // render, so its ARIA orientation (axis comes from CSS) and the saved
  // pane size (vars live on the layout element) must be re-applied to
  // the fresh nodes.
  function syncSeparatorState() {
    const separator = separatorNode();
    if (!separator || !separator.setAttribute) return;
    applyDetailsPaneSize();
    syncSeparatorAria(separator);
    syncSeparatorObserver(separator);
  }

  // Container queries flip the separator's axis (col-resize <-> row-resize)
  // when the workbench crosses 780px, but nothing re-renders on a pure
  // resize, so the ARIA orientation and values would go stale until the
  // next interaction. One observer on the layout element re-syncs them;
  // it is re-targeted on each mount because every render replaces the
  // layout node.
  let separatorObserver = null;
  let separatorObserved = null;
  function syncSeparatorObserver(separator) {
    const layout = separator.parentElement;
    if (separatorObserved === layout) return;
    if (typeof ResizeObserver !== "function" || !layout) return;
    if (!separatorObserver) separatorObserver = new ResizeObserver(() => syncSeparatorAria(separatorNode()));
    separatorObserver.disconnect();
    separatorObserver.observe(layout);
    separatorObserved = layout;
  }

  // A focusable separator is a window splitter for assistive tech, so it
  // carries the pane size and its clamp range as ARIA values. The value
  // follows the live axis: width when the pane is a column, height when
  // it is stacked above the list.
  function syncSeparatorAria(separator) {
    if (!separator || !separator.setAttribute) return;
    const axis = separatorAxis(separator);
    separator.setAttribute("aria-orientation", axis === "row" ? "horizontal" : "vertical");
    const rects = paneRects();
    const bounds = paneSizeBounds(axis, rects && rects.layout);
    if (!rects || !bounds) return;
    separator.setAttribute("aria-valuemin", String(bounds.min));
    separator.setAttribute("aria-valuemax", String(bounds.max));
    const current = axis === "row" ? (detailsPaneSize.height || Math.round(rects.details.height)) : (detailsPaneSize.width || Math.round(rects.details.width));
    separator.setAttribute("aria-valuenow", String(current));
  }

  // The details pane exists only for a single-commit selection. Zero
  // selection means the log is the view; two selections mean a compare
  // pair, and pairs open their own compare tab from the row menu, so the
  // pane hides instead of rendering placeholder content.
  function renderDetails(options) {
    const selected = options.selected || [];
    if (selected.length !== 1) return "";
    const esc = options.esc;
    const shell = (body) => `<aside class="git-ui-log-details" aria-label="Commit details">${body}</aside>`;
    const close = `<button type="button" aria-label="Clear commit selection" onclick="HerdrGitUi.clearLogSelection()">Close</button>`;
    const hash = String(selected[0]);
    const row = rowsFromData(options.data || {}).find((entry) => entry.hash === hash) || {};
    const preview = options.preview && options.preview.hash === hash ? options.preview : {};
    const details = preview.details && preview.details.hash === hash ? preview.details : {};
    const author = details.author || row.author || "Unknown author";
    const date = details.date || row.exact_date || row.date || "";
    const message = typeof details.message === "string" ? details.message : row.title || row.message || "";
    const labels = renderLabels(row.labels || [], row.current, esc, options.baseBranch);
    const loading = preview.detailsLoading ? `<p role="status">Loading commit details...</p>` : "";
    const error = preview.detailsError ? `<p class="git-ui-log-details-error" role="alert">${esc(preview.detailsError)}</p>` : "";
    const files = preview.diff && Array.isArray(preview.diff.files) ? preview.diff.files : null;
    let stats = "";
    if (files) {
      const totals = files.reduce((total, file) => {
        if (typeof file.additions === "number" && Number.isFinite(file.additions) && file.additions >= 0) total.additions += file.additions;
        if (typeof file.deletions === "number" && Number.isFinite(file.deletions) && file.deletions >= 0) total.deletions += file.deletions;
        return total;
      }, { additions: 0, deletions: 0 });
      const hasAdditions = files.some((file) => typeof file.additions === "number" && Number.isFinite(file.additions) && file.additions >= 0);
      const hasDeletions = files.some((file) => typeof file.deletions === "number" && Number.isFinite(file.deletions) && file.deletions >= 0);
      stats = `<p class="git-ui-log-details-stats">${files.length} changed ${files.length === 1 ? "file" : "files"}${hasAdditions ? ` · +${totals.additions} additions` : ""}${hasDeletions ? ` · -${totals.deletions} deletions` : ""}</p>`;
    }
    const webUrl = commitWebUrl(details.web_url);
    const link = webUrl ? `<a class="git-ui-log-details-link" href="${esc(webUrl)}" target="_blank" rel="noopener noreferrer">View on remote</a>` : "";
    const fileState = preview.loading ? `<p role="status">Loading changed files...</p>` : preview.error ? `<p class="git-ui-log-details-error" role="alert">${esc(preview.error)}</p>` : "";
    const filesHtml = options.preview && options.preview.hash === hash ? options.commitFilesHtml || "" : "";
    return shell(`<div class="git-ui-log-details-header"><h2>Commit details</h2>${close}</div><div class="git-ui-log-details-avatar" title="Author placeholder">${renderPerson(32)}</div><div class="git-ui-log-details-author">${esc(author)}</div>${date ? `<div class="git-ui-log-details-date">${esc(date)}</div>` : ""}${details.email ? `<div class="git-ui-log-details-email">${esc(details.email)}</div>` : ""}<div class="git-ui-log-details-hash"><code>${esc(hash)}</code>${copyButton(hash, "Commit id")}</div><div class="git-ui-log-details-labels">${labels}</div>${loading}${error}<pre class="git-ui-log-details-message">${esc(message)}</pre>${stats}<div class="git-ui-log-details-files">${filesHtml || fileState}</div><div class="git-ui-log-details-actions"><button type="button" onclick="HerdrGitUi.compareSelectedLog()">View Commit</button>${link}</div>`);
  }

  // The separator renders only with the pane (single selection). It sits
  // between the list and the details in DOM order; grid areas place it
  // between the two whichever side the pane lands on. Keyboard: arrows
  // resize along the live axis, Home resets to the CSS default.
  function detailsSeparator() {
    return `<div class="git-ui-log-separator" role="separator" aria-orientation="vertical" aria-label="Resize commit details" title="Drag to resize, double-click or press Home to reset" tabindex="0" onpointerdown="HerdrGitLog.beginDetailsResize(event)" onpointermove="HerdrGitLog.moveDetailsResize(event)" onpointerup="HerdrGitLog.endDetailsResize(event)" onpointercancel="HerdrGitLog.endDetailsResize(event)" ondblclick="HerdrGitLog.resetDetailsPaneSize()" onfocus="HerdrGitLog.syncSeparatorState()" onkeydown="HerdrGitLog.moveDetailsResizeKeyboard(event)"></div>`;
  }

  function upstreamRefFromStatus(status) {
    if (!status) return "";
    const upstream = String(status.upstream || "").trim();
    if (!upstream) return "";
    if (upstream.startsWith("refs/remotes/")) return upstream.replace(/^refs\/remotes\//, "");
    if (upstream.includes("/")) return upstream;
    return `origin/${upstream}`;
  }

  function isUpstreamTip(row, upstreamRef) {
    if (!upstreamRef || !row || !Array.isArray(row.labels)) return false;
    const labels = row.labels.map(normalizeLabel);
    if (row.current || labels.some((label) => label === "HEAD" || label.startsWith("HEAD -> "))) return false;
    return labels.includes(upstreamRef);
  }

  function renderLoadMore(data, rows, options, esc) {
    const count = logCommitCount(data || {}, rows || []);
    const limit = Number(data.limit || options.logLimit || count || 0);
    const hasMore = !!(data && data.has_more);
    const disabled = options.logLoadingMore ? "disabled" : "";
    const label = options.logLoadingMore ? "Loading more changes…" : "Load more changes";
    return `<div class="git-ui-log-load-more"><span>Showing ${esc(String(count))}${limit ? ` of ${esc(String(limit))} requested` : ""} commits</span><button class="git-ui-btn" onclick="HerdrGitUi.loadMoreLog()" ${hasMore ? disabled : "disabled"}>${hasMore ? label : "No more changes"}</button></div>`;
  }

  function renderFilterRow(filters, esc, scopeButton) {
    const input = (field, label) => `<label class="git-ui-log-filter" title="Filter ${label}"><span>${label}</span><input name="git-log-filter-${field}" aria-label="Filter ${label}" value="${esc(filters[field] || "")}" placeholder="Filter"${inputAttrs("search")} oninput="HerdrGitUi.setLogFilter('${field}',this.value)"></label>`;
    return `<div class="git-ui-log-filter-row"><span class="git-ui-log-filter-spacer">${scopeButton || ""}</span>${input("date", "Date")}${input("author", "Author")}</div>`;
  }

  function normalizeLogScope(scope) {
    return ["all", "base-current", "base"].includes(scope) ? scope : "all";
  }

  function logScopeLabel(scope, baseBranch) {
    const base = baseBranch || "master";
    if (scope === "base-current") return "Master + Branch";
    if (scope === "base") return "Branch";
    return "All";
  }

  // The log endpoint returns authoritative structured `rows`; the legacy
  // `lines` fallback (client-side porcelain parsing) is gone.
  function rowsFromData(data) {
    return Array.isArray(data && data.rows) ? data.rows : [];
  }

  // Seed columns from the tip rows, then walk each seed down through the
  // graph chars while the lane's column still carries a line segment. A
  // fold row (|/ or |\) ends the run: below it git re-uses the column for
  // a different branch, so painting through would mislabel that branch.
  // Returns [{ current: col|null, main: col|null }] indexed by row order.
  function computeLanePainting(rows, baseBranch) {
    const seeds = { current: null, main: null };
    const base = String(baseBranch || "master");
    for (const row of rows) {
      if (seeds.current === null && (row.current || (row.labels || []).some((label) => {
        const normalized = normalizeLabel(label);
        return normalized === "HEAD" || normalized.startsWith("HEAD -> ");
      }))) seeds.current = laneColumnOf(row);
      if (seeds.main === null) {
        const hasBase = (row.labels || []).some((label) => {
          const normalized = normalizeLabel(label);
          return normalized === base || normalized === `origin/${base}` || normalized === "main" || normalized === "origin/main" || normalized === "master" || normalized === "origin/master";
        });
        if (hasBase) seeds.main = laneColumnOf(row);
      }
      if (seeds.current !== null && seeds.main !== null) break;
    }
    let currentEnded = false;
    return rows.map((row) => {
      const current = seeds.current === null ? null : columnStillActive(row, seeds.current);
      const main = seeds.main === null ? null : columnStillActive(row, seeds.main);
      const mainTip = (row.labels || []).some((label) => labelKind(normalizeLabel(label), row.current, baseBranch) === "main");
      const currentTip = row.current || (row.labels || []).some((label) => {
        const normalized = normalizeLabel(label);
        return normalized === "HEAD" || normalized.startsWith("HEAD -> ");
      });
      if (currentTip) currentEnded = false;
      if (mainTip && main !== null && current === main && !currentTip) currentEnded = true;
      return { current: currentEnded ? null : current, main };
    });
  }

  function laneColumnOf(row) {
    const graph = String(row.graph || "");
    const star = graph.indexOf("*");
    if (star >= 0) return star;
    if (typeof row.lane === "number" && row.lane >= 0) return row.lane;
    const bar = graph.indexOf("|");
    return bar >= 0 ? bar : 0;
  }

  function columnStillActive(row, column) {
    const graph = String(row.graph || "");
    // Column positions are stable across rows even when git pads them with
    // trailing spaces, so index into the padded string.
    const ch = graph[column];
    if (ch === undefined) return null;
    if (ch === "*" || ch === "|") return column;
    return null;
  }

  function laneOverrideFor(painting, column) {
    if (!painting) return "";
    if (painting.current === column) return "var(--git-log-current, #ef4444)";
    if (painting.main === column) return "var(--git-log-main, #3b82f6)";
    return "";
  }

  function renderRow(row, index, selected, filters, options, baseBranch, lanePainting) {
    const painting = lanePainting ? lanePainting[index] : null;
    const esc = options.esc;
    const arg = options.arg;
    const hash = String(row.hash || "");
    const selectedClass = (hash && selected.includes(hash) ? " selected" : "") + (hash && hash === searchHash ? " git-ui-log-search-current" : "");
    const graphOnly = hash ? "" : " graph-only";
    const isCurrent = row.current || (Array.isArray(row.labels) && row.labels.some((label) => normalizeLabel(label) === "HEAD" || normalizeLabel(label).startsWith("HEAD -> ")));
    const currentClass = isCurrent ? " current" : "";
    const upstreamTip = isUpstreamTip(row, options.upstreamRef) ? " origin-tip" : "";
    const lane = row.lane;
    const color = laneColor(lane);
    const title = row.title || row.message || "";
    const filterText = filterFields(row);
    const nonmatch = !hash || matchesFilters(filterText, filters) ? "" : " git-ui-log-nonmatch";
    const click = hash ? ` role="button" tabindex="0" aria-pressed="${selected.includes(hash)}" onclick="HerdrGitUi.selectLogCommit(event,'${arg(hash)}')" onkeydown="if(event.target===this&&['Enter',' ','Spacebar'].includes(event.key)){event.preventDefault();event.stopPropagation();HerdrGitUi.selectLogCommit(event,'${arg(hash)}')}" oncontextmenu="HerdrGitUi.openLogContextMenu(event,'${arg(hash)}');return false"` : "";
    const hover = renderHover(row, color, esc, baseBranch);
    const tooltip = hoverText(row);
    return `<div class="git-ui-log-row${selectedClass}${graphOnly}${currentClass}${upstreamTip}${nonmatch}" data-log-hash="${esc(hash)}" data-log-filter-description="${esc(filterText.description)}" data-log-filter-date="${esc(filterText.date)}" data-log-filter-author="${esc(filterText.author)}" style="--lane:${color}" title="${esc(tooltip)}"${click}><span class="git-ui-log-cell-refs">${renderCompactLabels(row.labels || [], row.current, esc, baseBranch)}</span>${renderGraph(row.graph, !!hash, upstreamTip, isCurrent, painting)}<span class="git-ui-log-cell-description git-ui-log-desc"><span class="git-ui-log-title">${esc(title)}</span></span><span class="git-ui-log-cell-date git-ui-log-date">${esc(row.date || "")}</span><span class="git-ui-log-cell-author git-ui-log-author">${hash ? `<span class="git-ui-log-author-avatar">${renderPerson(16)}</span>` : ""}${esc(row.author || "")}</span><span class="git-ui-log-cell-hash">${esc(hash.slice(0, 7))}</span>${hover}</div>`;
  }

  function renderHover(row, color, esc, baseBranch) {
    if (!row.hash) return "";
    const labels = row.labels || [];
    const message = row.title || row.message || "";
    const date = row.exact_date || row.date || "";
    const author = row.author || "";
    const copyButton = (value, kind) => `<button class="git-ui-log-copy-hash" title="Copy ${esc(kind)}" aria-label="Copy ${esc(kind)}" onclick="HerdrGitUi.copyScopeValue(event,'${jsArg(value)}','${jsArg(kind)}')">⧉</button>`;
    // Labeled field rows: every value (commit id, each tag, author, date)
    // carries its own copy command. Tags are the "tag: x" decorations git
    // puts in %D; other labels (branches, remotes) stay in the chip row
    // where they already copy per chip.
    const field = (label, valueHtml, copy) => `<div class="git-ui-log-hover-field"><span class="git-ui-log-hover-field-label">${label}</span><span class="git-ui-log-hover-field-value">${valueHtml}${copy || ""}</span></div>`;
    const tags = labels.map((label) => String(label || "").trim()).filter((label) => TAG_LABEL.test(label)).map((label) => label.replace(TAG_LABEL, ""));
    const tagChips = tags.map((tag) => `<span class="git-ui-log-hover-tag">${esc(tag)}${copyButton(tag, "Tag " + tag)}</span>`).join("");
    // Tags now live in their own labeled row, so drop them from the chip
    // row to avoid showing each tag twice.
    const chipLabels = labels.filter((label) => !TAG_LABEL.test(String(label || "").trim()));
    return `<div class="git-ui-log-hover-card" style="--lane:${color}" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()">${chipLabels.length ? `<div class="git-ui-log-hover-labels">${chipLabels.map((label) => renderLabel(label, row.current, esc, baseBranch)).join("")}</div>` : ""}<div class="git-ui-log-hover-message">${esc(message)}${message ? copyButton(message, "Commit message") : ""}</div>${field("Commit id", `<strong>${esc(row.hash)}</strong>`, copyButton(row.hash, "Commit id"))}${field("Tags", tagChips || "<span class=\"git-ui-log-hover-empty\">None</span>", "")}${field("Author", esc(author) || "<span class=\"git-ui-log-hover-empty\">Unknown</span>", author ? copyButton(author, "Author") : "")}${field("Date", esc(date) || "<span class=\"git-ui-log-hover-empty\">Unknown</span>", date ? copyButton(date, "Date") : "")}</div>`;
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
      next[field] = String(filters[field] || "").trim();
      return next;
    }, {});
  }

  function matchesFilters(text, filters) {
    return FILTER_FIELDS.every((field) => {
      const needle = filters[field];
      const value = String(text[field] || "");
      return !needle || (searchCaseSensitive ? value.includes(needle) : value.toLowerCase().includes(needle.toLowerCase()));
    });
  }

  function applyFilters(filters) {
    const normalized = normalizeFilters(filters || {});
    activeFilters = normalized;
    searchPosition = -1;
    searchHash = "";
    for (const row of document.querySelectorAll(".git-ui-log-row")) {
      const text = FILTER_FIELDS.reduce((next, field) => {
        next[field] = row.dataset[`logFilter${field[0].toUpperCase()}${field.slice(1)}`] || "";
        return next;
      }, {});
      const matches = !row.dataset.logHash || matchesFilters(text, normalized);
      row.hidden = false;
      row.classList.toggle("git-ui-log-nonmatch", !matches);
      row.classList.toggle("git-ui-log-search-current", false);
    }
    updateSearchControls();
  }

  function matchingSearchRows() {
    return Array.from(document.querySelectorAll(".git-ui-log-row")).filter((row) => {
      if (!row.dataset.logHash) return false;
      const text = FILTER_FIELDS.reduce((fields, field) => {
        fields[field] = row.dataset[`logFilter${field[0].toUpperCase()}${field.slice(1)}`] || "";
        return fields;
      }, {});
      return matchesFilters(text, activeFilters);
    });
  }

  function updateSearchControls() {
    const matches = matchingSearchRows();
    for (const count of document.querySelectorAll(".git-ui-log-search-count")) count.textContent = `${searchPosition >= 0 ? searchPosition + 1 : 0} / ${matches.length}`;
    for (const button of document.querySelectorAll(".git-ui-log-search-previous, .git-ui-log-search-next")) button.disabled = !matches.length;
    for (const button of document.querySelectorAll(".git-ui-log-search-case")) button.setAttribute("aria-pressed", String(searchCaseSensitive));
    return matches;
  }

  function toggleSearchCase() {
    searchCaseSensitive = !searchCaseSensitive;
    applyFilters(activeFilters);
  }

  function setSearch(value) {
    const query = String(value || "");
    if (window.HerdrGitUi && typeof window.HerdrGitUi.setLogFilter === "function") {
      window.HerdrGitUi.setLogFilter("description", query);
    } else {
      applyFilters(Object.assign({}, activeFilters, { description: query }));
    }
  }

  function navigateSearch(direction) {
    const matches = matchingSearchRows();
    if (!matches.length) return;
    searchPosition = searchPosition < 0 ? (direction < 0 ? matches.length - 1 : 0) : (searchPosition + (direction < 0 ? -1 : 1) + matches.length) % matches.length;
    searchHash = matches[searchPosition].dataset.logHash;
    for (const row of document.querySelectorAll(".git-ui-log-row")) row.classList.toggle("git-ui-log-search-current", row === matches[searchPosition]);
    const target = matches[searchPosition];
    target.scrollIntoView({ block: "nearest" });
    const content = target.closest && target.closest(".git-ui-content");
    if (content) {
      const viewport = content.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      let visibleTop = viewport.top;
      const overlays = Array.from(content.querySelectorAll(".git-ui-log-searchbar, .git-ui-log-table-head, .git-ui-log-details"))
        .filter((node) => !node.hidden)
        .map((node) => node.getBoundingClientRect())
        .filter((overlay) => overlay.right > rect.left && overlay.left < rect.right && overlay.bottom > viewport.top && overlay.top < viewport.bottom)
        .sort((a, b) => a.top - b.top);
      for (const overlay of overlays) {
        if (overlay.top <= visibleTop + 1) visibleTop = Math.max(visibleTop, overlay.bottom);
      }
      if (rect.top < visibleTop) content.scrollTop -= visibleTop - rect.top;
    }
    updateSearchControls();
  }

  function renderCompactLabels(labels, current, esc, baseBranch) {
    if (labels.length < 2) return renderLabels(labels, current, esc, baseBranch);
    const primary = labels.find((label) => labelKind(normalizeLabel(label), current, baseBranch) === "current") || labels[0];
    const remaining = labels.filter((label, index) => index !== labels.indexOf(primary));
    return `<span class="git-ui-log-ref-group" onclick="event.stopPropagation()">${renderLabel(primary, current, esc, baseBranch)}<button type="button" class="git-ui-log-ref-toggle" aria-expanded="false" aria-label="Show ${remaining.length} more references" onclick="HerdrGitLog.toggleRefs(this,event)">+${remaining.length}</button><span class="git-ui-log-ref-overflow" hidden>${renderLabels(remaining, current, esc, baseBranch)}</span></span>`;
  }

  function toggleRefs(button, event) {
    if (event) event.stopPropagation();
    const group = button.closest(".git-ui-log-ref-group");
    const overflow = group && group.querySelector(".git-ui-log-ref-overflow");
    if (!overflow) return;
    overflow.hidden = !overflow.hidden;
    button.setAttribute("aria-expanded", String(!overflow.hidden));
    button.setAttribute("aria-label", overflow.hidden ? "Show more references" : "Hide additional references");
    group.classList.toggle("expanded", !overflow.hidden);
  }

  function renderLabels(labels, current, esc, baseBranch) {
    return `<span class="git-ui-log-labels">${labels.map((label) => renderLabel(label, current, esc, baseBranch)).join("")}</span>`;
  }

  function renderLabel(label, current, esc, baseBranch) {
    const normalized = normalizeLabel(label);
    const kind = labelKind(normalized, current, baseBranch);
    // jsArg: branch names may contain ' (git refnames allow it), and the
    // value lands in a single-quoted JS string inside an onclick attribute.
    const copy = `<button class="git-ui-log-copy-label" title="Copy ${esc(kind)}" onclick="HerdrGitUi.copyScopeValue(event,'${jsArg(normalized)}','${kind}')">⧉</button>`;
    return `<span class="git-ui-log-ref ${kind}" title="${esc(normalized)}">${esc(normalized)}${copy}</span>`;
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
    if (label.startsWith("origin/") && label !== "origin/HEAD") return "origin";
    if (label.includes("/")) return "remote";
    return "branch";
  }

  function selectedBranchForHash(data, hash, baseBranch) {
    hash = String(hash || "");
    if (!hash) return "";
    const row = rowsFromData(data || {}).find((item) => String(item.hash || "") === hash);
    return branchForRow(row, baseBranch);
  }

  function branchForRow(row, baseBranch) {
    const labels = (row && row.labels) || [];
    for (const label of labels) {
      const normalized = normalizeLabel(label);
      if (normalized.startsWith("HEAD -> ")) {
        const branch = normalized.slice("HEAD -> ".length).trim();
        if (branch && !branch.startsWith("origin/HEAD")) return branch;
      }
    }
    const branches = labels.map(normalizeLabel).filter((label) => isBranchLabel(label, baseBranch));
    return branches[0] || "";
  }

  function isBranchLabel(label, baseBranch) {
    if (!label || label === "HEAD" || label.startsWith("tag:")) return false;
    if (label.includes(" -> ")) return false;
    if (label === "origin/HEAD") return false;
    return labelKind(label, false, baseBranch) !== "tag";
  }

  function renderGraph(graph, hasCommit, upstreamTip, isCurrent, painting) {
    const chars = String(graph || (hasCommit ? "* " : "")).split("");
    const dotClasses = ["git-ui-log-dot"];
    if (upstreamTip) dotClasses.push("origin");
    if (isCurrent) dotClasses.push("head");
    const dotClass = ` class="${dotClasses.join(" ")}"`;
    const paths = [];
    const nodes = [];
    for (let i = 0; i < Math.min(chars.length, 24); i++) {
      const ch = chars[i];
      const position = 8 + i * 8;
      const lane = laneOverrideFor(painting, i) || laneColor(i);
      let path = "";
      if (ch === "*") {
        path = `M${position} 0V26`;
        nodes.push(`<circle${dotClass} cx="${position}" cy="13" r="3.5" fill="var(--panel)" stroke="${lane}" stroke-width="1.5"/>`);
      } else if (ch === "|") path = `M${position} 0V26`;
      else if (ch === "/") path = `M${position + 8} 0C${position + 8} 13 ${position - 8} 13 ${position - 8} 26`;
      else if (ch === "\\") path = `M${position - 8} 0C${position - 8} 13 ${position + 8} 13 ${position + 8} 26`;
      else if (ch === "_" || ch === "-" || ch === ".") path = `M${position - 8} 13H${position + 8}`;
      if (path) paths.push(`<path class="git-ui-log-graph-path" d="${path}" stroke="${lane}" stroke-width="1.5" fill="none"/>`);
    }
    if (hasCommit && !String(graph || "").includes("*")) {
      nodes.push(`<circle${dotClass} cx="8" cy="13" r="3.5" fill="var(--panel)" stroke="${laneOverrideFor(painting, 0) || laneColor(0)}" stroke-width="1.5"/>`);
    }
    const width = Math.max(24, Math.min(chars.length, 24) * 8 + 16);
    return `<span class="git-ui-log-cell-graph git-ui-log-graph" aria-hidden="true"><svg width="${width}" height="26" viewBox="0 0 ${width} 26" preserveAspectRatio="none">${paths.join("")}${nodes.join("")}</svg></span>`;
  }

  function laneColor(index) {
    const lane = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
    return LANE_COLORS[lane % LANE_COLORS.length];
  }

  function scrollToCommit(hash) {
    const nodes = Array.from(document.querySelectorAll(".git-ui-log-row[data-log-hash]"));
    const target = nodes.find((node) => (node.dataset.logHash || "").startsWith(hash));
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  window.HerdrGitLog = { render, scrollToCommit, rowsFromData, laneColor, applyFilters, logCommitCount, selectedBranchForHash, computeLanePainting, renderDetails, toggleSearchCase, navigateSearch, toggleRefs, setSearch, beginDetailsResize, moveDetailsResize, endDetailsResize, moveDetailsResizeKeyboard, resetDetailsPaneSize, syncSeparatorState, detailsState: () => ({ size: Object.assign({}, detailsPaneSize), resizing: !!detailsResize }) };
})();
