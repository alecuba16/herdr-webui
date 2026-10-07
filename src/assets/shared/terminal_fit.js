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

  // Cached cell metrics. Cell geometry only changes when the terminal
  // font family/size or the renderer grid changes, not per resize frame.
  // Re-measuring (querySelector + getBoundingClientRect) on every frame of
  // a resize drag forced layout on each one; the cache collapses it to one
  // measurement per actual font/core change.
  var cachedCellContainer = null;
  var cachedCell = null;

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
    if (adapterCell && adapterCell.width > 0 && adapterCell.height > 0) return adapterCell;
    if (
      container === cachedCellContainer &&
      cachedCell &&
      cachedCell.width > 0 &&
      cachedCell.height > 0
    ) {
      return cachedCell;
    }
    var measured = measuredCell(container);
    var cell = {
      width: measured.width || fb.width || 9,
      height: measured.height || fb.height || 17,
    };
    if (cell.width > 0 && cell.height > 0) {
      cachedCellContainer = container;
      cachedCell = cell;
    }
    return cell;
  }

  // Drop the cached cell metrics (e.g. after a font family/size change or a
  // renderer rebuild) so the next cellSize() re-measures.
  function invalidateCellSizeCache() {
    cachedCellContainer = null;
    cachedCell = null;
  }

  function gridSize(container, term, options) {
    var opts = options || {};
    var box = visibleBox(container, {
      width: opts.fallbackWidth || 720,
      height: opts.fallbackHeight || 420,
    }) || { width: 0, height: 0 };
    var cell = cellSize(term, container, opts.fallbackCell || { width: 9, height: 17 });
    // clientWidth/clientHeight include the container's own padding, but the
    // terminal surface renders inside it. Callers that pad the shell (the
    // mobile shell has 8px) pass paddingX/paddingY so cols/rows use the
    // content box, not the border box.
    var padX = opts.paddingX || 0;
    var padY = opts.paddingY || 0;
    if (typeof getComputedStyle === "function") {
      var style = getComputedStyle(container);
      if (opts.paddingX == null) padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      if (opts.paddingY == null) padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    }
    var width = Math.max(0, box.width - padX);
    var height = Math.max(0, box.height - padY);
    return {
      cols: Math.max(opts.minCols || 40, Math.floor(width / Math.max(1, cell.width))),
      rows: Math.max(opts.minRows || 8, Math.floor(height / Math.max(1, cell.height)) - (opts.rowReserve || 0)),
      width: box.width,
      height: box.height,
      cell: cell,
    };
  }

  function setStyleIfChanged(element, prop, value) {
    if (element.style[prop] !== value) element.style[prop] = value;
  }

  function fitTerminalToContainer(container, options) {
    var opts = options || {};
    if (!container || !container.style) return;
    var height = Math.floor(opts.height || container.clientHeight || 0);
    var heightPx = height > 0 ? height + "px" : "";
    // Write-if-changed: this runs on resize frames and redundant style
    // writes invalidate layout even when the value is identical.
    setStyleIfChanged(container, "width", opts.width ? Math.floor(opts.width) + "px" : (container.style.width || "100%"));
    setStyleIfChanged(container, "height", heightPx || container.style.height || "100%");
    setStyleIfChanged(container, "maxHeight", heightPx || "");
    setStyleIfChanged(container, "minWidth", opts.minWidth || "0");
    setStyleIfChanged(container, "minHeight", opts.minHeight || "0");
    setStyleIfChanged(container, "overflow", opts.overflow || "");
    setStyleIfChanged(container, "overflowX", opts.overflowX || "hidden");
    setStyleIfChanged(container, "overflowY", opts.overflowY || "auto");
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
    invalidateCellSizeCache: invalidateCellSizeCache,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTerminalFit;
})(typeof globalThis !== "undefined" ? globalThis : window);
