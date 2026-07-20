(function () {
  // xterm.js can answer application terminal queries by emitting control
  // strings through `onData`. In WebUI that data would otherwise travel back
  // over the terminal WebSocket and be interpreted as shell input. Native
  // terminal apps consume these replies internally. The browser needs an
  // explicit sanitation boundary before forwarding xterm data to the backend.
  const C0_ESC = "\x1b";
  const STRING_CONTROL_REPLY_RE = /\x1b[\]PX_^][\s\S]*?(?:\x07|\x1b\\)/g;
  const BROKEN_COLOR_REPLY_RE = /(?:\x1b\])?(?:(?:1[0-9])|4;\d{1,3});rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\|\\)?/g;
  const CSI_REPLY_RE = /\x1b\[[?=>]?(?:\d{1,4}(?:;\d{0,4})*)?(?:R|n|c|t)|\x1b\[[?=>]?(?:\d{1,4}(?:;\d{0,4})*)?\$y/g;

  function stripTerminalQueryReplies(data) {
    return String(data || "")
      .replace(STRING_CONTROL_REPLY_RE, "")
      .replace(BROKEN_COLOR_REPLY_RE, "")
      .replace(CSI_REPLY_RE, "");
  }

  globalThis.HerdrTerminalFilter = {
    stripTerminalQueryReplies,
    coverage: {
      stringControls: "OSC, DCS, SOS, PM, APC replies terminated by BEL or ST",
      csi: "CPR/DSR/DA/window/mode report replies ending in R, n, c, t, or $y",
      brokenColors: "Legacy/truncated OSC 4 and OSC 10-19 rgb color replies seen without the ESC introducer",
    },
    C0_ESC,
  };
})();
