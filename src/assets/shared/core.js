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

  function terminalPasteInput(text, bracketedPasteMode) {
    const normalized = String(text || "").replace(/\r\n|\r|\n/g, " ").replace(/ +$/, "");
    if (bracketedPasteMode) return "\x1b[200~" + normalized + "\x1b[201~";
    return normalized;
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
    normalizeThemeColors,
    resolveTerminalFontFamily,
    textValue,
    resolveWorktreeSource,
    checkedOutWorktreeForBranch,
    validateWorktreeCreate,
    buildWorktreeCreateBody,
    createFaviconNotifier,
    terminalPasteInput,
    tabActivityLabel,
    escapeHtml,
    pathBasename,
    gitApi,
  };
  root.HerdrAppHelpers = helpers;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
})(typeof globalThis !== "undefined" ? globalThis : window);
