(function () {
  // xterm.js can answer terminal queries by emitting control strings through
  // `onData`. Complete CSI replies must reach the backend because TUI apps
  // like Jcode query cursor position during startup/resume. The browser still
  // needs a sanitation boundary for string-control replies and broken reply
  // tails that can otherwise become shell input.
  const C0_ESC = "\x1b";
  const STRING_CONTROL_REPLY_RE = /\x1b[\]PX_^][\s\S]*?(?:\x07|\x1b\\)/g;
  const BROKEN_COLOR_REPLY_RE = /(?:\x1b\])?(?:(?:1[0-9])|4;\d{1,3});rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\|\\)?/g;
  const ORPHAN_CPR_TAIL_RE = /^(?:\d{1,4})?;\d{1,4}R/;
  const TRAILING_INCOMPLETE_CSI_RE = /\x1b\[[?=>]?(?:\d{0,4}(?:;\d{0,4})*)?$/;
  let pendingCsiPrefix = "";

  function stripTerminalQueryReplies(data) {
    let text = pendingCsiPrefix + String(data || "");
    pendingCsiPrefix = "";
    text = text.replace(TRAILING_INCOMPLETE_CSI_RE, (match) => {
      pendingCsiPrefix = match;
      return "";
    });
    return text
      .replace(STRING_CONTROL_REPLY_RE, "")
      .replace(BROKEN_COLOR_REPLY_RE, "")
      .replace(ORPHAN_CPR_TAIL_RE, "");
  }

  globalThis.HerdrTerminalFilter = {
    stripTerminalQueryReplies,
    coverage: {
      stringControls: "OSC, DCS, SOS, PM, APC replies terminated by BEL or ST",
      csi: "Complete CSI replies are forwarded so terminal apps can read CPR/DA/DSR; only orphan CPR tails like ;1R or 24;80R are stripped",
      brokenColors: "Legacy/truncated OSC 4 and OSC 10-19 rgb color replies seen without the ESC introducer",
    },
    C0_ESC,
  };
})();
