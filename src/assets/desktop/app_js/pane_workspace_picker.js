// Workspace picker for pane surfaces (D3/D6). The `+` in the location
// bar controls (and a strip's workspace badge) can start a terminal in
// ANY workspace, not only the selected one; the badge's picker is
// scoped to its pane. One popover
// machinery serves both entries: rows list every workspace with its
// worktree name and branch (near-identical worktree names otherwise
// mislead, UX review finding 4), the current workspace stays one click
// away at the top, and picking a row routes a New panel into the pane
// the picker was opened for.
//
// Keyboard contract (R-32): ArrowUp/Down move through rows, Enter picks
// (native button activation), Escape closes from anywhere (global
// capture handler), and close restores focus to the opener. Rows are
// real buttons with accessible names; the popover is role=dialog with
// a listbox of options.

(function () {
  let open = null; // { paneId, scope, element, previouslyFocused }

  function close() {
    if (!open) return;
    const { element, previouslyFocused } = open;
    open = null;
    try {
      if (element && element.remove) element.remove();
    } catch (e) {}
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      try { previouslyFocused.focus(); } catch (e) {}
    }
  }

  function isOpen() {
    return !!open;
  }

  // Row inventory: every workspace, worktree name + branch, dirty state.
  // The selected workspace pins first (one click away, D3) and carries a
  // "current" marker so the list reads at a glance.
  function pickerRows() {
    const workspaces = (state.workspaces || []).slice();
    const selected = state.ws;
    workspaces.sort((a, b) => {
      if (a.workspace_id === selected) return -1;
      if (b.workspace_id === selected) return 1;
      return 0;
    });
    return workspaces.map((workspace) => {
      const branch =
        (typeof workspaceBranch === "function" && workspaceBranch(workspace)) || "";
      const worktree =
        workspace && workspace.worktree
          ? workspace.worktree
          : null;
      const repo = (worktree && worktree.repo_name) || "";
      const dirty =
        worktree && (worktree.dirty || worktree.changed)
          ? true
          : !!(worktree && worktree.status && worktree.status.dirty);
      const label = workspace.label || repo || workspace.workspace_id;
      return {
        workspaceId: workspace.workspace_id,
        label,
        branch,
        repo,
        dirty,
        current: workspace.workspace_id === selected,
      };
    });
  }

  function rowHtml(row) {
    const encoded = encodeURIComponent(row.workspaceId);
    const branch = row.branch
      ? `<span class="pane-picker-row-branch">${escapeHtml(row.branch)}</span>`
      : "";
    const dirty = row.dirty
      ? '<span class="pane-picker-row-dirty" title="Uncommitted changes" aria-label="Uncommitted changes">●</span>'
      : "";
    const current = row.current
      ? '<span class="pane-picker-row-current">current</span>'
      : "";
    return (
      `<button class="pane-picker-row" role="option" aria-selected="${row.current ? "true" : "false"}" data-workspace-id="${escapeAttr(row.workspaceId)}" onclick="event.preventDefault();HerdrPaneWorkspacePicker.pick('${escapeAttr(encoded)}')"` +
      ` onkeydown="HerdrPaneWorkspacePicker.rowKeydown(event)">` +
      `<span class="pane-picker-row-name">${escapeHtml(row.label)}</span>${branch}${dirty}${current}` +
      `</button>`
    );
  }

  // Chord opens with no anchor element (location bar repainted, or
  // the + hidden in the empty state): the class carries no position of
  // its own, so a static-flow popover would sink under the app; pin it
  // near the top-left where the bar sits.
  function positionNear(anchor) {
    if (!anchor || !anchor.getBoundingClientRect) {
      return { position: "fixed", left: "16px", top: "48px" };
    }
    const rect = anchor.getBoundingClientRect();
    return {
      position: "fixed",
      left: `${Math.max(8, rect.left)}px`,
      top: `${Math.min(rect.bottom + 4, window.innerHeight - 220)}px`,
    };
  }

  // scope: "new-tab" (+ button: pick a workspace, create the panel there
  // and land it in this pane) or "switch" (badge: route this pane to the
  // picked workspace. D2 sidebar-click semantics: the route moves to
  // that workspace's terminal when one exists, else the workspace root
  // (the next + starts a panel there).
  function openPicker(anchorElement, paneId, scope) {
    close();
    const rows = pickerRows();
    if (!rows.length) return false;
    const host = document.body;
    if (!host) return false;
    const element = document.createElement("div");
    element.className = "pane-workspace-picker";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-label", scope === "new-tab" ? "New panel workspace" : "Pane workspace");
    const style = positionNear(anchorElement);
    for (const key of Object.keys(style)) element.style[key] = style[key];
    const previouslyFocused =
      document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    element.innerHTML =
      `<div class="pane-picker-title">${scope === "new-tab" ? "Open terminal from" : "Show workspace"}</div>` +
      `<div class="pane-picker-rows" role="listbox" aria-label="Workspaces">` +
      rows.map(rowHtml).join("") +
      `</div>`;
    host.appendChild(element);
    open = { paneId, scope, element, previouslyFocused };
    const first = element.querySelector(".pane-picker-row");
    if (first && typeof first.focus === "function") {
      try { first.focus(); } catch (e) {}
    }
    return true;
  }

  // Create a panel in the picked workspace and land it in this pane.
  // POST /api/tabs takes workspace_id (verified server-side), and the
  // pending placement tells the sync which leaf owns the fresh id.
  // After creation the route moves to the new tab so the owner leaf
  // takes the primary shell (the pane's own tab shows live).
  async function pick(workspaceId) {
    const paneId = open ? open.paneId : null;
    const scope = open ? open.scope : "new-tab";
    close();
    if (!workspaceId || !state.ws) return;
    if (scope !== "new-tab") {
      // Route to the workspace's first known terminal when one exists;
      // the unfiltered index covers cross-workspace rows.
      let firstTabId = null;
      if (state.tabsById) {
        for (const [id, row] of Object.entries(state.tabsById)) {
          if (row && row.workspace_id === workspaceId) {
            firstTabId = id;
            break;
          }
        }
      }
      if (!firstTabId) {
        const local = (state.tabs || []).find(
          (tab) => tab.workspace_id === workspaceId && tab.tab_id,
        );
        if (local) firstTabId = local.tab_id;
      }
      if (typeof go === "function") go(workspaceId, firstTabId || undefined);
      return;
    }
    const panes = window.HerdrWorkspacePanes;
    // new-tab scope routes through the shared openPanelInWorkspace
    // (D3): same path the sidebar card drop uses, placement included.
    // The pane placement + POST + route trio lives there once; this
    // scope has no private copy of it.
    if (scope === "new-tab" && panes && typeof panes.openPanelInWorkspace === "function") {
      await panes.openPanelInWorkspace(workspaceId, paneId);
      return;
    }
    if (typeof go === "function") go(workspaceId);
  }

  function rowKeydown(event) {
    if (!event) return;
    const rows = open && open.element
      ? [...open.element.querySelectorAll(".pane-picker-row")]
      : [];
    if (!rows.length) return;
    const index = rows.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? rows[(index + 1 + rows.length) % rows.length]
        : rows[(index - 1 + rows.length) % rows.length];
      if (next && typeof next.focus === "function") {
        try { next.focus(); } catch (e) {}
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  // Global keys while open; the rows handle their own arrows but Escape
  // must work wherever focus sits.
  function globalKeydown(event) {
    if (!open) return;
    if (event && event.key === "Escape") close();
  }

  // Outside pointerdown closes. Capture phase so pane interactions that
  // re-render strips do not leave a dangling popover. The + and badge
  // re-click works because their own click handler runs after this close
  // and reopens with the fresh anchor (toggle behavior).
  function globalPointerDown(event) {
    if (!open) return;
    if (open.element && event && event.target && open.element.contains(event.target)) return;
    close();
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener("keydown", globalKeydown, true);
    document.addEventListener("pointerdown", globalPointerDown, true);
  }

  window.HerdrPaneWorkspacePicker = {
    openPicker,
    pick,
    rowKeydown,
    close,
    isOpen,
    wire,
    pickerRows,
  };
})();