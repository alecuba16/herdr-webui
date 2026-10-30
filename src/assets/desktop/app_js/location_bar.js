// Desktop location bar: the folder / worktree / branch strip above the
// workspace panes. Independent shell module (same family as
// workspace_panes.js): own state, own signature-based sync called from
// render(), no dependency on the lazily-loaded git_ui drawer. Git facts
// come from cached data only (rail-status parks, the worktrees list, the
// server branch attribution), never a fetch of its own.
(function () {
  const helpers = globalThis.HerdrAppHelpers || {};
  const escapeHtml = helpers.escapeHtml || ((v) => String(v == null ? "" : v));
  const pathBasename =
    helpers.pathBasename ||
    ((p) => String(p || "").split("/").filter(Boolean).pop() || "");
  // One signature per render: polls that change nothing must not touch the
  // bar DOM (a later phase mounts a filter input and popovers here).
  let lastSignature = null;
  let lastHtml = "";

  function samePath(left, right) {
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    if (!a || !b) return false;
    const norm = (p) => (p === "/" ? "/" : p.replace(/\/+$/, ""));
    return norm(a) === norm(b);
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
    return [state.ws, cwd, facts.branch || "", !!facts.known, !!facts.notGit].join("|");
  }

  // Chip click handlers. Only the path chip acts in phase 2 (opens the
  // directory picker); branch and worktree chips get their popovers in
  // phases 3-4.
  function chipClick(name) {
    if (name === "path") return ' onclick="HerdrLocationBar.openPathPicker()"';
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
    return chips.join("");
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

  // Path chip: opens the directory picker on the workspace folder. The
  // picker's selectCurrent dispatches change on the hidden input (the
  // drawer's openCwdPicker uses the same contract), and the change handler
  // runs the shared folder-change flow. A no-op pick (same path) keeps
  // everything untouched.
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

  window.HerdrLocationBar = { sync, openPathPicker };
})();