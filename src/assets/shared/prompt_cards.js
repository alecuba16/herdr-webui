// Prompt-card parsing and server-prompt payload handling.
//
// desktop/app_js/prompt_cards.js and mobile/composer.js kept two copies of
// this parser (ported with drift-prone comments, same logic). The shared
// module owns the pure parts: the terminal-tail parser (numbered option
// dialogs, free-text questions, nav hints, jcode chooser/permissions guards)
// and the server-prompt payload plumbing (fresh-window bookkeeping with a
// sticky-off endpoint). Hosts keep their own state access, api resolution,
// card rendering, and key-synthesis; createServerPromptStore() hands back
// fetch/fresh/fromServer bound to the host's request function.
(function (root) {
  const OPTION_LINE = /^[>\s]*([0-9]+)[.)]\s+(.+)$/;
  const NAV_HINT = /↑↓\s*select|↑\/↓/;
  const FREE_TEXT = /enter your response|type your answer|enter send/i;
  const QUESTION_LINE = /^\s*(?:❯|›|➜|\$)\s*(.+?)(?:\?+)?\s*$|^\s*\?+\s*(.+)$/;
  // jcode ask_user chooser (ui_inline.rs): its hint lines carry "Enter
  // sends ..." and "Type your own answer", which the generic FREE_TEXT
  // regex mistakes for a free-text dialog, and a shell tail above the
  // chooser then becomes the "title". The chooser renders its own
  // numbered rows plus an "N. Your answer" entry; it is its own answer
  // surface, so parse nothing here.
  const JCODE_CHOOSER = /1-9 or ↑↓ \+ Enter to choose|type on Your answer|\. Your answer/i;
  // jcode Permissions viewer markers, the same lines the backend's
  // jcode_blocked detector scrapes. Both the help row and the waiting
  // line must be present: transcript or docs text quoting one of them
  // is not a live viewer.
  const JCODE_VIEWER_HELP = /a approve.*d deny.*A approve all.*D deny all/i;
  const JCODE_VIEWER_WAITING = /agent is waiting for this decision/i;
  const JCODE_VIEWER_TITLE = /permissions?\s*\((\d+)\s*pending\)/i;
  const CONFIRM_HINT = /enter (?:to )?(?:confirm|select|choose|submit)|press enter|return to (?:confirm|select)/i;

  const SERVER_PROMPT_FRESH_MS = 15000;
  const SERVER_PROMPT_FETCH_MS = 750;

  // Prefer the LAST line that reads like a question (ends with "?" or
  // starts with "? "): real dialogs ask their question above the
  // options. Prompt-marked captures come next; they can contain shell
  // echo noise, so they are a weaker signal.
  function questionTitle(lines) {
    const clean = (s) => s.replace(/^[❯›➜$?]+\s*/, "").replace(/[?]+$/, "").trim();
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t || OPTION_LINE.test(t) || NAV_HINT.test(t) || FREE_TEXT.test(t) || /^esc /i.test(t)) continue;
      if (/[?]$/.test(t) || /^\?\s/.test(t)) return clean(t);
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(QUESTION_LINE);
      if (m && (m[1] || m[2])) return clean(m[1] || m[2]);
    }
    for (const line of lines) {
      const t = line.trim();
      if (t && !NAV_HINT.test(t) && !FREE_TEXT.test(t) && !OPTION_LINE.test(t) && !/^esc /i.test(t)) {
        if (t.length > 3) return clean(t);
      }
    }
    return "";
  }

  // Tightening helper for the no-nav-hint numbered branch: the block must
  // be at the tail end (only blank lines after it) or followed by a
  // confirm-hint line a real dialog prints under its options.
  function optionsAtTailOrConfirmed(lines, options) {
    const lastKey = String(options[options.length - 1].key);
    let lastOptionIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(OPTION_LINE);
      if (m && m[1] === lastKey) { lastOptionIdx = i; break; }
    }
    if (lastOptionIdx < 0) return false;
    for (let i = lastOptionIdx + 1; i < lines.length; i++) {
      if (CONFIRM_HINT.test(lines[i])) return true;
    }
    for (let i = lastOptionIdx + 1; i < lines.length; i++) {
      if (lines[i].trim()) return false;
    }
    return true;
  }

  // Parse terminal tail lines into a prompt-card object, or null when the
  // tail does not hold a live dialog.
  function parsePrompt(lines) {
    if (!lines.length) return null;
    // Unicode whitespace parity with the Rust parser: JS `\s` and Rust
    // regex `\s` disagree on BOM and NEL. Normalize the exotic spaces to
    // plain space so both parser copies match identically on terminals
    // that emit NBSP/NEL/U+3000/BOM/LS/PS.
    lines = lines.map((line) =>
      line.replace(/[\u00a0\u0085\u3000\ufeff\u2028\u2029]/g, " "),
    );
    const joined = lines.join("\n");
    if (JCODE_CHOOSER.test(joined)) return null;
    // Take the LAST contiguous numbered block: an older dialog may still be
    // on screen above; the active one is the newest.
    const blocks = [];
    let current = [];
    for (const line of lines) {
      const m = line.match(OPTION_LINE);
      if (m) current.push({ key: m[1], label: m[2].trim() });
      else if (current.length) {
        blocks.push(current);
        current = [];
      }
    }
    if (current.length) blocks.push(current);
    const options = blocks.length ? blocks[blocks.length - 1] : [];
    let title = "";
    // jcode Permissions viewer: letter options go straight to the viewer
    // (a approve, d deny, A/D bulk). Checked first: its tail also contains
    // "approve"/"deny" words that would otherwise fall through to the
    // weaker numbered branch.
    if (JCODE_VIEWER_HELP.test(joined) && JCODE_VIEWER_WAITING.test(joined)) {
      const pending = (joined.match(JCODE_VIEWER_TITLE) || [])[1] || "?";
      return {
        kind: "options",
        title: `jcode permissions (${pending} pending)`,
        options: [
          { key: "a", label: "Approve" },
          { key: "d", label: "Deny" },
          { key: "A", label: "Approve all" },
          { key: "D", label: "Deny all" },
        ],
      };
    }
    // Free-text prompt: a question line + "enter your response" hint.
    if (FREE_TEXT.test(joined)) {
      title = questionTitle(lines);
      if (title) return { kind: "text", title };
      return null;
    }
    // Navigation dialog: ↑↓ hint + numbered options (Kimi/jcode-style).
    if (NAV_HINT.test(joined) || /esc cancel|esc dismiss/i.test(joined)) {
      if (options.length >= 2) {
        title = questionTitle(lines) || "Select an option";
        return { kind: "options", title, options };
      }
      return null;
    }
    // Numbered confirmation without nav hint (permission dialogs). The
    // option block must sit at the tail end or carry a confirm hint below:
    // a numbered transcript list followed by newer output must not open a
    // card during the sub-second stale-blocked window.
    if (options.length >= 2) {
      const lower = joined.toLowerCase();
      if (/(allow|approve|yes|proceed|deny|reject|no|cancel)/.test(lower) && optionsAtTailOrConfirmed(lines, options)) {
        title = questionTitle(lines) || "Confirm action";
        return { kind: "options", title, options };
      }
    }
    return null;
  }

  // Prompt object from a server payload, or null when the payload says
  // the pane is not blocked or carries no dialog.
  function promptFromServer(server) {
    if (!server || !server.blocked || !server.kind) return null;
    return {
      kind: server.kind,
      title: server.title || "",
      options: Array.isArray(server.options) ? server.options : [],
    };
  }

  // Fresh-window bookkeeping for GET /api/panes/{id}/prompt. resolveApi
  // returns the host's request function (or null); getPaneId returns the
  // currently viewed pane id. Sticky-off: one failure disables the
  // endpoint for the session and local parsing takes over.
  function createServerPromptStore({ resolveApi, getPaneId }) {
    let promptApiUsable = true;
    let serverPrompt = null; // { at, payload } from the last endpoint hit
    let promptFetchInFlight = false;
    let promptFetchAt = 0;

    function fetchServerPrompt() {
      if (!promptApiUsable || promptFetchInFlight) return;
      if (Date.now() - promptFetchAt < SERVER_PROMPT_FETCH_MS) return;
      const paneId = getPaneId();
      const request = resolveApi();
      if (!paneId || typeof request !== "function") return;
      promptFetchAt = Date.now();
      promptFetchInFlight = true;
      Promise.resolve(
        request("/api/panes/" + encodeURIComponent(paneId) + "/prompt"),
      ).then(
        (res) => {
          const payload = res && (res.result || res);
          serverPrompt =
            payload && typeof payload === "object"
              ? { at: Date.now(), payload }
              : null;
        },
        () => {
          promptApiUsable = false;
          serverPrompt = null;
        },
      ).then(() => {
        promptFetchInFlight = false;
      });
    }

    function serverPromptFresh() {
      if (!promptApiUsable || !serverPrompt) return null;
      if (Date.now() - serverPrompt.at > SERVER_PROMPT_FRESH_MS) return null;
      return serverPrompt.payload;
    }

    function resetServer() {
      promptApiUsable = true;
      serverPrompt = null;
      promptFetchInFlight = false;
      promptFetchAt = 0;
    }

    function serverUsable() {
      return promptApiUsable;
    }

    return { fetchServerPrompt, serverPromptFresh, promptFromServer, resetServer, serverUsable };
  }

  const api = {
    parsePrompt,
    questionTitle,
    optionsAtTailOrConfirmed,
    promptFromServer,
    createServerPromptStore,
    SERVER_PROMPT_FRESH_MS,
    SERVER_PROMPT_FETCH_MS,
  };
  root.HerdrPromptParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
