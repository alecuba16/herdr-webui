// Compatibility shim for older cached app-boot.js files. Current boot does not
// load this asset; active terminal scroll handling lives in terminal_adapter.js.
(function (root) {
  function usesNormalBuffer(term) {
    try {
      return !term || typeof term.usesNormalBuffer !== "function" || term.usesNormalBuffer();
    } catch (_) {
      return true;
    }
  }

  function rowHeight(term) {
    try {
      if (term && typeof term.rowHeight === "function") return term.rowHeight();
    } catch (_) {}
    return 17;
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
    try {
      if (!term || typeof term.scrollLines !== "function") return false;
      term.scrollLines(direction === "up" ? -lines : lines);
    } catch (_) {
      return false;
    }
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
