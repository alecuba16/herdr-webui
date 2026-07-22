(function (root) {
  function branchPathSlug(branch) {
    let slug = "",
      lastDash = false;
    for (const ch of String(branch || "")) {
      if (/^[A-Za-z0-9]$/.test(ch)) {
        slug += ch.toLowerCase();
        lastDash = false;
      } else if (!lastDash) {
        slug += "-";
        lastDash = true;
      }
    }
    slug = slug.replace(/^-+|-+$/g, "");
    return slug || "worktree";
  }

  function normalizeAbsolutePath(path) {
    path = String(path || "");
    if (!path.startsWith("/")) return path;
    const parts = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  }

  function normalizeOrder(value, allowed) {
    const keys = Array.isArray(allowed) ? allowed : [];
    const seen = new Set();
    const order = [];
    const parts = Array.isArray(value) ? value : String(value || "").split(",");
    for (const part of parts) {
      const key = String(part || "").trim().toLowerCase();
      if (keys.includes(key) && !seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    for (const key of keys) if (!seen.has(key)) order.push(key);
    return order;
  }

  function terminalPasteInput(text, bracketedPasteMode) {
    const normalized = String(text || "").replace(/\r\n|\r/g, "\n");
    if (bracketedPasteMode) return "\x1b[200~" + normalized + "\x1b[201~";
    return normalized;
  }

  function stripTerminalMouseReports(data, enabled = false) {
    if (enabled) return data;
    if (typeof data !== "string" || data.indexOf("\x1b[") === -1) return data;
    // Some terminal emulators emit mouse reports when a terminal app enables
    // mouse tracking. Herdr owns mouse UX at the browser layer, so forwarding
    // mouse bytes to the PTY can leave readline
    // echoing fragments like `35;105;1M` after stale tracking mode. Strip mouse
    // reports from user input by default while preserving normal keyboard/paste
    // bytes. Users can opt in when a TUI really needs terminal mouse input.
    return data
      .replace(/\x1b\[<\d{1,4};\d{1,5};\d{1,5}[Mm]/g, "")
      .replace(/\x1b\[M[\s\S]{3}/g, "");
  }

  const TERMINAL_QUERY_REPLY_PATTERN = "(?:\\x1b\\])?(?:(?:10|11|12)|4;\\d{1,3});rgb:[0-9a-fA-F]{1,4}\\/[0-9a-fA-F]{1,4}\\/[0-9a-fA-F]{1,4}(?:\\x07|\\x1b\\\\|\\\\)?";
  const TERMINAL_QUERY_REPLY_RE = new RegExp(TERMINAL_QUERY_REPLY_PATTERN, "g");
  const TERMINAL_QUERY_REPLY_FULL_RE = new RegExp("^" + TERMINAL_QUERY_REPLY_PATTERN + "$");

  function stripTerminalQueryReplies(data, state) {
    if (typeof data !== "string") return data;
    const holder = state && typeof state === "object" ? state : null;
    let text = ((holder && holder.carry) || "") + data;
    if (holder) holder.carry = "";
    text = text.replace(TERMINAL_QUERY_REPLY_RE, "");
    if (!holder) return text;
    const pending = terminalQueryReplyPendingSuffix(text);
    if (pending) {
      holder.carry = pending;
      text = text.slice(0, -pending.length);
    }
    return text;
  }

  function terminalQueryReplyPendingSuffix(text) {
    const value = String(text || ""),
      start = Math.max(0, value.length - 96);
    for (let index = start; index < value.length; index += 1) {
      const suffix = value.slice(index);
      if (terminalQueryReplyPartial(suffix)) return suffix;
    }
    return "";
  }

  function terminalQueryReplyPartial(value) {
    let text = String(value || "");
    if (!text) return false;
    if (text === "\x1b") return false;
    if ("\x1b]".startsWith(text)) return true;
    const oscPrefixed = text.startsWith("\x1b]");
    if (oscPrefixed) text = text.slice(2);
    if (!oscPrefixed && !text.includes(";r")) return false;
    return /^(?:(?:1[012]?)|(?:4(?:;\d{0,3})?))(?:;r(?:g(?:b(?::[0-9a-fA-F]{0,4}(?:\/[0-9a-fA-F]{0,4}(?:\/[0-9a-fA-F]{0,4})?)?)?)?)?)?$/.test(text)
      && !TERMINAL_QUERY_REPLY_FULL_RE.test(text);
  }

  function tabActivityLabel(updatedAt, now) {
    const age = Math.max(0, Number(now) - Number(updatedAt));
    if (!Number.isFinite(age)) return "";
    const minute = 60 * 1000,
      hour = 60 * minute,
      day = 24 * hour;
    if (age > day) return ">1d";
    if (age > hour) return ">1h";
    if (age < minute) return "<1m";
    return Math.floor(age / minute) + "m ago";
  }

  function isHexColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || ""));
  }

  function normalizeThemeColors(value, defaults) {
    const source = value && typeof value === "object" ? value : {};
    const next = {};
    for (const mode of ["dark", "light"]) {
      next[mode] = {};
      const colors =
        source[mode] && typeof source[mode] === "object" ? source[mode] : {};
      for (const key of Object.keys(defaults[mode] || {})) {
        const candidate = colors[key];
        next[mode][key] = isHexColor(candidate)
          ? candidate.toLowerCase()
          : defaults[mode][key];
      }
    }
    return next;
  }

  const DEFAULT_TERMINAL_FONT_FAMILY =
    "'Herdr JetBrainsMono Nerd Font Mono', ui-monospace, SFMono-Regular, Menlo, 'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code NF', 'MesloLGS NF', 'Symbols Nerd Font Mono', monospace";

  function resolveTerminalFontFamily(value) {
    const trimmed = String(value == null ? "" : value).trim();
    return trimmed || DEFAULT_TERMINAL_FONT_FAMILY;
  }

  function textValue(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v.path) return textValue(v.path);
    if (v.display) return textValue(v.display);
    if (v.label) return textValue(v.label);
    if (v.name) return textValue(v.name);
    return "";
  }

  function resolveWorktreeSource(input) {
    const workspaceId = input.workspaceId || null,
      sourcePath = String(input.sourcePath || "").trim(),
      originalSource = String(input.originalSource || "").trim(),
      discovered = input.discoveredSource || {},
      fallbackWorkspaceId = input.fallbackWorkspaceId || null;
    if (workspaceId) {
      const edited = sourcePath && sourcePath !== originalSource;
      return edited
        ? { workspace_id: null, cwd: sourcePath }
        : { workspace_id: workspaceId, cwd: null };
    }
    const wsId = discovered.workspace_id || (!sourcePath ? fallbackWorkspaceId : null);
    return {
      workspace_id: wsId || null,
      cwd: wsId ? null : (discovered.cwd || sourcePath || null),
    };
  }

  function checkedOutWorktreeForBranch(branch, worktreeLists) {
    branch = String(branch || "").trim();
    if (!branch) return null;
    const lists = worktreeLists || [];
    for (const list of lists) {
      const found = (list || []).find(
        (w) => textValue(w.branch) === branch && !w.is_prunable,
      );
      if (found) return found;
    }
    return null;
  }

  function worktreeActivityTimestamp(row) {
    const source = row || {};
    const candidates = [
      source.last_commit_at,
      source.latest_commit_at,
      source.last_commit_date,
      source.latest_commit_date,
      source.modified_at,
      source.updated_at,
      source.mtime,
      source.last_modified_at,
    ];
    for (const value of candidates) {
      const time = Date.parse(String(value || ""));
      if (Number.isFinite(time)) return time;
    }
    for (const value of [source.last_commit_timestamp, source.latest_commit_timestamp, source.modified_timestamp, source.updated_timestamp]) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    return 0;
  }

  function formatWorktreeActivityDate(row) {
    const time = worktreeActivityTimestamp(row);
    if (!time) return "";
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function worktreeActivityLabel(row) {
    const display = textValue((row || {}).last_commit_display || (row || {}).latest_commit_display || (row || {}).activity_display);
    if (display) return `Latest commit ${display}`;
    const date = formatWorktreeActivityDate(row);
    return date ? `Latest commit ${date}` : "Latest commit unknown";
  }

  function sortWorktreesByRecent(rows) {
    return [...(rows || [])].sort((left, right) => {
      const byTime = worktreeActivityTimestamp(right) - worktreeActivityTimestamp(left);
      if (byTime) return byTime;
      return String(textValue(left.label) || textValue(left.path)).localeCompare(
        String(textValue(right.label) || textValue(right.path)),
      );
    });
  }

  function validateWorktreeCreate(input) {
    const branch = String(input.branch || "").trim();
    if (!branch && !input.generateWorktreeNames) {
      return "Branch name is required. Enable Generate worktree branch names in Settings to leave it blank.";
    }
    const checkedOut = checkedOutWorktreeForBranch(
      branch,
      input.worktreeLists || [],
    );
    if (checkedOut) {
      return `Branch "${branch}" is already checked out at ${textValue(checkedOut.path)}`;
    }
    return "";
  }

  function buildWorktreeCreateBody(input) {
    const source = input.source || {};
    return {
      workspace_id: source.workspace_id ?? null,
      cwd: source.cwd ?? null,
      branch: String(input.branch || "").trim() || null,
      base: String(input.base || "").trim() || null,
      label: String(input.label || "").trim() || null,
      path: String(input.path || "").trim() || null,
      pull_base: !!input.pullBase,
    };
  }

  const faviconUrls = {
    normal: "/favicon.svg",
    attention: "/favicon-attention.svg",
    error: "/favicon-error.svg",
  };

  function createFaviconNotifier(doc) {
    const documentRef = doc || root.document;
    let current = "";
    function ensureLink() {
      if (!documentRef || !documentRef.head) return null;
      let link = documentRef.querySelector('link[rel="icon"]');
      if (!link) {
        link = documentRef.createElement("link");
        link.rel = "icon";
        link.type = "image/svg+xml";
        documentRef.head.appendChild(link);
      }
      return link;
    }
    return {
      set(state) {
        const next = state === "attention" || state === "error" ? state : "normal";
        if (next === current) return;
        const link = ensureLink();
        if (!link) return;
        current = next;
        link.href = faviconUrls[next] || faviconUrls.normal;
      },
      get() { return current || "normal"; },
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pathBasename(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || String(path || "");
  }

  async function gitApi(url, options) {
    const res = await fetch(
      url,
      Object.assign({ credentials: "same-origin" }, options || {}),
    );
    if (!res.ok) {
      let msg;
      try {
        const data = await res.json();
        msg = data.error || `HTTP ${res.status}`;
      } catch {
        msg = `HTTP ${res.status}`;
      }
      throw new Error(msg);
    }
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body;
  }

  const helpers = {
    branchPathSlug,
    normalizeAbsolutePath,
    normalizeOrder,
    normalizeThemeColors,
    resolveTerminalFontFamily,
    textValue,
    resolveWorktreeSource,
    checkedOutWorktreeForBranch,
    worktreeActivityTimestamp,
    formatWorktreeActivityDate,
    worktreeActivityLabel,
    sortWorktreesByRecent,
    validateWorktreeCreate,
    buildWorktreeCreateBody,
    createFaviconNotifier,
    terminalPasteInput,
    stripTerminalMouseReports,
    stripTerminalQueryReplies,
    tabActivityLabel,
    escapeHtml,
    pathBasename,
    gitApi,
  };
  root.HerdrAppHelpers = helpers;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
})(typeof globalThis !== "undefined" ? globalThis : window);
