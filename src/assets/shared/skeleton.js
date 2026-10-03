// Skeleton loading placeholders (shapes similar to the real content) shown
// inside a section while its connectivity-dependent work is pending: the
// first refresh fetches, websocket attaches, session-list loads, and login.
// Each helper returns HTML with the same block structure the real render
// produces (banner for headers, title + meta line for rows) so the section
// keeps its size and shape and does not jump when the data lands.
(function (root) {
  function block(cls) {
    return `<div class="herdr-skeleton-block ${cls || ""}" aria-hidden="true"></div>`;
  }

  // Two sidebar-style rows: a title bar plus a shorter meta line each.
  function rows(count) {
    let html = "";
    for (let i = 0; i < (count || 2); i++)
      html += `<div class="herdr-skeleton-row">${block("herdr-skeleton-title")}${block("herdr-skeleton-line")}</div>`;
    return html;
  }

  const HerdrSkeleton = {
    // One-line placeholder (e.g. the versions line under the sidebar head).
    banner: block.bind(null, "herdr-skeleton-banner"),
    // Workspace list section.
    workspaces(count) {
      return `<div class="herdr-skeleton herdr-skeleton-workspaces">${rows(count || 3)}</div>`;
    },
    // Agents list section.
    agents(count) {
      return `<div class="herdr-skeleton herdr-skeleton-agents">${rows(count || 2)}</div>`;
    },
    // Session manager rows (one row per expected session line).
    sessions(count) {
      return `<div class="herdr-skeleton herdr-skeleton-sessions">${rows(count || 2)}</div>`;
    },
    // Terminal surface: a prompt line, two output lines, and a shorter
    // line, mimicking a mostly-empty shell so the panel shape stays stable
    // while the websocket attach is pending.
    terminal() {
      return `<div class="herdr-skeleton herdr-skeleton-terminal" aria-hidden="true"><div class="herdr-skeleton-row">${block("herdr-skeleton-line")}</div><div class="herdr-skeleton-row">${block("herdr-skeleton-line")}</div><div class="herdr-skeleton-row">${block("herdr-skeleton-title")}</div></div>`;
    },
    // Inline spinner+label for buttons/small wait states (same style as the
    // git-ui worktree-loading pattern).
    inline(label) {
      return `<div class="worktree-loading show">${label || "Loading..."}</div>`;
    },
  };
  if (root && typeof root === "object") root.HerdrSkeleton = HerdrSkeleton;
  if (typeof module !== "undefined" && module.exports) module.exports = HerdrSkeleton;
})(globalThis);
