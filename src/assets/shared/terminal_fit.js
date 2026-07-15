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

  function rendererCell(term) {
    return term && term._core && term._core._renderService && term._core._renderService.dimensions && term._core._renderService.dimensions.css && term._core._renderService.dimensions.css.cell;
  }

  function measuredCell(container) {
    var measure = container && container.querySelector && container.querySelector(".xterm-char-measure-element");
    var measureRect = measure && measure.getBoundingClientRect && measure.getBoundingClientRect();
    var row = container && container.querySelector && container.querySelector(".xterm-rows > div");
    var rowRect = row && row.getBoundingClientRect && row.getBoundingClientRect();
    return {
      width: measureRect && measureRect.width > 2 ? measureRect.width : 0,
      height: rowRect && rowRect.height > 8 ? rowRect.height : 0,
    };
  }

  function cellSize(term, container, fallback) {
    var fb = fallback || { width: 9, height: 17 };
    var rendered = rendererCell(term) || {};
    var measured = measuredCell(container);
    return {
      width: rendered.width || measured.width || fb.width || 9,
      height: rendered.height || measured.height || fb.height || 17,
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

  function fitXtermToContainer(container, options) {
    var opts = options || {};
    if (!container || !container.querySelector) return;
    var height = Math.floor(opts.height || container.clientHeight || 0);
    var heightPx = height > 0 ? height + "px" : "";
    var xterm = container.querySelector(".xterm");
    if (xterm) {
      xterm.style.width = "100%";
      xterm.style.height = heightPx || "100%";
      xterm.style.maxHeight = heightPx || "";
      xterm.style.minWidth = "0";
      xterm.style.minHeight = "0";
      xterm.style.overflow = "hidden";
    }
    var viewport = container.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.style.left = "0";
      viewport.style.right = "0";
      if (heightPx) {
        viewport.style.height = heightPx;
        viewport.style.maxHeight = heightPx;
      }
    }
    if (!heightPx) return;
    var screen = container.querySelector(".xterm-screen");
    if (screen) {
      screen.style.height = heightPx;
      screen.style.maxHeight = heightPx;
      screen.style.overflow = "hidden";
    }
    var helpers = container.querySelector(".xterm-helpers");
    if (helpers) {
      helpers.style.maxHeight = heightPx;
      helpers.style.overflow = "hidden";
    }
    var canvasNodes = container.querySelectorAll && container.querySelectorAll(".xterm-screen canvas");
    if (canvasNodes) {
      for (var i = 0; i < canvasNodes.length; i++) canvasNodes[i].style.maxHeight = heightPx;
    }
  }

  function afterLayout(callback) {
    var raf = root.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); };
    raf(function () { raf(function () { setTimeout(callback, 0); }); });
  }

  root.HerdrTerminalFit = {
    visibleBox: visibleBox,
    cellSize: cellSize,
    gridSize: gridSize,
    fitXtermToContainer: fitXtermToContainer,
    afterLayout: afterLayout,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTerminalFit;
})(typeof globalThis !== "undefined" ? globalThis : window);
