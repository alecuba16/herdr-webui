(function (root) {
  function visibleBox(element, fallback) {
    var box = fallback || { width: 0, height: 0 };
    if (!element) return box;
    var style = typeof getComputedStyle === "function"
      ? getComputedStyle(element)
      : { display: "", visibility: "" };
    var rects = typeof element.getClientRects === "function" ? element.getClientRects() : null;
    if (style.display === "none" || style.visibility === "hidden" || (rects && rects.length === 0))
      return null;
    var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    return {
      width: Math.max(0, Math.floor(element.clientWidth || (rect && rect.width) || box.width || 0)),
      height: Math.max(0, Math.floor(element.clientHeight || (rect && rect.height) || box.height || 0)),
    };
  }

  function measuredCell(container) {
    var adapter = container && container.__herdrTerminalAdapter;
    if (adapter && typeof adapter.cellSize === "function") return adapter.cellSize();
    var row = container && container.querySelector && container.querySelector(".term-row");
    var span = row && row.querySelector && row.querySelector("span");
    var spanRect = span && span.getBoundingClientRect && span.getBoundingClientRect();
    var rowRect = row && row.getBoundingClientRect && row.getBoundingClientRect();
    return {
      width: spanRect && spanRect.width > 2 ? spanRect.width / Math.max(1, (span.textContent || "").length || 1) : 0,
      height: rowRect && rowRect.height > 8 ? rowRect.height : 0,
    };
  }

  function cellSize(term, container, fallback) {
    var fb = fallback || { width: 9, height: 17 };
    var adapterCell = term && typeof term.cellSize === "function" ? term.cellSize() : null;
    var measured = measuredCell(container);
    return {
      width: (adapterCell && adapterCell.width) || measured.width || fb.width || 9,
      height: (adapterCell && adapterCell.height) || measured.height || fb.height || 17,
    };
  }

  function gridSize(container, term, options) {
    var opts = options || {};
    var box = visibleBox(container, {
      width: opts.fallbackWidth || 720,
      height: opts.fallbackHeight || 420,
    }) || { width: 0, height: 0 };
    var cell = cellSize(term, container, opts.fallbackCell || { width: 9, height: 17 });
    var width = Math.max(0, box.width - (opts.paddingX || 0));
    var height = Math.max(0, box.height - (opts.paddingY || 0));
    return {
      cols: Math.max(opts.minCols || 40, Math.floor(width / Math.max(1, cell.width))),
      rows: Math.max(opts.minRows || 8, Math.floor(height / Math.max(1, cell.height)) - (opts.rowReserve || 0)),
      width: box.width,
      height: box.height,
      cell: cell,
    };
  }

  function fitTerminalToContainer(container, options) {
    var opts = options || {};
    if (!container || !container.style) return;
    var height = Math.floor(opts.height || container.clientHeight || 0);
    var heightPx = height > 0 ? height + "px" : "";
    container.style.width = opts.width ? Math.floor(opts.width) + "px" : container.style.width || "100%";
    container.style.height = heightPx || container.style.height || "100%";
    container.style.maxHeight = heightPx || "";
    container.style.minWidth = opts.minWidth || "0";
    container.style.minHeight = opts.minHeight || "0";
    container.style.overflow = opts.overflow || "";
    container.style.overflowX = opts.overflowX || "hidden";
    container.style.overflowY = opts.overflowY || "auto";
  }

  function afterLayout(callback) {
    var raf = root.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); };
    raf(function () { raf(function () { setTimeout(callback, 0); }); });
  }

  root.HerdrTerminalFit = {
    visibleBox: visibleBox,
    cellSize: cellSize,
    gridSize: gridSize,
    fitTerminalToContainer: fitTerminalToContainer,
    afterLayout: afterLayout,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTerminalFit;
})(typeof globalThis !== "undefined" ? globalThis : window);
