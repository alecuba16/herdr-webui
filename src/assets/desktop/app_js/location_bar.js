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
  const escapeAttr =
    helpers.escapeAttr ||
    ((v) =>
      String(v == null ? "" : v)
        .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
        .replace(/'/g, "&#39;"));
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
  // remoteLoaded, remoteLoading, remoteRequestId). discoveryList is the
  // open-folder surface (open-folder-redesign.md): a fresh probe after
  // a directory-picker pick decides whether it renders worktree rows,
  // branch rows, or an error with a fallback footer.
  const bar = {
    branchList: null,
    worktreeList: null,
    discoveryList: null,
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
    // Discovery token (open-folder-redesign.md): mode plus the fields
    // that change the rendered popover, so popover-only updates repaint
    // the bar without a shell-wide render.
    const discovery = bar.discoveryList;
    const discoveryToken = !discovery
      ? "-"
      : [
          "open",
          discovery.loading ? "l" : "",
          discovery.mode || "",
          discovery.error || "",
          (discovery.worktrees || []).length,
          (discovery.local || []).length,
          (discovery.remote || []).length,
          discovery.filter || "",
          discovery.currentBranch || "",
          discovery.newBranch || "",
          discovery.newBase || "",
          discovery.baseLoaded ? "B" : "",
          discovery.repoLabel || "",
          discovery.requestId,
          discovery.folder,
          discovery.remoteLoaded,
          discovery.remoteLoading,
          discovery.baseLoading,
          discovery.baseError,
          discovery.baseRemoteLoaded,
          discovery.createMode,
          discovery.creating,
          discovery.createError,
          discovery.sourceLoading,
          discovery.sourceError,
          !!discovery.source,
          JSON.stringify(discovery.baseOptions || []),
        ].join(":");
    return [state.ws, cwd, facts.branch || "", !!facts.known, !!facts.notGit, branchToken, worktreeToken, discoveryToken].join("|");
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
    return `<button class="git-ui-branch-chip location-bar-${name}-chip" type="button"${disabled ? " disabled" : ""}${chipClick(name)} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><i class="location-bar-chip-icon location-bar-chip-icon-${name}" aria-hidden="true"></i><span class="git-ui-branch-chip-name">${body}</span></button>`;
  }

  function separator() {
    return `<span class="git-ui-selector-separator" aria-hidden="true">/</span>`;
  }

  function emptyBar() {
    // Boot shape: no workspace selected. The strip stays visible as a
    // stable surface (it never appears or disappears while opening
    // workspaces) with the one action this state admits: opening the
    // workspace picker, the same modal the palette's open-workspace
    // action and the project dashboard button already open.
    return `<button class="location-bar-empty" type="button" onclick="runSearchAction('open-workspace')" title="Open a workspace folder" aria-label="Open workspace"><i class="location-bar-chip-icon location-bar-chip-icon-path" aria-hidden="true"></i><span>Open workspace</span></button>`;
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
      (bar.worktreeList ? renderWorktreePopover() : "") +
      (bar.discoveryList ? renderDiscoveryPopover() : "")
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

  function branchListRow(branch, currentBranch, action) {
    const name = String(branch.name || "");
    const isCurrent = !branch.remote && name === currentBranch;
    const checkout = !branch.remote && !isCurrent ? branchCheckoutPath(bar.branchList, name) : null;
    const author = String(branch.author || "");
    const date = String(branch.date || "");
    const subject = String(branch.subject || "");
    const exact = date ? new Date(date).toLocaleString() : "";
    const hover = [author && `${author}`, exact, subject && `"${subject}"`].filter(Boolean).join(" · ");
    const icon = isCurrent ? `<b class="git-ui-branch-row-check" role="img" aria-label="Current branch" title="Current branch">✓</b>` : `<b class="git-ui-branch-row-icon" aria-hidden="true"></b>`;
    const meta = [author, branchRelativeTime(date)].filter(Boolean).join(" · ");
    // Checked-out-elsewhere rows keep the switch action, which reroutes to
    // the worktree, and say so on the row.
    const badge = branch.remote
      ? `<i class="git-ui-branch-row-remote">remote</i>`
      : checkout
        ? `<i class="git-ui-branch-row-remote" title="Checked out in ${escapeAttr(checkout)}">worktree</i>`
        : "";
    // Trash only on non-current rows; it stops propagation so the row
    // switch does not fire.
    const trash = isCurrent
      ? ""
      : `<button class="git-ui-branch-row-trash" title="Delete branch" aria-label="Delete branch ${escapeHtml(name)}" onclick="event.stopPropagation();HerdrLocationBar.deleteBranchFromPopover('${encodeArg(name)}',${branch.remote ? "true" : "false"})"><span></span></button>`;
    return `<div class="git-ui-branch-row${isCurrent ? " current" : ""}" title="${escapeHtml(hover)}">
          <button class="git-ui-branch-row-main"${action ? ` data-discovery-focus="branch-${encodeArg(name)}-local"` : ""} onclick="${action || `HerdrLocationBar.switchBranchFromPopover('${encodeArg(name)}',${branch.remote ? "true" : "false"})`}">
            <span class="git-ui-branch-row-name">${icon}<span class="git-ui-branch-row-name-text">${escapeHtml(name)}</span>${badge}</span>
            <span class="git-ui-branch-row-meta">${escapeHtml(meta)}</span>
          </button>${trash}
        </div>`;
  }

  // Create-worktree row under the branch sections. Sits inside the
  // scrolled rows area so it reads as a sibling action of the branch
  // list, not a header control. The bar's branch-only shape (plain
  // checkout: path + branch chips, no worktree chip) has no other surface
  // that can start a worktree, so this row is what makes creation
  // reachable there. Carries the createWorktreeFromBranchPopover
  // contract: worktree add refuses a branch already checked out, the
  // create modal surfaces that before the POST.
  function branchPopoverWorktreeRow(list) {
    const branch = String((list && list.currentBranch) || "");
    return `<button class="git-ui-worktree-create" title="Create a new worktree from this branch" aria-label="Create worktree" onclick="HerdrLocationBar.createWorktreeFromBranchPopover('${encodeArg(branch)}')">＋ Create worktree</button>`;
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
      return `<div class="git-ui-branch-list location-bar-branch-popover" role="dialog" aria-label="Branches" style="${style}" onclick="event.stopPropagation()"><div class="git-ui-loading"><span></span><strong>Loading branches</strong></div></div>`;
    const body = list.error
      ? `<div class="git-ui-error">${escapeHtml(list.error)}</div>`
      : branchPopoverRows(list);
    const draft = String(list.newBranch || "");
    const createDisabled = list.creating ? " disabled" : "";
    return `<div class="git-ui-branch-list location-bar-branch-popover" role="dialog" aria-label="Branches" style="${style}" onclick="event.stopPropagation()">${body}<label class="git-ui-branch-list-new"><span>New branch from ${escapeHtml(list.currentBranch || "HEAD")}</span><div class="git-ui-inline-field"><input value="${escapeHtml(draft)}" placeholder="branch-name" aria-label="New branch name"${inputAttrs("done")} oninput="HerdrLocationBar.newBranchDraft(this.value)" onkeydown="HerdrLocationBar.newBranchKeydown(event)"><button class="git-ui-btn" type="button"${createDisabled} onclick="HerdrLocationBar.createBranchFromPopover()">Create</button></div></label><label class="git-ui-branch-list-filter"><span>Filter</span><input value="${escapeHtml(list.filter || "")}" placeholder="Type to filter" aria-label="Filter branches"${inputAttrs("search")} oninput="HerdrLocationBar.branchPopoverFilter(this.value)"></label></div>`;
  }

  // The branches payload stamps each branch with the worktree folder it
  // is checked out in (git worktree list), null when none. A checkout
  // that matches the popover's own folder is the current branch, not a
  // destination; anything else means the row must reroute to that
  // folder instead of posting a switch git will refuse.
  function branchCheckoutPath(list, localName) {
    if (!list || !localName) return null;
    const rows = (list.local || []).concat(list.remote || []);
    for (const branch of rows) {
      if (!branch || branch.remote) continue;
      if (String(branch.name || "") !== String(localName)) continue;
      const path = String(branch.worktree_path || "");
      if (!path) return null;
      return samePath(path, list.cwd) ? null : path;
    }
    return null;
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
    return `<div class="git-ui-branch-list-scroll">${rows(local, "Local branches")}${rows(remote, "Remote branches")}${loadingRemote}${loadMore}${empty}${branchPopoverWorktreeRow(list)}</div>`;
  }

  function anchorFromEvent(event, chipSelector) {
    // Keyboard entry (the b shortcut) passes no event: anchor on the
    // chip itself so the popover still hangs off the bar.
    const target =
      (event && event.currentTarget) ||
      (document.querySelector && document.querySelector(chipSelector || ".location-bar-branch-chip:not([disabled])"));
    const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    if (!rect) return { left: 10, top: 40, width: 360 };
    const viewport = window.innerWidth || 1200;
    const maxWidth = Math.min(420, Math.max(280, viewport - rect.left - 16));
    // Never overflow the right edge: shift back and shrink when the chip
    // sits close to it.
    const left = Math.min(rect.left, Math.max(8, viewport - maxWidth - 16));
    return { left, top: rect.bottom + 4, width: maxWidth };
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

  // The chip that opened the popover, so dismissal can hand focus back.
  // Opening a popover focuses its input; after Esc the user expects to
  // land on the chip again, not on a removed element or the page body.
  let branchChipInvoker = null;
  let worktreeChipInvoker = null;

  function refocusChip(element) {
    if (!element || typeof element.focus !== "function") return;
    try {
      if (!element.disabled) element.focus();
    } catch (_) {}
  }

  function closeBranchPopover() {
    if (!bar.branchList) return;
    bar.branchList = null;
    const chipNode = branchChipInvoker;
    branchChipInvoker = null;
    sync();
    refocusChip(chipNode);
  }

  async function openBranchPopover(event) {
    const cwd = currentCwd();
    if (!cwd) return;
    if (event && event.stopPropagation) event.stopPropagation();
    // Only one popover at a time: opening one closes the others.
    closeWorktreePopover();
    closeDiscoveryPopover();
    // Re-open toggle: clicking the chip again closes the popover.
    if (bar.branchList && !bar.branchList.loading) {
      closeBranchPopover();
      return;
    }
    // Keyboard entry passes no event: fall back to the chip in the DOM so
    // dismissal still hands focus somewhere on the bar.
    branchChipInvoker =
      (event && event.currentTarget) ||
      (document.querySelector && document.querySelector(".location-bar-branch-chip:not([disabled])")) ||
      null;
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
    // A branch checked out in another worktree cannot be switched to in
    // place (git refuses a second checkout): the row hands the user to
    // that worktree through the same folder-change flow the worktree
    // popover rows use, which focuses an open workspace on the folder or
    // opens one.
    const checkout = branchCheckoutPath(list, localName);
    if (checkout) {
      if (!window.confirm(`Switch to branch "${localName}" in its worktree "${checkout}"?`)) return;
      if (!window.HerdrOpenFolder || !window.HerdrOpenFolder.openFolderAsWorkspace) {
        alert("Folder switching is unavailable");
        return;
      }
      try {
        await window.HerdrOpenFolder.openFolderAsWorkspace(checkout);
      } catch (err) {
        alert(err.message || String(err));
      }
      return;
    }
    if (!window.confirm(`Switch workspace branch to "${name}"?`)) return;
    try {
      if (typeof showBlocking === "function") showBlocking(`Switching to ${name}`);
      await api("/api/git-ui/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch: localName }),
      });
      // HEAD moved outside the drawer: its cached views for this folder
      // still describe the old branch.
      if (window.HerdrGitUi && window.HerdrGitUi.notifyBranchChanged)
        window.HerdrGitUi.notifyBranchChanged(cwd);
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
      // Same contract as a plain switch: the drawer must not keep serving
      // the pre-create status and diffs.
      if (window.HerdrGitUi && window.HerdrGitUi.notifyBranchChanged)
        window.HerdrGitUi.notifyBranchChanged(cwd);
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
  function eventInsideDiscoveryPopover(event) {
    // The picker selection click can bubble after its change handler opened discovery.
    return eventInsidePopover(event, "location-bar-discovery-popover", "location-bar-path-chip") ||
      eventInsidePopover(event, "directory-picker-backdrop", "directory-picker-backdrop");
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", (event) => {
      if (bar.branchList && !eventInsideBranchPopover(event)) closeBranchPopover();
      if (bar.worktreeList && !eventInsideWorktreePopover(event)) closeWorktreePopover();
      if (bar.discoveryList && !eventInsideDiscoveryPopover(event)) closeDiscoveryPopover();
    });
    // Esc closes any open popover from anywhere. Document capture: the
    // drawer's keyboard handler runs on window capture, ahead of this
    // listener, so it yields first when a bar popover is open (its
    // locationBarPopoverOpen check) and the bar sees the key here.
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && (bar.branchList || bar.worktreeList || bar.discoveryList)) {
          event.stopPropagation();
          event.preventDefault();
          closeBranchPopover();
          closeWorktreePopover();
          closeDiscoveryPopover();
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
    if (bar.discoveryList && discoveryContextStale(bar.discoveryList)) bar.discoveryList = null;
    // Always visible (a stable surface, never appearing mid-session); no
    // workspace or no folder path renders the empty hint instead.
    if (!workspace || !cwd) {
      const html = emptyBar();
      if (node.innerHTML !== html) node.innerHTML = html;
      if (node.hidden) node.hidden = false;
      lastSignature = null;
      lastHtml = html;
      return;
    }
    ensureChipCss();
    const facts = gitFacts(workspace, cwd);
    const signature = renderSignature(cwd, facts);
    if (signature === lastSignature && node.innerHTML === lastHtml) return;
    const html = renderBar(workspace, cwd, facts);
    const focus = captureDiscoveryFocus();
    if (node.hidden) node.hidden = false;
    node.innerHTML = html;
    restoreDiscoveryFocus(focus);
    lastSignature = signature;
    lastHtml = html;
  }

  // ── Worktree popover (plan phase 4) ─────────────────────────────
  // Rows list every checkout of the selected workspace's repository; a
  // row select routes through the shared folder-change flow, so the whole
  // shell (terminal, explorer, panes) follows the new checkout while old
  // workspace panels stay open. Create opens the worktree modal prefilled
  // with the current branch.

  function worktreePopoverRow(worktree, currentPath, onclick) {
    const path = String(worktree.path || "");
    const current = samePath(path, currentPath);
    const label = String(worktree.label || pathBasename(path) || "worktree");
    const branch = String(worktree.branch || "detached");
    const check = current ? `<b class="git-ui-worktree-check" role="img" aria-label="Current worktree" title="Current worktree">✓</b>` : "";
    const action = onclick || `HerdrLocationBar.selectWorktreeFromPopover('${encodeArg(path)}')`;
    return `<button class="git-ui-worktree-option${current ? " current" : ""}"${onclick ? ` data-discovery-focus="worktree-${encodeArg(path)}"` : ""} onclick="${action}"><strong>${check}${escapeHtml(label)}</strong><small>${escapeHtml(branch)} · ${escapeHtml(path)}</small></button>`;
  }

  function renderWorktreePopover() {
    const list = bar.worktreeList;
    if (!list) return "";
    const anchor = list.anchor || { left: 10, top: 40, width: 320 };
    const style = `left:${Math.max(8, anchor.left)}px;top:${anchor.top}px;width:${anchor.width}px`;
    if (list.loading)
      return `<div class="git-ui-branch-list git-ui-worktree-list location-bar-worktree-popover" role="dialog" aria-label="Worktrees" style="${style}" onclick="event.stopPropagation()"><div class="git-ui-loading"><span></span><strong>Loading worktrees</strong></div></div>`;
    const rows = (list.worktrees || []).map((worktree) => worktreePopoverRow(worktree, list.currentPath)).join("");
    const body = list.error
      ? `<div class="git-ui-error">${escapeHtml(list.error)}</div>`
      : rows || `<div class="git-ui-muted git-ui-branch-list-empty">No worktrees detected</div>`;
    return `<div class="git-ui-branch-list git-ui-worktree-list location-bar-worktree-popover" role="dialog" aria-label="Worktrees" style="${style}" onclick="event.stopPropagation()">${body}<button class="git-ui-worktree-create" onclick="HerdrLocationBar.createWorktreeFromPopover()">＋ Create worktree</button></div>`;
  }

  function closeWorktreePopover() {
    if (!bar.worktreeList) return;
    bar.worktreeList = null;
    const chipNode = worktreeChipInvoker;
    worktreeChipInvoker = null;
    sync();
    refocusChip(chipNode);
  }

  async function openWorktreePopover(event) {
    const cwd = currentCwd();
    if (!cwd) return;
    if (event && event.stopPropagation) event.stopPropagation();
    // Only one popover at a time: opening one closes the others.
    closeBranchPopover();
    closeDiscoveryPopover();
    if (bar.worktreeList && !bar.worktreeList.loading) {
      closeWorktreePopover();
      return;
    }
    worktreeChipInvoker =
      (event && event.currentTarget) ||
      (document.querySelector && document.querySelector(".location-bar-worktree-chip:not([disabled])")) ||
      null;
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

  // Same modal entry the worktree popover uses, prefilled with the row's
  // branch. Git refuses a second checkout of an already-checked-out branch,
  // so the modal (discoverWorktrees stamps the checked-out rows) is the one
  // surface that can catch it before the POST.
  function createWorktreeFromBranchPopover(encodedName) {
    const name = decodeURIComponent(String(encodedName || ""));
    const cwd = currentCwd();
    const list = bar.branchList;
    if (!cwd || !name || !list) return;
    if (popoverContextStale(list)) return; // opening outlived its workspace or folder
    closeBranchPopover();
    if (typeof openWorktreeCreateFromGitBranch === "function") {
      openWorktreeCreateFromGitBranch(cwd, name);
    } else if (typeof openWorktreeOpenModal === "function") {
      openWorktreeOpenModal(cwd, true);
    }
  }

  // Discovery rows capture the picked folder independently of shell navigation.

  function discoveryPopoverClasses() {
    return "git-ui-branch-list git-ui-worktree-list location-bar-discovery-popover";
  }

  function discoveryContextStale(list) {
    return !list || String(list.wsId || "") !== String(state.ws || "") || !samePath(list.originCwd, currentCwd());
  }

  function discoveryOpeningActive(list) {
    return bar.discoveryList === list && !discoveryContextStale(list);
  }

  function discoveryRequestActive(request) {
    return bar.discoveryList && bar.discoveryList.requestId === request && !discoveryContextStale(bar.discoveryList);
  }

  function captureDiscoveryFocus() {
    const active = document.activeElement;
    if (!active || !active.closest || !active.closest(".location-bar-discovery-popover")) return null;
    return { id: active.id, key: active.getAttribute && active.getAttribute("data-discovery-focus"), start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
  }

  function restoreDiscoveryFocus(saved) {
    if (!saved || !bar.discoveryList) return;
    const target = (saved.id ? document.getElementById(saved.id) : saved.key && document.querySelector(`[data-discovery-focus="${saved.key}"]`)) || document.querySelector('.location-bar-discovery-popover[data-discovery-focus="dialog"]');
    if (!target || !target.focus) return;
    target.focus();
    if (target.scrollIntoView) target.scrollIntoView({ block: "nearest" });
    try { if (saved.start != null) target.setSelectionRange(saved.start, saved.end, saved.direction); } catch (_) {}
  }

  function renderDiscoveryPopover() {
    const list = bar.discoveryList;
    if (!list) return "";
    const anchor = list.anchor || { left: 10, top: 40, width: 360 };
    const style = `left:${Math.max(8, anchor.left)}px;top:${anchor.top}px;width:${anchor.width}px;--discovery-top:${anchor.top}px`;
    const label = escapeHtml(list.repoLabel || pathBasename(list.folder) || list.folder);
    const head = `<div class="git-ui-branch-list-section">${label}${list.folder ? `<div class="location-bar-discovery-path">${escapeHtml(list.folder)}</div>` : ""}</div>`;
    const footer = `<div class="location-bar-discovery-footer"><button class="git-ui-btn" data-discovery-focus="footer" type="button"${list.creating ? " disabled" : ""} onclick="HerdrLocationBar.discoveryOpenPlain()">Open folder as workspace</button></div>`;
    if (list.loading)
      return `<div class="${discoveryPopoverClasses()}" data-discovery-focus="dialog" tabindex="-1" role="dialog" aria-label="Open ${escapeHtml(list.folder || "folder")}" style="${style}" onclick="event.stopPropagation()">${head}<div class="git-ui-loading" role="status"><span></span><strong>Discovering folder</strong></div>${footer}</div>`;
    if (list.error)
      return `<div class="${discoveryPopoverClasses()}" data-discovery-focus="dialog" tabindex="-1" role="dialog" aria-label="Open ${escapeHtml(list.folder || "folder")}" style="${style}" onclick="event.stopPropagation()">${head}<div class="git-ui-error" role="alert">${escapeHtml(list.error)}</div>${footer}</div>`;
    const body = list.mode === "worktrees" ? discoveryWorktreeRows(list) + (list.createMode === "worktree" ? discoveryCreateForm(list) : "") : discoveryBranchBody(list);
    const frozenBody = list.creating ? body.replace(/<(button|input)\b(?![^>]*\sdisabled(?:\s|>|=))/g, '<$1 disabled') : body;
    return `<div class="${discoveryPopoverClasses()}" data-discovery-focus="dialog" tabindex="-1" role="dialog" aria-label="Choose ${list.mode === "worktrees" ? "worktree" : "branch"} in ${escapeHtml(list.folder)}" style="${style}" onclick="event.stopPropagation()">${head}${frozenBody}${footer}</div>`;
  }

  function discoveryWorktreeRows(list) {
    // Discovery must not read the chip popover's null opening state.
    const rows = (list.worktrees || [])
      .map((worktree) => worktreePopoverRow(worktree, list.folder, `HerdrLocationBar.discoveryWorktreeRowOpen('${encodeArg(String(worktree.path || ""))}')`))
      .join("");
    const body = rows || `<div class="git-ui-muted git-ui-branch-list-empty">No worktrees detected</div>`;
    return `<div class="git-ui-branch-list-scroll">${body}<button class="git-ui-worktree-create" data-discovery-focus="create-worktree" title="Create a new worktree for this repository" aria-label="Create worktree" onclick="HerdrLocationBar.discoveryCreateWorktree()">＋ Create worktree</button></div>`;
  }

  // Current-row decoration is shared, but discovery owns opening and switching.
  function discoveryBranchRow(branch, list) {
    const name = String(branch.name || "");
    const isCurrent = !branch.remote && name === String(list.currentBranch || "");
    if (isCurrent) return branchListRow(branch, String(list.currentBranch || ""), `HerdrLocationBar.discoveryBranchRowOpen('${encodeArg(name)}',false)`);
    // The discovery popover swaps the chip's in-place switch for the
    // open-then-switch contract: the folder may not be open at all yet.
    const main = `<button class="git-ui-branch-row-main" data-discovery-focus="branch-${encodeArg(name)}-${branch.remote ? "remote" : "local"}" onclick="HerdrLocationBar.discoveryBranchRowOpen('${encodeArg(name)}',${branch.remote ? "true" : "false"})"><span class="git-ui-branch-row-name"><b class="git-ui-branch-row-icon" aria-hidden="true"></b><span class="git-ui-branch-row-name-text">${escapeHtml(name)}</span>${branch.remote ? `<i class="git-ui-branch-row-remote">remote</i>` : ""}</span><span class="git-ui-branch-row-meta">${escapeHtml([String(branch.author || ""), branchRelativeTime(branch.date)].filter(Boolean).join(" · "))}</span></button>`;
    return `<div class="git-ui-branch-row" title="${escapeHtml([branch.author && String(branch.author), String(branch.date || "") && new Date(branch.date).toLocaleString(), branch.subject && `\"${branch.subject}\"`].filter(Boolean).join(" · "))}">${main}</div>`;
  }

  function discoveryBranchBody(list) {
    const filter = String(list.filter || "").toLowerCase();
    const matches = (branch) => !filter || String(branch.name || "").toLowerCase().includes(filter);
    const localAll = (list.local || []).filter(matches);
    const currentRows = localAll.filter((branch) => !branch.remote && branch.name === String(list.currentBranch || ""));
    const local = currentRows.concat(localAll.filter((branch) => !currentRows.includes(branch)));
    const remoteAll = (list.remote || []).filter(matches);
    const preferred = (branch) => {
      const name = String(branch.name || "").replace(/^origin\//, "");
      if (name === "main" || name === "master" || name === String(list.currentBranch || "")) return 0;
      if (name.startsWith(`${list.currentBranch}/`) || String(list.currentBranch || "").startsWith(`${name}/`)) return 1;
      return 2;
    };
    const remoteOrdered = remoteAll.slice().sort((left, right) => preferred(left) - preferred(right));
    const remote = list.remoteLoaded ? remoteAll : remoteOrdered.slice(0, remoteBranchPreload());
    const rows = (branches, label) => !branches.length ? "" : `<div class="git-ui-branch-list-section">${label}</div>${branches.map((branch) => discoveryBranchRow(branch, list)).join("")}`;
    const empty = !local.length && !remote.length ? `<div class="git-ui-muted git-ui-branch-list-empty">${filter ? "No branches match" : "No branches yet"}</div>` : "";
    const loadingRemote = list.remoteLoading ? `<div class="git-ui-branch-loading">Loading remote branches…</div>` : "";
    const loadMore = !list.remoteLoading && !list.remoteLoaded && remoteAll.length > remote.length
      ? `<button class="git-ui-branch-load-more" data-discovery-focus="load-more" onclick="HerdrLocationBar.discoveryLoadMore()">Load more branches (${remoteAll.length - remote.length} more)</button>`
      : "";
    const create = discoveryCreateForm(list);
    const worktreeRow = `<button class="git-ui-worktree-create" data-discovery-focus="create-worktree" title="Create a new worktree for this repository" aria-label="Create worktree" onclick="HerdrLocationBar.discoveryCreateWorktree()">＋ Create worktree</button>`;
    return `<label class="git-ui-branch-list-filter"><span>Filter</span><input id="locationBarDiscoveryFilter" value="${escapeHtml(list.filter || "")}" placeholder="Type to filter" aria-label="Filter branches"${inputAttrs("search")} oninput="HerdrLocationBar.discoveryFilter(this.value)"></label><div class="git-ui-branch-list-scroll">${rows(local, "Local branches")}${rows(remote, "Remote branches")}${loadingRemote}${loadMore}${empty}${worktreeRow}</div>${create}`;
  }

  function discoveryCreateForm(list) {
    const worktree = list.createMode === "worktree";
    const unavailable = worktree && (!list.source || list.sourceLoading || !!list.sourceError);
    const baseOptions = (list.baseOptions || []).map((ref) => `<option value="${escapeAttr(ref)}"></option>`).join("");
    const baseDatalist = `<datalist id="${discoveryBaseDatalistId}">${baseOptions}</datalist>`;
    const basePickerExtra = `<button class="git-ui-btn" type="button" data-discovery-focus="load-refs" aria-disabled="${list.baseLoading || list.creating ? "true" : "false"}" onclick="HerdrLocationBar.discoveryLoadBaseOptions()">Load refs</button><button class="git-ui-btn" type="button" data-discovery-focus="fetch-remotes" aria-disabled="${list.baseLoading || list.creating ? "true" : "false"}" onclick="HerdrLocationBar.discoveryLoadBaseOptions(true)">Fetch remotes</button>`;
    const baseFeedback = list.baseLoading ? `<div role="status">Loading refs…</div>` : list.baseError ? `<div class="git-ui-error" role="alert">${escapeHtml(list.baseError)} Use free text or retry Load refs / Fetch remotes.</div>` : "";
    const feedback = worktree ? (list.sourceLoading ? `<div role="status">Loading worktree source…</div>` : list.sourceError ? `<div class="git-ui-error" role="alert">${escapeHtml(list.sourceError)}</div><button class="git-ui-btn" type="button" data-discovery-focus="retry-worktree-source" onclick="HerdrLocationBar.discoveryRetryWorktreeSource()">Retry worktree source</button>` : "") + (list.creating ? `<div role="status" data-discovery-focus="worktree-status">Creating worktree</div><div class="git-ui-muted">Closing this dialog does not cancel creation</div>` : list.createError ? `<div class="git-ui-error" role="alert">${escapeHtml(list.createError)}</div>` : "") : "";
    return `${baseDatalist}<div class="git-ui-branch-list-new${worktree ? " location-bar-discovery-worktree-form" : ""}"><label for="locationBarDiscoveryName">${worktree ? "Worktree branch name" : "New branch name"}</label><div class="git-ui-inline-field"><input id="locationBarDiscoveryName" value="${escapeHtml(list.newBranch || "")}" placeholder="branch-name"${inputAttrs("done")} onfocus="HerdrLocationBar.discoveryLoadBaseOptions(false, true)" oninput="HerdrLocationBar.discoveryDraft('newBranch', this.value)" onkeydown="HerdrLocationBar.discoveryCreateKeydown(event)"></div><label for="locationBarDiscoveryBase">Base ref</label><div class="git-ui-inline-field"><input id="locationBarDiscoveryBase" value="${escapeHtml(list.newBase || "")}" list="${discoveryBaseDatalistId}" placeholder="default ${escapeHtml(list.currentBranch || "HEAD")}"${inputAttrs("done")} onfocus="HerdrLocationBar.discoveryLoadBaseOptions(false, true)" oninput="HerdrLocationBar.discoveryDraft('newBase', this.value)" onkeydown="HerdrLocationBar.discoveryCreateKeydown(event)"><button class="git-ui-btn" type="button" data-discovery-focus="create"${list.creating || unavailable || !String(list.newBranch || "").trim() ? " disabled" : ""} onclick="HerdrLocationBar.${worktree ? "discoverySubmitWorktree" : "discoveryCreateBranch"}()">${worktree ? (list.creating ? "Creating worktree" : list.createError ? "Retry worktree creation" : "Create worktree") : "Create"}</button>${worktree ? `<button class="git-ui-btn" type="button" data-discovery-focus="cancel-worktree" onclick="HerdrLocationBar.discoveryCancelWorktree()">Cancel worktree</button>` : ""}</div><div class="git-ui-inline-field">${basePickerExtra}</div>${baseFeedback}${feedback}</div>`;
  }

  const discoveryBaseDatalistId = "locationBarDiscoveryBaseOptions";

  // A failed switch leaves the successfully opened folder on its original branch.
  async function discoveryOpenFolderAndSwitch(folder, branch, create, base) {
    const list = bar.discoveryList;
    if (!list || !folder || !branch) return;
    const label = create ? `Create and switch to "${branch}"${base ? ` from "${base}"` : ""}` : `Switch to "${branch}"`;
    if (!window.confirm(`${label} when opening "${folder}"?`)) return;
    if (!discoveryOpeningActive(list)) return;
    closeDiscoveryPopover();
    try {
      if (typeof showBlocking === "function") showBlocking(`Opening ${pathBasename(folder) || folder}`);
      await openFolderForDiscovery(folder);
    } catch (err) {
      alert(err.message || String(err));
      return;
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
    try {
      if (typeof showBlocking === "function") showBlocking(create ? `Creating ${branch}` : `Switching to ${branch}`);
      const body = { cwd: folder, branch };
      if (create) {
        body.create = true;
        body.base = base || String(list.currentBranch || "") || "HEAD";
      }
      await api("/api/git-ui/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (window.HerdrGitUi && window.HerdrGitUi.notifyBranchChanged)
        window.HerdrGitUi.notifyBranchChanged(folder);
      else if (typeof window.HerdrShellNoteBranchMoved === "function")
        window.HerdrShellNoteBranchMoved(folder);
    } catch (err) {
      alert(`"${folder}" opened on its current branch. ${create ? "Branch creation" : "Branch switch"} failed: ${err.message || String(err)}`);
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
    if (typeof render === "function") render();
  }

  // Same-folder destinations need no navigation before switching.
  async function openFolderForDiscovery(folder) {
    const flow = window.HerdrOpenFolder;
    if (!flow) throw Error("Folder opening is unavailable");
    if (samePath(folder, currentCwd())) return;
    await flow.openFolderAsWorkspace(folder);
  }

  async function discoveryBranchRowOpen(encodedName, isRemote) {
    const list = bar.discoveryList;
    if (!list || discoveryContextStale(list) || list.creating) return;
    const name = decodeURIComponent(String(encodedName || ""));
    const folder = String(list.folder || "");
    if (!name || !folder) return;
    const localName = isRemote ? name.split("/").slice(1).join("/") : name;
    if (!localName) return;
    const row = (list.local || []).concat(list.remote || []).find(
      (branch) => String(branch.name || "") === name && !!branch.remote === !!isRemote,
    );
    const checkout = row && !isRemote ? String(row.worktree_path || "") : "";
    // Destination 1: the branch is already checked out elsewhere; open
    // that worktree instead of posting a switch git would refuse.
    if (checkout && !samePath(checkout, folder)) {
      if (!window.confirm(`Open worktree "${checkout}" where "${localName}" is checked out?`)) return;
      if (!discoveryOpeningActive(list)) return;
      closeDiscoveryPopover();
      try {
        await openFolderForDiscovery(checkout);
      } catch (err) {
        alert(err.message || String(err));
      }
      return;
    }
    // Destination 2: the picked folder's current branch; a plain open
    // is the whole action.
    if (localName === String(list.currentBranch || "")) {
      closeDiscoveryPopover();
      try {
        await openFolderForDiscovery(folder);
      } catch (err) {
        alert(err.message || String(err));
      }
      return;
    }
    await discoveryOpenFolderAndSwitch(folder, localName, false, "");
  }

  async function discoveryCreateBranch() {
    const list = bar.discoveryList;
    if (!list || discoveryContextStale(list) || list.creating || list.createMode === "worktree") return;
    const name = String(list.newBranch || "").trim();
    const folder = String(list.folder || "");
    if (!name || !folder) return;
    const base = String(list.newBase || "").trim() || String(list.currentBranch || "") || "HEAD";
    await discoveryOpenFolderAndSwitch(folder, name, true, base);
  }

  function discoveryCreateKeydown(event) {
    if (event && event.key === "Enter") {
      event.preventDefault();
      return bar.discoveryList && bar.discoveryList.createMode === "worktree" ? discoverySubmitWorktree() : discoveryCreateBranch();
    }
  }

  async function discoveryCreateWorktree() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.loading || list.error || list.creating) return;
    list.createMode = "worktree";
    sync();
    restoreDiscoveryFocus({ id: "locationBarDiscoveryName" });
    if (!list.source) await discoveryRetryWorktreeSource();
  }

  function discoveryCancelWorktree() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating) return;
    list.createMode = "branch";
    sync();
    restoreDiscoveryFocus({ key: "create-worktree" });
  }

  function discoverySourceAvailable(source) {
    return !!(source && String(source.repo_root || "").trim() && String(source.repo_name || "").trim());
  }

  async function discoveryRetryWorktreeSource() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating || list.sourceLoading || list.createMode !== "worktree") return;
    list.sourceLoading = true;
    list.sourceError = "";
    sync();
    try {
      const data = await api(`/api/worktrees?cwd=${encodeURIComponent(list.folder)}`);
      if (!discoveryOpeningActive(list)) return;
      const source = (data.result || {}).source;
      if (!discoverySourceAvailable(source)) throw Error("Worktree source is unavailable. Retry before creating.");
      list.source = source;
    } catch (err) {
      if (discoveryOpeningActive(list)) list.sourceError = err.message || String(err);
    } finally {
      if (discoveryOpeningActive(list)) {
        list.sourceLoading = false;
        sync();
      }
    }
  }

  async function discoverySubmitWorktree() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.createMode !== "worktree" || list.creating || list.sourceLoading || !discoverySourceAvailable(list.source) || list.sourceError) return;
    const branch = String(list.newBranch || "").trim();
    if (!branch) return;
    const base = String(list.newBase || "").trim() || String(list.currentBranch || "") || "HEAD";
    let body;
    try {
      const root = worktreeRootForSource(list.source);
      const path = root && joinPath(root, list.source.repo_name, branchPathSlug(branch));
      if (!path) throw Error("Worktree checkout path is unavailable.");
      body = buildWorktreeCreateBody({ source: { cwd: list.folder, workspace_id: null }, branch, base, path, label: null, pullBase: false });
    } catch (err) {
      list.createError = err.message || String(err);
      sync();
      revealDiscoveryWorktreeError();
      return;
    }
    list.creating = true;
    list.createError = "";
    sync();
    try {
      const data = await api("/api/worktrees", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!discoveryOpeningActive(list)) return;
      const result = data.result || {};
      if (!result.workspace || !result.workspace.workspace_id) throw Error("Created worktree response has no workspace.");
      closeDiscoveryPopover();
      go(result.workspace.workspace_id, result.tab && result.tab.tab_id, result.root_pane && result.root_pane.pane_id);
    } catch (err) {
      if (discoveryOpeningActive(list)) list.createError = err.message || String(err);
    } finally {
      if (discoveryOpeningActive(list)) {
        list.creating = false;
        sync();
        if (list.createError) revealDiscoveryWorktreeError();
      }
    }
  }

  function revealDiscoveryWorktreeError() {
    restoreDiscoveryFocus({ key: "create" });
    const alert = document.querySelector('.location-bar-discovery-worktree-form .git-ui-error[role="alert"]');
    if (alert && alert.scrollIntoView) alert.scrollIntoView({ block: "nearest" });
  }

  // A discovery worktree row: same contract as the branch rows, minus
  // the switch (opening the worktree is the whole action).
  async function discoveryWorktreeRowOpen(encodedPath) {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating) return;
    const path = decodeURIComponent(String(encodedPath || ""));
    if (!path) return;
    if (!window.confirm(`Open worktree "${path}"?`)) return;
    if (!discoveryOpeningActive(list)) return;
    closeDiscoveryPopover();
    try {
      if (typeof showBlocking === "function") showBlocking(`Opening ${pathBasename(path) || path}`);
      await openFolderForDiscovery(path);
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  async function discoveryOpenPlain() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating) return;
    const folder = String(list.folder || "");
    if (!folder) return;
    // The footer cancels the probe: bump the requestId so late
    // completions land on a dead opening.
    list.requestId = nextPopoverRequestId();
    closeDiscoveryPopover();
    try {
      if (typeof showBlocking === "function") showBlocking(`Opening ${pathBasename(folder) || folder}`);
      await openFolderForDiscovery(folder);
    } catch (err) {
      // Only the specific git-detection failure permits direct plain creation.
      if (isNotGitRepoError(err) && !discoveryContextStale(list)) {
        try {
          await createPlainWorkspaceOnFolder(folder, list);
        } catch (createErr) {
          alert(createErr.message || String(createErr));
        }
      } else {
        alert(err.message || String(err));
      }
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  function isNotGitRepoError(err) {
    return String((err && err.message) || err || "").toLowerCase().includes("not a git repository");
  }

  async function createPlainWorkspaceOnFolder(folder, origin) {
    const flow = window.HerdrOpenFolder;
    if (!flow || !flow.createPlainWorkspace) throw Error("Folder opening is unavailable");
    const previous = state.ws;
    if (flow.focusWorkspaceOnFolder && await flow.focusWorkspaceOnFolder(folder)) {
      if (flow.autoCloseLeftWorkspace) await flow.autoCloseLeftWorkspace(previous);
      return;
    }
    if (origin && discoveryContextStale(origin)) return;
    const created = await flow.createPlainWorkspace(folder, previous);
    return created;
  }

  function discoveryFilter(value) {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.loading || list.creating) return;
    list.filter = String(value || "");
    const requestId = nextPopoverRequestId();
    list.remoteRequestId = requestId;
    if (list.filter.trim()) {
      list.remoteLoaded = true;
      list.remoteLoading = true;
      sync();
      api(`/api/git-ui/branches?cwd=${encodeURIComponent(String(list.folder || ""))}`)
        .then((data) => {
          if (!discoveryOpeningActive(list) || list.remoteRequestId !== requestId) return;
          const existing = new Map((bar.discoveryList.remote || []).map((branch) => [branch.name, branch]));
          (data.remote || []).forEach((branch) => existing.set(branch.name, branch));
          bar.discoveryList.remote = [...existing.values()];
        })
        .catch(() => {})
        .finally(() => {
          if (discoveryOpeningActive(list) && list.remoteRequestId === requestId) {
            bar.discoveryList.remoteLoading = false;
            sync();
          }
        });
      return;
    }
    list.remoteLoading = false;
    sync();
  }

  function discoveryLoadMore() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating) return;
    list.remoteLoaded = true;
    sync();
  }

  function discoveryDraft(field, value) {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating || (field !== "newBranch" && field !== "newBase")) return;
    list[field] = String(value || "");
    const createButton = document.querySelector && document.querySelector('.location-bar-discovery-popover [data-discovery-focus="create"]');
    if (createButton) createButton.disabled = list.creating || !String(list.newBranch || "").trim() || (list.createMode === "worktree" && (!list.source || list.sourceLoading || !!list.sourceError));
  }

  async function discoveryLoadBaseOptions(fetchRemotes = false, fromFocus = false) {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list) || list.creating || list.baseLoading || (fromFocus && list.baseLoaded && !fetchRemotes)) return;
    if (fromFocus && list.baseError) return;
    const folder = String(list.folder || "");
    if (!folder) return;
    list.baseLoading = true;
    list.baseError = "";
    sync();
    try {
      const url = `/api/git-branches?cwd=${encodeURIComponent(folder)}`;
      let localData = fetchRemotes ? null : await api(url);
      if (!discoveryOpeningActive(list)) return;
      const data = await api(`${url}&remote=true${fetchRemotes ? "&fetch=true" : ""}`);
      if (!discoveryOpeningActive(list)) return;
      if (fetchRemotes) localData = await api(url);
      if (!discoveryOpeningActive(list)) return;
      list.baseOptions = [...new Set((localData.branches || []).concat(data.branches || []).map(String))];
      list.baseLoaded = true;
      if (fetchRemotes) list.baseRemoteLoaded = true;
    } catch (err) {
      if (discoveryOpeningActive(list)) {
        list.baseError = err.message || String(err);
        list.baseLoaded = false;
      }
    } finally {
      if (discoveryOpeningActive(list)) {
        list.baseLoading = false;
        sync();
      }
    }
  }

  function refocusPathChip() {
    const node = document.querySelector && document.querySelector(".location-bar-path-chip");
    refocusChip(node);
  }

  function closeDiscoveryPopover() {
    if (!bar.discoveryList) return;
    bar.discoveryList = null;
    sync();
    refocusPathChip();
  }

  function isNotGitRepositoryMessage(message) {
    return String(message || "").toLowerCase().includes("not a git repository");
  }

  // Both probe completions must still belong to the same opening and shell origin.
  async function openDiscoveryForFolder(folder) {
    const target = String(folder || "").replace(/\/+$/, "") || "/";
    closeBranchPopover();
    closeWorktreePopover();
    const anchor = anchorFromEvent(null, ".location-bar-path-chip");
    bar.discoveryList = {
      loading: true,
      error: "",
      mode: "",
      folder: target,
      worktrees: [],
      local: [],
      remote: [],
      filter: "",
      currentBranch: "",
      remoteLoaded: false,
      remoteLoading: false,
      remoteRequestId: 0,
      newBranch: "",
      newBase: "",
      creating: false,
      createMode: "branch",
      createError: "",
      source: null,
      sourceLoading: false,
      sourceError: "",
      baseOptions: [],
      baseLoaded: false,
      baseLoading: false,
      baseError: "",
      baseRemoteLoaded: false,
      repoLabel: "",
      anchor,
      requestId: nextPopoverRequestId(),
      wsId: String(state.ws || ""),
      originCwd: currentCwd(),
    };
    const request = bar.discoveryList.requestId;
    sync();
    const dialog = document.querySelector && document.querySelector('.location-bar-discovery-popover[data-discovery-focus="dialog"]');
    if (dialog && dialog.focus) dialog.focus();
    try {
      const data = await api(`/api/worktrees?cwd=${encodeURIComponent(target)}`);
      if (!discoveryRequestActive(request)) return;
      const rows = ((data && data.result) || {}).worktrees || [];
      const source = ((data && data.result) || {}).source || {};
      bar.discoveryList.source = discoverySourceAvailable(source) ? source : null;
      const repoLabel = String(source.repo_name || source.repo_key || source.repo_root || "");
      bar.discoveryList.repoLabel = repoLabel;
      if (rows.length >= 2) {
        bar.discoveryList = {
          ...bar.discoveryList,
          loading: false,
          mode: "worktrees",
          worktrees: rows,
          currentBranch: String((rows.slice().sort((a, b) => String(b.path || "").length - String(a.path || "").length).find((row) => samePath(row.path, target) || target.startsWith(String(row.path || "").replace(/\/+$/, "") + "/")) || {}).branch || ""),
          repoLabel,
        };
        sync();
        focusDiscoveryAfterLoad();
        return;
      }
    } catch (err) {
      if (!discoveryRequestActive(request)) return;
      // A failed worktree probe alone cannot prove the folder is non-git.
      bar.discoveryList.probe1Error = err.message || String(err);
    }
    // Probe 2: single checkout or plain folder.
    try {
      const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(target)}`);
      if (!discoveryRequestActive(request)) return;
      const currentRow = (data.local || []).find((b) => b && b.current);
      bar.discoveryList = {
        ...bar.discoveryList,
        loading: false,
        mode: "branches",
        local: data.local || [],
        remote: data.remote || [],
        currentBranch: currentRow && currentRow.name ? String(currentRow.name) : "",
      };
      sync();
      focusDiscoveryAfterLoad();
    } catch (err) {
      if (!discoveryRequestActive(request)) return;
      if (isNotGitRepositoryMessage(err.message || String(err))) {
        const origin = bar.discoveryList;
        bar.discoveryList = null;
        sync();
        try {
          if (typeof showBlocking === "function") showBlocking(`Opening ${pathBasename(target) || target}`);
          if (!discoveryContextStale(origin)) await createPlainWorkspaceOnFolder(target, origin);
        } catch (openErr) {
          alert(openErr.message || String(openErr));
        } finally {
          if (typeof hideBlocking === "function") hideBlocking();
        }
        return;
      }
      bar.discoveryList = {
        ...bar.discoveryList,
        loading: false,
        error: err.message || String(err),
      };
      sync();
    }
  }

  function focusDiscoveryAfterLoad() {
    const list = bar.discoveryList;
    if (!discoveryOpeningActive(list)) return;
    requestAnimationFrame(() => {
      if (!discoveryOpeningActive(list)) return;
      const active = document.activeElement;
      if (active && active !== document.body && !(active.getAttribute && active.getAttribute("data-discovery-focus") === "dialog")) return;
      const selector = list.mode === "worktrees" ? ".git-ui-worktree-option" : ".git-ui-branch-list-filter input";
      const target = document.querySelector(`.location-bar-discovery-popover ${selector}`);
      if (target && target.focus) target.focus();
    });
  }

  // Same-folder picks discover too; only the chosen destination can skip navigation.
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
      if (!target) return;
      // Routed through the exported namespace so harness stubs and the
      // real bundle resolve the same entry point.
      window.HerdrLocationBar.openDiscoveryForFolder(target);
    });
    document.body.appendChild(pickerInput);
    picker.open(pickerInput);
  }

  window.HerdrLocationBar = {
    sync,
    openPathPicker,
    openDiscoveryForFolder,
    closeDiscoveryPopover,
    discoveryOpenPlain,
    discoveryWorktreeRowOpen,
    discoveryBranchRowOpen,
    discoveryCreateBranch,
    discoveryCreateWorktree,
    discoverySubmitWorktree,
    discoveryCancelWorktree,
    discoveryRetryWorktreeSource,
    discoveryFilter,
    discoveryLoadMore,
    discoveryDraft,
    discoveryCreateKeydown,
    discoveryLoadBaseOptions,
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
    createWorktreeFromBranchPopover,
  };
})();
