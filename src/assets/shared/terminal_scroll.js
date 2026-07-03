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
    return (
      term &&
      term._core &&
      term._core._renderService &&
      term._core._renderService.dimensions &&
      term._core._renderService.dimensions.css &&
      term._core._renderService.dimensions.css.cell &&
      term._core._renderService.dimensions.css.cell.height
    ) || 17;
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
    wheelLines,
    touchLines,
    scrollLocal,
  };

  root.HerdrTerminalScroll = terminalScroll;
  if (typeof module !== "undefined" && module.exports)
    module.exports = terminalScroll;
})(typeof globalThis !== "undefined" ? globalThis : window);
