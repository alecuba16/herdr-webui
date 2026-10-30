// Desktop location bar: the folder / worktree / branch strip above the
// workspace panes. Independent shell module (same family as
// workspace_panes.js): own state, own signature-based sync called from
// render(), no dependency on the lazily-loaded git_ui drawer. Git facts
// come from cached sources only (rail-status parks, the worktrees list,
// the server branch attribution); the branch popover is the one surface
// that fetches on demand (plan phase 3), and it owns its data in bar
// state, never in drawer state.
(function () {
  const helpers = globalThis.HerdrAppHelpers || {};
  const escapeHtml = helpers.escapeHtml || ((v) => String(v == null ? "" : v));
  const pathBasename =
    helpers.pathBasename ||
    ((p) => String(p || "").split("/").filter(Boolean).pop() || "");
  const inputAttrs =
    helpers.inputAttrs ||
    ((hint) =>
      ' autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"' +
      (hint ? ` enterkeyhint="${escapeHtml(hint)}"` : ""));
  // One signature per render: polls that change nothing must not touch the
  // bar DOM. Popover state is part of the signature so popover-only
  // changes repaint the bar alone, never the whole shell.
  let lastSignature = null;
  let lastHtml = "";

  // Popover state (plan phase 3): the shape the row renderer expects
  // (loading, error, local, remote, filter, currentBranch,
  // remoteLoaded, remoteLoading, remoteRequestId).
  const bar = {
    branchList: null,
    worktreeList: null,
  };

  function samePath(left, right) {
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    if (!a || !b) return false;
    const norm = (p) => (p === "/" ? "/" : p.replace(/\/+$/, ""));
    return norm(a) === norm(b);
  }

  function encodeArg(value) {
    return encodeURIComponent(String(value == null ? "" : value)).replace(/'/g, "%27");
  }

  function barNode() {
    return document.getElementById("locationBar");
  }

  function selectedWorkspace() {
    return (
      (state.workspaces || []).find((w) => w.workspace_id === state.ws) ||
      null
    );
  }

  function workspaceCwd(workspace) {
    if (!workspace) return "";
    return window.HerdrWorkspacePath ? window.HerdrWorkspacePath(workspace) : workspace.cwd || workspace.path || "";
  }

  // Cached git facts for the workspace folder, no fetches. Precedence:
  // 1. the live worktree row (state.worktrees rows carry the checked-out
  //    branch and the detached marker),
  // 2. the server-side attribution map refreshOnline builds
  //    (state.workspaceBranches[workspace_id]),
  // 3. the parked pre-load status (state.gitStatusCache, the full status
  //    syncGitWorkspaceToggle parks before git_ui lazy-loads) and the
  //    drawer-side parks read through HerdrGitUi.workspaceBranch
  //    (rail-status probe and drawer status, both cwd-matched),
  // 4. the workspace's own worktree stamp (branch at list time).
  // unknown means no source answered: the bar shows the disabled chip.
  // notGit means a source confirmed the folder is not a git repository:
  // the bar renders the path chip only (plan decision 1, plain folder).
  function gitFacts(workspace, cwd) {
    const row = (state.worktrees || []).find((t) => samePath(t.path, cwd));
    if (row) {
      if (row.is_detached) return { branch: "detached", known: true };
      if (row.branch) return { branch: String(row.branch), known: true };
    }
    const attributed =
      state.workspaceBranches && state.workspaceBranches[workspace.workspace_id];
    if (attributed) return { branch: String(attributed), known: true };
    const cache = state.gitStatusCache;
    if (
      cache &&
      !cache.pending &&
      !cache.failed &&
      samePath(cache.cwd, cwd) &&
      cache.not_git_repository
    )
      return { notGit: true };
    if (cache && !cache.pending && !cache.failed && samePath(cache.cwd, cwd) && cache.branch)
      return { branch: String(cache.branch), known: true };
    if (window.HerdrGitUi) {
      if (window.HerdrGitUi.workspaceBranch) {
        const parked = window.HerdrGitUi.workspaceBranch(workspace, cwd);
        if (parked) return parked;
      }
      if (
        window.HerdrGitUi.workspaceStatus &&
        window.HerdrGitUi.workspaceStatus(state.ws, workspace) === "nogit"
      )
        return { notGit: true };
    }
    const wt = workspace.worktree;
    if (wt && wt.branch) return { branch: String(wt.branch), known: true };
    return { branch: "", known: false };
  }

  function renderSignature(cwd, facts) {
    const list = bar.branchList;
    const branchToken = !list
      ? "-"
      : [
          "open",
          list.loading ? "l" : "",
          list.error || "",
          (list.local || []).length,
          (list.remote || []).length,
          list.filter || "",
          list.currentBranch || "",
          list.remoteLoaded ? "R" : "",
          list.remoteLoading ? "r" : "",
        ].join(":");
    const worktrees = bar.worktreeList;
    const worktreeToken = !worktrees
      ? "-"
      : ["open", worktrees.loading ? "l" : "", worktrees.error || "", (worktrees.worktrees || []).length].join(":");
    return [state.ws, cwd, facts.branch || "", !!facts.known, !!facts.notGit, branchToken, worktreeToken].join("|");
  }

  // Chip click handlers: path opens the picker (phase 2), branch and
  // worktree chips open their popovers (phases 3 and 4).
  function chipClick(name) {
    if (name === "path") return ' onclick="HerdrLocationBar.openPathPicker()"';
    if (name === "branch") return ' onclick="HerdrLocationBar.openBranchPopover(event)"';
    if (name === "worktree") return ' onclick="HerdrLocationBar.openWorktreePopover(event)"';
    return "";
  }

  function chip(name, title, body, disabled) {
    return `<button class="git-ui-branch-chip location-bar-${name}-chip" type="button"${disabled ? " disabled" : ""}${chipClick(name)} title="${escapeHtml(title)}"><span class="git-ui-branch-chip-name">${body}</span></button>`;
  }

  function separator() {
    return `<span class="git-ui-selector-separator" aria-hidden="true">/</span>`;
  }

  function renderBar(workspace, cwd, facts) {
    // Path chip: always present while the bar is visible. The button
    // contract (class, title, name span) matches the drawer chips so the
    // git-ui chip CSS applies and phase 2 only adds the click behavior.
    const pathName = pathBasename(cwd) || cwd;
    const chips = [
      chip("path", `Change workspace folder · ${cwd}`, escapeHtml(pathName)),
    ];
    // Worktree chip only for linked worktrees (plan decision 1, git
    // worktree shape): path + worktree + branch. The plain-checkout git
    // shape and the plain-folder shape both render path + branch or path
    // only; the drawer's worktree chip shows the checkout basename too.
    if (workspace.worktree && workspace.worktree.is_linked_worktree === true) {
      chips.push(separator(), chip("worktree", "Choose worktree", escapeHtml(pathName)));
    }
    // Branch chip renders for git folders, disabled while the branch is
    // still unknown; a confirmed non-git folder renders the path only.
    if (!facts.notGit) {
      if (facts.known)
        chips.push(separator(), chip("branch", "Switch branch", escapeHtml(facts.branch)));
      else
        chips.push(separator(), chip("branch", "Branch unknown", "branch…", true));
    }
    return (
      chips.join("") +
      (bar.branchList ? renderBranchPopover() : "") +
      (bar.worktreeList ? renderWorktreePopover() : "")
    );
  }

  // ── Branch popover (plan phase 3) ───────────────────────────────
  // Rows reuse the git-ui-branch-* classes so the lazy-loaded git-ui.css
  // styles the popover; handlers point at the HerdrLocationBar namespace.
  // The popover anchors fixed under the branch chip (the bar scrolls
  // horizontally, so absolute children would clip).

  function branchRelativeTime(isoDate) {
    const then = Date.parse(String(isoDate || ""));
    if (!then || Number.isNaN(then)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }

  function branchListRow(branch, currentBranch) {
    const name = String(branch.name || "");
    const isCurrent = !branch.remote && name === currentBranch;
    const author = String(branch.author || "");
    const date = String(branch.date || "");
    const subject = String(branch.subject || "");
    const exact = date ? new Date(date).toLocaleString() : "";
    const hover = [author && `${author}`, exact, subject && `"${subject}"`].filter(Boolean).join(" · ");
    const icon = isCurrent ? `<b class="git-ui-branch-row-check" title="Current branch">✓</b>` : `<b class="git-ui-branch-row-icon" aria-hidden="true"></b>`;
    const meta = [author, branchRelativeTime(date)].filter(Boolean).join(" · ");
    // Trash only on non-current rows; it stops propagation so the row
    // switch does not fire.
    const trash = isCurrent
      ? ""
      : `<button class="git-ui-branch-row-trash" title="Delete branch" aria-label="Delete branch ${escapeHtml(name)}" onclick="event.stopPropagation();HerdrLocationBar.deleteBranchFromPopover('${encodeArg(name)}',${branch.remote ? "true" : "false"})"><span></span></button>`;
    return `<div class="git-ui-branch-row${isCurrent ? " current" : ""}" title="${escapeHtml(hover)}">
          <button class="git-ui-branch-row-main" onclick="HerdrLocationBar.switchBranchFromPopover('${encodeArg(name)}',${branch.remote ? "true" : "false"})">
            <span class="git-ui-branch-row-name">${icon}<span class="git-ui-branch-row-name-text">${escapeHtml(name)}</span>${branch.remote ? `<i class="git-ui-branch-row-remote">remote</i>` : ""}</span>
            <span class="git-ui-branch-row-meta">${escapeHtml(meta)}</span>
          </button>${trash}
        </div>`;
  }

  function remoteBranchPreload() {
    try {
      const options = window.HerdrOptions && window.HerdrOptions.read ? window.HerdrOptions.read() : {};
      const value = Number(options.gitUiRemoteBranchPreload);
      return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 10;
    } catch (_) {
      return 10;
    }
  }

  function renderBranchPopover() {
    const list = bar.branchList;
    if (!list) return "";
    const anchor = list.anchor || { left: 10, top: 40, width: 360 };
    const style = `left:${Math.max(8, anchor.left)}px;top:${anchor.top}px;width:${anchor.width}px`;
    if (list.loading)
      return `<div class="git-ui-branch-list location-bar-branch-popover" style="${style}" onclick="event.stopPropagation()"><div class="git-ui-loading"><span></span><strong>Loading branches</strong></div></div>`;
    const body = list.error
      ? `<div class="git-ui-error">${escapeHtml(list.error)}</div>`
      : branchPopoverRows(list);
    const draft = String(list.newBranch || "");
    const createDisabled = list.creating ? " disabled" : "";
    return `<div class="git-ui-branch-list location-bar-branch-popover" style="${style}" onclick="event.stopPropagation()">${body}<label class="git-ui-branch-list-new"><span>New branch from ${escapeHtml(list.currentBranch || "HEAD")}</span><div class="git-ui-inline-field"><input value="${escapeHtml(draft)}" placeholder="branch-name"${inputAttrs("done")} oninput="HerdrLocationBar.newBranchDraft(this.value)" onkeydown="HerdrLocationBar.newBranchKeydown(event)"><button class="git-ui-btn" type="button"${createDisabled} onclick="HerdrLocationBar.createBranchFromPopover()">Create</button></div></label><label class="git-ui-branch-list-filter"><span>Filter</span><input value="${escapeHtml(list.filter || "")}" placeholder="Type to filter"${inputAttrs("search")} oninput="HerdrLocationBar.branchPopoverFilter(this.value)"></label></div>`;
  }

  function branchPopoverRows(list) {
    const filter = String(list.filter || "").toLowerCase();
    const currentBranch = String(list.currentBranch || "");
    const matches = (branch) => !filter || String(branch.name || "").toLowerCase().includes(filter);
    // Current branch pinned at the top of the local section.
    const localAll = (list.local || []).filter(matches);
    const currentRows = localAll.filter((branch) => !branch.remote && branch.name === currentBranch);
    const local = currentRows.concat(localAll.filter((branch) => !currentRows.includes(branch)));
    const remoteAll = (list.remote || []).filter(matches);
    const preferred = (branch) => {
      const name = String(branch.name || "").replace(/^origin\//, "");
      if (name === "main" || name === "master" || name === currentBranch) return 0;
      if (name.startsWith(`${currentBranch}/`) || currentBranch.startsWith(`${name}/`)) return 1;
      return 2;
    };
    const remoteOrdered = remoteAll.slice().sort((left, right) => preferred(left) - preferred(right));
    const remote = list.remoteLoaded ? remoteAll : remoteOrdered.slice(0, remoteBranchPreload());
    const rows = (branches, label) => !branches.length ? "" : `<div class="git-ui-branch-list-section">${label}</div>${branches.map((branch) => branchListRow(branch, currentBranch)).join("")}`;
    const empty = !local.length && !remote.length ? `<div class="git-ui-muted git-ui-branch-list-empty">No branches match</div>` : "";
    const loadingRemote = list.remoteLoading ? `<div class="git-ui-branch-loading">Loading remote branches…</div>` : "";
    const loadMore = !list.remoteLoading && !list.remoteLoaded && remoteAll.length > remote.length
      ? `<button class="git-ui-branch-load-more" onclick="HerdrLocationBar.loadMoreBranches()">Load more branches (${remoteAll.length - remote.length} more)</button>`
      : "";
    return `<div class="git-ui-branch-list-scroll">${rows(local, "Local branches")}${rows(remote, "Remote branches")}${loadingRemote}${loadMore}${empty}</div>`;
  }

  function anchorFromEvent(event, chipSelector) {
    // Keyboard entry (the b shortcut) passes no event: anchor on the
    // chip itself so the popover still hangs off the bar.
    const target =
      (event && event.currentTarget) ||
      (document.querySelector && document.querySelector(chipSelector || ".location-bar-branch-chip:not([disabled])"));
    const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    if (!rect) return { left: 10, top: 40, width: 360 };
    const maxWidth = Math.min(420, Math.max(280, (window.innerWidth || 1200) - rect.left - 16));
    return { left: rect.left, top: rect.bottom + 4, width: maxWidth };
  }

  // Same HTTP contract as the shell modules: shared HerdrHttp when the
  // shell provided it, else plain fetch. Harnesses provide only fetch.
  async function api(url, opt) {
    if (globalThis.HerdrHttp) return globalThis.HerdrHttp.request(url, opt);
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
    return body;
  }

  function focusPopoverInput(selector, caretValue) {
    requestAnimationFrame(() => {
      const input = document.querySelector(selector);
      if (!input) return;
      input.focus();
      try {
        const length = String(caretValue || "").length;
        input.setSelectionRange(length, length);
      } catch (_) {}
    });
  }

  function currentCwd() {
    return workspaceCwd(selectedWorkspace());
  }

  // A row action may run long after its popover opened (the user can
  // switch workspaces or folders while it stays open). The action must
  // still target the context it was opened for, not whatever is selected
  // now.
  function popoverContextStale(list) {
    if (!list) return true;
    if (String(list.wsId || "") !== String(state.ws || "")) return true;
    if (list.cwd && !samePath(list.cwd, currentCwd())) return true;
    return false;
  }

  let popoverRequests = 0;
  function nextPopoverRequestId() {
    popoverRequests += 1;
    return popoverRequests;
  }

  function closeBranchPopover() {
    if (!bar.branchList) return;
    bar.branchList = null;
    sync();
  }

  async function openBranchPopover(event) {
    const cwd = currentCwd();
    if (!cwd) return;
    if (event && event.stopPropagation) event.stopPropagation();
    // Only one popover at a time: opening one closes the other.
    closeWorktreePopover();
    // Re-open toggle: clicking the chip again closes the popover.
    if (bar.branchList && !bar.branchList.loading) {
      closeBranchPopover();
      return;
    }
    const workspace = selectedWorkspace();
    const facts = workspace ? gitFacts(workspace, cwd) : { branch: "" };
    bar.branchList = {
      loading: true,
      error: "",
      local: [],
      remote: [],
      filter: "",
      currentBranch: facts.branch || "",
      remoteLoaded: false,
      remoteLoading: false,
      remoteRequestId: 0,
      newBranch: "",
      creating: false,
      anchor: anchorFromEvent(event),
      // Identity of this opening: fetch completions and row actions must
      // belong to the same opening, workspace, and folder. A stale
      // response (closed, reopened, or a workspace switch meanwhile) can
      // otherwise mutate the fresh popover or act on the wrong repo.
      requestId: nextPopoverRequestId(),
      wsId: String(state.ws || ""),
      cwd,
    };
    const request = bar.branchList.requestId;
    sync();
    try {
      const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(cwd)}`);
      if (!bar.branchList || bar.branchList.requestId !== request) return; // superseded while loading
      // The payload's current marker is authoritative while the popover is
      // open: cached facts can lag a switch made elsewhere.
      const currentRow = (data.local || []).find((b) => b && b.current);
      if (currentRow && currentRow.name) {
        bar.branchList.currentBranch = String(currentRow.name);
      }
      bar.branchList = {
        ...bar.branchList,
        loading: false,
        error: "",
        local: data.local || [],
        remote: data.remote || [],
        remoteLoaded: false,
      };
    } catch (err) {
      if (!bar.branchList || bar.branchList.requestId !== request) return;
      bar.branchList = {
        ...bar.branchList,
        loading: false,
        error: err.message || String(err),
        local: [],
        remote: [],
      };
    }
    sync();
  }

  function branchPopoverFilter(value) {
    const list = bar.branchList;
    if (!list || list.loading) return;
    list.filter = String(value || "");
    if (list.filter.trim()) {
      // Typing a filter needs the full remote list, same as the drawer.
      list.remoteLoaded = true;
      list.remoteLoading = true;
      const requestId = Date.now();
      list.remoteRequestId = requestId;
      sync();
      focusPopoverInput(".location-bar-branch-popover .git-ui-branch-list-filter input", list.filter);
      api(`/api/git-ui/branches?cwd=${encodeURIComponent(currentCwd())}`)
        .then((data) => {
          if (!bar.branchList || bar.branchList.remoteRequestId !== requestId) return;
          const existing = new Map((bar.branchList.remote || []).map((branch) => [branch.name, branch]));
          (data.remote || []).forEach((branch) => existing.set(branch.name, branch));
          bar.branchList.remote = [...existing.values()];
        })
        .catch(() => {})
        .finally(() => {
          if (bar.branchList && bar.branchList.remoteRequestId === requestId) {
            bar.branchList.remoteLoading = false;
            sync();
            focusPopoverInput(".location-bar-branch-popover .git-ui-branch-list-filter input", bar.branchList.filter);
          }
        });
      return;
    }
    list.remoteLoading = false;
    // Re-render only the popover: a full innerHTML rewrite would drop the
    // filter input's focus and caret.
    const node = barNode();
    const existing = node && node.querySelector && node.querySelector(".location-bar-branch-popover");
    if (!existing || !document.createElement) {
      sync();
      return;
    }
    const template = document.createElement("div");
    template.innerHTML = renderBranchPopover();
    const next = template.firstElementChild;
    if (!next) {
      sync();
      return;
    }
    existing.replaceWith(next);
    const input = next.querySelector(".git-ui-branch-list-filter input");
    if (input && typeof input.focus === "function") {
      input.focus();
      try {
        const length = String(value || "").length;
        input.setSelectionRange(length, length);
      } catch (_) {}
    }
    lastHtml = node.innerHTML;
    lastSignature = renderSignature(currentCwd(), gitFacts(selectedWorkspace(), currentCwd()));
  }

  function loadMoreBranches() {
    if (!bar.branchList) return;
    bar.branchList.remoteLoaded = true;
    sync();
  }

  async function switchBranchFromPopover(encodedName, isRemote) {
    const name = decodeURIComponent(String(encodedName || ""));
    const cwd = currentCwd();
    const list = bar.branchList;
    if (!cwd || !name || !list) return;
    if (popoverContextStale(list)) return; // opening outlived its workspace or folder
    closeBranchPopover();
    const localName = isRemote ? name.split("/").slice(1).join("/") : name;
    if (!localName) return;
    if (localName === String(list.currentBranch || "")) return;
    if (!window.confirm(`Switch workspace branch to "${name}"?`)) return;
    try {
      if (typeof showBlocking === "function") showBlocking(`Switching to ${name}`);
      await api("/api/git-ui/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch: localName }),
      });
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
    if (typeof render === "function") render();
  }

  // Trash icon in a popover row: same endpoint the cleanup view uses.
  // Remote rows and the current branch are refused (the backend also
  // refuses the checked-out branch).
  async function deleteBranchFromPopover(encodedName, isRemote) {
    const name = decodeURIComponent(String(encodedName || ""));
    const cwd = currentCwd();
    const list = bar.branchList;
    if (!cwd || !name || !list) return;
    if (popoverContextStale(list)) return; // opening outlived its workspace or folder
    if (isRemote) {
      bar.branchList.error = "Deleting remote branches is not supported here";
      sync();
      return;
    }
    if (name === String(list.currentBranch || "")) return;
    if (!window.confirm(`Delete branch "${name}"?`)) return;
    const filter = String(bar.branchList.filter || "");
    bar.branchList = {
      ...bar.branchList,
      loading: true,
      error: "",
      local: [],
      remote: [],
      filter,
    };
    sync();
    try {
      await api("/api/git-ui/branch-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch: name, force: false, confirmed: true }),
      });
      const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(cwd)}`);
      if (bar.branchList)
        bar.branchList = {
          ...bar.branchList,
          loading: false,
          error: "",
          local: data.local || [],
          remote: data.remote || [],
        };
    } catch (err) {
      if (bar.branchList)
        bar.branchList = {
          ...bar.branchList,
          loading: false,
          error: err.message || String(err),
          local: [],
          remote: [],
        };
    }
    sync();
  }

  function newBranchDraft(value) {
    if (!bar.branchList) return;
    bar.branchList.newBranch = String(value || "");
  }

  function newBranchKeydown(event) {
    if (event && event.key === "Enter") {
      event.preventDefault();
      createBranchFromPopover();
    }
  }

  // New branch stays in the same workspace (plan decision 5): the switch
  // endpoint with create:true checks out a new branch at the given base.
  async function createBranchFromPopover() {
    const list = bar.branchList;
    const cwd = currentCwd();
    const name = String((list && list.newBranch) || "").trim();
    if (!list || !cwd || !name || list.creating) return;
    if (popoverContextStale(list)) return; // opening outlived its workspace or folder
    const base = String(list.currentBranch || "HEAD") || "HEAD";
    if (!window.confirm(`Create and switch to branch "${name}" from "${base}"?`)) return;
    list.creating = true;
    sync();
    try {
      if (typeof showBlocking === "function") showBlocking(`Creating ${name}`);
      await api("/api/git-ui/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch: name, create: true, base }),
      });
      closeBranchPopover();
    } catch (err) {
      list.creating = false;
      list.error = err.message || String(err);
      sync();
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
    if (typeof render === "function") render();
  }

  // Document-level dismissal for the popover: any click outside the
  // popover or its chip closes it.
  // The listener lives for the module's lifetime; without a popover open
  // it only walks a short classList chain and returns.
  function eventInsidePopover(event, popoverClass, chipClass) {
    let target = event && event.target;
    while (target && target.classList) {
      if (target.classList.contains(popoverClass) || target.classList.contains(chipClass)) return true;
      target = target.parentNode;
    }
    return false;
  }
  function eventInsideBranchPopover(event) {
    return eventInsidePopover(event, "location-bar-branch-popover", "location-bar-branch-chip");
  }
  function eventInsideWorktreePopover(event) {
    return eventInsidePopover(event, "location-bar-worktree-popover", "location-bar-worktree-chip");
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", (event) => {
      if (bar.branchList && !eventInsideBranchPopover(event)) closeBranchPopover();
      if (bar.worktreeList && !eventInsideWorktreePopover(event)) closeWorktreePopover();
    });
    // Esc closes any open popover from anywhere. Document capture: the
    // drawer's keyboard handler runs on window capture, ahead of this
    // listener, so it yields first when a bar popover is open (its
    // locationBarPopoverOpen check) and the bar sees the key here.
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && (bar.branchList || bar.worktreeList)) {
          event.stopPropagation();
          event.preventDefault();
          closeBranchPopover();
          closeWorktreePopover();
        }
      },
      true,
    );
  }

  // The bar reuses the drawer's chip classes, but git-ui.css lazy-loads
  // with the drawer. Pull it once on the first visible sync so the chips
  // are styled before the drawer ever opens.
  let chipCssLoaded = false;
  function ensureChipCss() {
    if (chipCssLoaded) return;
    chipCssLoaded = true;
    if (window.HerdrLoadCss) window.HerdrLoadCss("/assets/desktop/git-ui.css");
    else if (document.querySelector && !document.querySelector('link[href="/assets/desktop/git-ui.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/assets/desktop/git-ui.css";
      document.head.appendChild(link);
    }
  }

  function sync() {
    const node = barNode();
    if (!node) return;
    const workspace = selectedWorkspace();
    const cwd = workspaceCwd(workspace);
    // A popover belongs to the workspace and folder it was opened for.
    // A selection change (workspace switch, folder switch) invalidates
    // its rows: they describe another repo, and acting on them would
    // target the wrong checkout.
    if (bar.branchList && popoverContextStale(bar.branchList)) {
      bar.branchList = null;
    }
    if (bar.worktreeList && popoverContextStale(bar.worktreeList)) {
      bar.worktreeList = null;
    }
    // Hidden without a selected workspace or an empty path; the bar is a
    // workspace-scoped surface, not a global one.
    if (!workspace || !cwd) {
      if (!node.hidden) node.hidden = true;
      if (node.innerHTML) node.innerHTML = "";
      lastSignature = null;
      lastHtml = "";
      return;
    }
    ensureChipCss();
    const facts = gitFacts(workspace, cwd);
    const signature = renderSignature(cwd, facts);
    if (signature === lastSignature && node.innerHTML === lastHtml) return;
    const html = renderBar(workspace, cwd, facts);
    if (node.hidden) node.hidden = false;
    node.innerHTML = html;
    lastSignature = signature;
    lastHtml = html;
  }

  // ── Worktree popover (plan phase 4) ─────────────────────────────
  // Rows list every checkout of the selected workspace's repository; a
  // row select routes through the shared folder-change flow, so the whole
  // shell (terminal, explorer, panes) follows the new checkout while old
  // workspace panels stay open. Create opens the worktree modal prefilled
  // with the current branch.

  function worktreePopoverRow(worktree, currentPath) {
    const path = String(worktree.path || "");
    const current = samePath(path, currentPath);
    const label = String(worktree.label || pathBasename(path) || "worktree");
    const branch = String(worktree.branch || "detached");
    const check = current ? `<b class="git-ui-worktree-check" title="Current worktree">✓</b>` : "";
    return `<button class="git-ui-worktree-option${current ? " current" : ""}" onclick="HerdrLocationBar.selectWorktreeFromPopover('${encodeArg(path)}')"><strong>${check}${escapeHtml(label)}</strong><small>${escapeHtml(branch)} · ${escapeHtml(path)}</small></button>`;
  }

  function renderWorktreePopover() {
    const list = bar.worktreeList;
    if (!list) return "";
    const anchor = list.anchor || { left: 10, top: 40, width: 320 };
    const style = `left:${Math.max(8, anchor.left)}px;top:${anchor.top}px;width:${anchor.width}px`;
    if (list.loading)
      return `<div class="git-ui-branch-list git-ui-worktree-list location-bar-worktree-popover" style="${style}" onclick="event.stopPropagation()"><div class="git-ui-loading"><span></span><strong>Loading worktrees</strong></div></div>`;
    const rows = (list.worktrees || []).map((worktree) => worktreePopoverRow(worktree, list.currentPath)).join("");
    const body = list.error
      ? `<div class="git-ui-error">${escapeHtml(list.error)}</div>`
      : rows || `<div class="git-ui-muted git-ui-branch-list-empty">No worktrees detected</div>`;
    return `<div class="git-ui-branch-list git-ui-worktree-list location-bar-worktree-popover" style="${style}" onclick="event.stopPropagation()">${body}<button class="git-ui-worktree-create" onclick="HerdrLocationBar.createWorktreeFromPopover()">＋ Create worktree</button></div>`;
  }

  function closeWorktreePopover() {
    if (!bar.worktreeList) return;
    bar.worktreeList = null;
    sync();
  }

  async function openWorktreePopover(event) {
    const cwd = currentCwd();
    if (!cwd) return;
    if (event && event.stopPropagation) event.stopPropagation();
    // Only one popover at a time: opening one closes the other.
    closeBranchPopover();
    if (bar.worktreeList && !bar.worktreeList.loading) {
      closeWorktreePopover();
      return;
    }
    bar.worktreeList = {
      loading: true,
      error: "",
      worktrees: [],
      currentPath: cwd,
      anchor: anchorFromEvent(event, ".location-bar-worktree-chip:not([disabled])"),
      // Same identity contract as the branch popover: completions and
      // row actions belong to this opening only.
      requestId: nextPopoverRequestId(),
      wsId: String(state.ws || ""),
      cwd,
    };
    const request = bar.worktreeList.requestId;
    sync();
    try {
      const data = await api(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`);
      const result = data.result || data;
      if (!bar.worktreeList || bar.worktreeList.requestId !== request) return; // superseded while loading
      bar.worktreeList = {
        ...bar.worktreeList,
        loading: false,
        error: "",
        worktrees: result.worktrees || [],
      };
    } catch (err) {
      if (!bar.worktreeList || bar.worktreeList.requestId !== request) return;
      bar.worktreeList = {
        ...bar.worktreeList,
        loading: false,
        error: err.message || String(err),
        worktrees: [],
      };
    }
    sync();
  }

  async function selectWorktreeFromPopover(encodedPath) {
    const path = decodeURIComponent(String(encodedPath || ""));
    const cwd = currentCwd();
    const list = bar.worktreeList;
    if (!path || !cwd || samePath(path, cwd)) return;
    if (popoverContextStale(list)) return; // opening outlived its workspace or folder
    closeWorktreePopover();
    if (!window.confirm(`Switch workspace to worktree folder "${path}"?`)) return;
    if (!window.HerdrOpenFolder || !window.HerdrOpenFolder.openFolderAsWorkspace) {
      alert("Folder switching is unavailable");
      return;
    }
    try {
      await window.HerdrOpenFolder.openFolderAsWorkspace(path);
    } catch (err) {
      alert(err.message || String(err));
    }
  }

  function createWorktreeFromPopover() {
    const cwd = currentCwd();
    const workspace = selectedWorkspace();
    const list = bar.worktreeList;
    if (popoverContextStale(list)) return; // opening outlived its workspace or folder
    const facts = workspace ? gitFacts(workspace, cwd) : { branch: "" };
    closeWorktreePopover();
    if (typeof openWorktreeCreateFromGitBranch === "function") {
      openWorktreeCreateFromGitBranch(cwd, facts.branch || "");
    } else if (typeof openWorktreeOpenModal === "function") {
      openWorktreeOpenModal(cwd, true);
    }
  }

  // Path chip: opens the directory picker on the workspace folder. The
  // picker's selectCurrent dispatches change on the hidden input (the same
  // contract the worktree selector rows use), and the change
  // handler runs the shared folder-change flow. A no-op pick (same path)
  // keeps everything untouched.
  let pickerInput = null;
  function openPathPicker() {
    const workspace = selectedWorkspace();
    const cwd = workspaceCwd(workspace);
    if (!cwd) return;
    const picker = window.HerdrDirectoryPicker;
    if (!picker || typeof picker.open !== "function") return;
    if (pickerInput && pickerInput.parentNode) pickerInput.remove();
    pickerInput = document.createElement("input");
    pickerInput.type = "text";
    pickerInput.style.display = "none";
    pickerInput.value = cwd;
    pickerInput.addEventListener("change", () => {
      const target = String(pickerInput.value || "").trim();
      if (pickerInput.parentNode) pickerInput.remove();
      pickerInput = null;
      if (!target || samePath(target, cwd)) return;
      if (!window.HerdrOpenFolder) return;
      window.HerdrOpenFolder.openFolderAsWorkspace(target).catch((error) =>
        alert(error.message || String(error)),
      );
    });
    document.body.appendChild(pickerInput);
    picker.open(pickerInput);
  }

  window.HerdrLocationBar = {
    sync,
    openPathPicker,
    openBranchPopover,
    closeBranchPopover,
    branchPopoverFilter,
    loadMoreBranches,
    switchBranchFromPopover,
    deleteBranchFromPopover,
    newBranchDraft,
    newBranchKeydown,
    createBranchFromPopover,
    openWorktreePopover,
    closeWorktreePopover,
    selectWorktreeFromPopover,
    createWorktreeFromPopover,
  };
})();
