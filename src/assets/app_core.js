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

  function terminalWheelScrollBatch(remainder, delta, deltaMode, speed, rows) {
    const mode = Number(deltaMode) || 0,
      lineSpeed = Math.max(1, Math.min(20, Number(speed) || 3)),
      rowCount = Math.max(1, Number(rows) || 30);
    const units =
      mode === 1
        ? Number(delta) / 3
        : mode === 2
          ? (Number(delta) * Math.max(1, rowCount - 1)) / 3
          : Number(delta) / 100;
    const next = (Number(remainder) || 0) + units * lineSpeed;
    const whole = Math.trunc(Math.abs(next));
    if (!Number.isFinite(next) || whole < 1)
      return { direction: null, lines: 0, remainder: Number.isFinite(next) ? next : 0 };
    const lines = Math.min(whole, 120),
      sign = Math.sign(next);
    return {
      direction: sign < 0 ? "up" : "down",
      lines,
      remainder: next - sign * lines,
    };
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
    terminalWheelScrollBatch,
    terminalPasteInput,
  };
  root.HerdrAppHelpers = helpers;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
})(typeof globalThis !== "undefined" ? globalThis : window);
