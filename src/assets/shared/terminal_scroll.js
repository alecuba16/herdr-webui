(function (root) {
  function usesNormalBuffer(term) {
    try {
      return (
        !term ||
        !term.buffer ||
        !term.buffer.active ||
        term.buffer.active.type !== "alternate"
      );
    } catch (_) {
      return true;
    }
  }

  function rowHeight(term) {
    return cellSize(term).height;
  }

  function cellSize(term) {
    const cell =
      term &&
      term._core &&
      term._core._renderService &&
      term._core._renderService.dimensions &&
      term._core._renderService.dimensions.css &&
      term._core._renderService.dimensions.css.cell;
    return {
      width: Math.max(1, (cell && cell.width) || 9),
      height: Math.max(1, (cell && cell.height) || 17),
    };
  }

  function cssPixels(value) {
    const parsed = Number.parseFloat(value || "0");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function contentBoxSize(element) {
    if (!element) return { width: 0, height: 0 };
    const rect =
      typeof element.getBoundingClientRect === "function"
        ? element.getBoundingClientRect()
        : { width: 0, height: 0 };
    let width = Math.max(0, Number(element.clientWidth) || Number(rect.width) || 0);
    let height = Math.max(0, Number(element.clientHeight) || Number(rect.height) || 0);
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(element);
      width -= cssPixels(style.paddingLeft) + cssPixels(style.paddingRight);
      height -= cssPixels(style.paddingTop) + cssPixels(style.paddingBottom);
    }
    return {
      width: Math.max(0, Math.floor(width)),
      height: Math.max(0, Math.floor(height)),
    };
  }

  function fitSize(element, term, options) {
    const minCols = Math.max(1, (options && options.minCols) || 1);
    const minRows = Math.max(1, (options && options.minRows) || 1);
    const content = contentBoxSize(element);
    const cell = cellSize(term);
    const fitCols = Math.max(1, Math.floor(content.width / cell.width));
    const fitRows = Math.max(1, Math.floor(content.height / cell.height));
    const cols = Math.max(minCols, fitCols);
    const rows = Math.max(minRows, fitRows);
    return {
      cols,
      rows,
      cellWidth: cell.width,
      cellHeight: cell.height,
      contentWidth: content.width,
      contentHeight: content.height,
      width: Math.ceil(cell.width * cols),
      height: Math.ceil(cell.height * rows),
    };
  }

  function wheelLines(term, event, pageRows) {
    const unit =
      event.deltaMode === 1
        ? 1
        : event.deltaMode === 2
          ? pageRows || 24
          : Math.max(1, rowHeight(term));
    return Math.max(1, Math.round(Math.abs(event.deltaY) / unit));
  }

  function touchLines(term, deltaY) {
    return Math.max(
      1,
      Math.round(Math.abs(deltaY) / Math.max(1, rowHeight(term))),
    );
  }

  function scrollLocal(term, direction, lines, afterScroll) {
    let scrolled = false;
    try {
      if (!term) return false;
      if (typeof term.scrollLines === "function") {
        term.scrollLines(direction === "up" ? -lines : lines);
        scrolled = true;
      } else if (
        typeof term.scrollToLine === "function" &&
        term.buffer &&
        term.buffer.active
      ) {
        const buffer = term.buffer.active;
        const maxLine = Math.max(0, Number(buffer.baseY) || 0);
        const currentLine = Math.max(0, Number(buffer.viewportY) || 0);
        const nextLine = Math.max(
          0,
          Math.min(maxLine, currentLine + (direction === "up" ? -lines : lines)),
        );
        term.scrollToLine(nextLine);
        scrolled = true;
      } else {
        return false;
      }
    } catch (_) {}
    if (!scrolled) return false;
    if (typeof afterScroll === "function") afterScroll();
    return true;
  }

  const terminalScroll = {
    usesNormalBuffer,
    rowHeight,
    cellSize,
    contentBoxSize,
    fitSize,
    wheelLines,
    touchLines,
    scrollLocal,
  };

  root.HerdrTerminalScroll = terminalScroll;
  if (typeof module !== "undefined" && module.exports)
    module.exports = terminalScroll;
})(typeof globalThis !== "undefined" ? globalThis : window);
