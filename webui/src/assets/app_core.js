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
    const normalized = String(text || "").replace(/\r\n|\n/g, "\r");
    if (bracketedPasteMode) return "\x1b[200~" + normalized + "\x1b[201~";
    return normalized;
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

  const helpers = {
    branchPathSlug,
    normalizeAbsolutePath,
    normalizeThemeColors,
    terminalPasteInput,
  };
  root.HerdrAppHelpers = helpers;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
})(typeof globalThis !== "undefined" ? globalThis : window);
