(function () {
  function createGitUiWorkspaceNav({ state, currentMode, normalizeLogScope, preserveContentScroll, loadDiff, loadSelectedCommitPreview, render, esc, GIT_LOG_PAGE_SIZE }) {
    function workspaceCwd(workspace) {
      if (!workspace) return "";
      if (window.HerdrWorkspacePath) return window.HerdrWorkspacePath(workspace);
      if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
      if (workspace.cwd) return workspace.cwd;
      if (workspace.path) return workspace.path;
      return "";
    }

    function workspaceTitle(workspace) {
      if (!workspace) return "Git";
      if (workspace.worktree) {
        return workspace.worktree.branch || workspace.label || workspace.worktree.checkout_path || "worktree";
      }
      return workspace.label || "main/master";
    }

    function workspaceKey(workspace) {
      return (workspace && workspace.workspace_id) || workspaceCwd(workspace) || "default";
    }

    function normalizePathForCompare(path) {
      const text = String(path || "").trim();
      if (!text) return "";
      return text === "/" ? "/" : text.replace(/\/+$/, "");
    }

    function samePath(left, right) {
      return normalizePathForCompare(left) === normalizePathForCompare(right);
    }

    function gitCwdMatchesWorkspace(view) {
      if (!view || !view.workspaceCwd) return true;
      return samePath(view.cwd, view.workspaceCwd);
    }

    function resetGitViewForCwd(view, cwd) {
      view.cwd = cwd;
      view.file = "";
      view.status = null;
      view.diff = null;
      view.compareBase = "";
      view.compareTarget = "";
      view.compareFilePaths = [];
      view.selectedLogCommits = [];
      view.selectedCommitPreview = null;
      view.logFilePath = "";
      view.selectedStash = "";
      view.selectedStashDiff = null;
      view.stashFile = "";
      view.stashData = null;
      view.committedFile = null;
      view.navigationStack = [];
      view.mode = "changes";
      view.tab = "changes";
    }

    function clonePlain(value, fallback) {
      try { return JSON.parse(JSON.stringify(value == null ? fallback : value)); }
      catch (_) { return fallback; }
    }

    // Breadcrumbs are derived from the current view state, never from the
    // navigation stack, so the location bar always answers "where am I".
    function viewCrumbs(view) {
      if (!view) return ["Git"];
      const file = String(view.file || "");
      if (view.tab === "history") return file ? ["Changes", file, "History"] : ["History"];
      if (view.tab === "log") return view.logFilePath ? ["Log", view.logFilePath] : ["Log"];
      if (view.tab === "stash") return view.selectedStash ? ["Stash", view.selectedStash] : ["Stash"];
      if (view.tab === "cleanup") return ["Cleanup"];
      if (view.tab === "conflicts") return ["Changes", "Conflicts"];
      const committed = view.committedFile;
      if (committed && file) {
        const base = committed.from === "history" ? "History" : "Log";
        const hash = String(committed.hash || "");
        return [base, file, hash ? `Committed ${hash.slice(0, 12)}` : "Committed file"];
      }
      if (file) return currentMode() === "changes" ? ["Changes", file] : ["Compare", file];
      return currentMode() === "changes" ? ["Changes"] : ["Compare"];
    }

    function renderLocationBar(view) {
      const crumbs = viewCrumbs(view);
      const title = crumbs.join(" › ");
      const parts = crumbs.map((label, index) => index === crumbs.length - 1
        ? `<strong title="${esc(label)}">${esc(label)}</strong>`
        : `<span class="git-ui-breadcrumb-step" title="${esc(label)}">${esc(label)}</span>`).join(`<span class="git-ui-breadcrumb-sep">›</span>`);
      const clearScope = view && view.tab === "log" && view.logFilePath
        ? `<button class="git-ui-crumb-clear" title="Show log for the whole repository" onclick="HerdrGitUi.clearLogFileHistory()">×</button>`
        : "";
      return `<div class="git-ui-location-bar"><button class="git-ui-btn" title="Go back to previous Git view" onclick="HerdrGitUi.goBack()">← Back</button><span class="git-ui-breadcrumbs" title="${esc(title)}">${parts}</span>${clearScope}</div>`;
    }

    function captureNavigationSnapshot(view, label) {
      if (!view) return null;
      const content = document.querySelector(".git-ui-content");
      if (content && preserveContentScroll(view.tab)) view.contentScrollTop = content.scrollTop;
      return {
        label: label || viewCrumbs(view).join(" › "),
        tab: view.tab || "changes",
        mode: view.mode || "changes",
        file: view.file || "",
        diffKind: view.diffKind || "",
        diffScope: view.diffScope || "all",
        compareBase: view.compareBase || "",
        compareTarget: view.compareTarget || "",
        compareFilePaths: clonePlain(view.compareFilePaths, []),
        selectedLogCommits: clonePlain(view.selectedLogCommits, []),
        selectedCommitPreview: clonePlain(view.selectedCommitPreview, null),
        logFilePath: view.logFilePath || "",
        logLimit: view.logLimit || GIT_LOG_PAGE_SIZE,
        logScope: view.logScope || (view.logAll ? "all" : "base-current"),
        logAll: !!view.logAll,
        logFilters: clonePlain(view.logFilters, { description: "", date: "", author: "" }),
        fileFilter: view.fileFilter || "",
        committedFile: clonePlain(view.committedFile, null),
        contentScrollTop: view.contentScrollTop || 0,
        sideScrollTop: state.sideScrollTop || 0,
      };
    }

    function pushNavigationSnapshot(view, label) {
      const snapshot = captureNavigationSnapshot(view, label);
      if (!snapshot) return;
      const stack = (view.navigationStack || []).filter(Boolean);
      const last = stack[stack.length - 1];
      const signature = `${snapshot.tab}|${snapshot.mode}|${snapshot.file}|${snapshot.compareBase}|${snapshot.compareTarget}|${snapshot.selectedLogCommits.join(",")}|${snapshot.logFilePath}|${(snapshot.committedFile && snapshot.committedFile.hash) || ""}`;
      const lastSignature = last ? `${last.tab}|${last.mode}|${last.file}|${last.compareBase}|${last.compareTarget}|${(last.selectedLogCommits || []).join(",")}|${last.logFilePath}|${((last.committedFile && last.committedFile.hash) || "")}` : "";
      if (signature === lastSignature) return;
      view.navigationStack = stack.concat(snapshot).slice(-12);
    }

    async function restoreNavigationSnapshot(view, snapshot) {
      if (!view || !snapshot) return;
      view.tab = snapshot.tab || "changes";
      view.mode = snapshot.mode || "changes";
      view.file = snapshot.file || "";
      view.diffKind = snapshot.diffKind || "";
      view.diffScope = snapshot.diffScope || "all";
      view.compareBase = snapshot.compareBase || "";
      view.compareTarget = snapshot.compareTarget || "";
      view.compareFilePaths = clonePlain(snapshot.compareFilePaths, []);
      view.selectedLogCommits = clonePlain(snapshot.selectedLogCommits, []);
      view.selectedCommitPreview = clonePlain(snapshot.selectedCommitPreview, null);
      view.logFilePath = snapshot.logFilePath || "";
      view.logLimit = snapshot.logLimit || GIT_LOG_PAGE_SIZE;
      view.logScope = normalizeLogScope(snapshot.logScope || (snapshot.logAll ? "all" : "base-current"));
      view.logAll = view.logScope === "all";
      view.logFilters = clonePlain(snapshot.logFilters, { description: "", date: "", author: "" });
      view.fileFilter = snapshot.fileFilter || "";
      view.committedFile = clonePlain(snapshot.committedFile, null);
      view.contentScrollTop = snapshot.contentScrollTop || 0;
      state.sideScrollTop = snapshot.sideScrollTop || 0;
      view.sideEditor = null;
      if (view.tab === "changes") {
        await loadDiff();
        return;
      }
      if (view.tab === "log" && view.selectedLogCommits.length === 1 && (!view.selectedCommitPreview || view.selectedCommitPreview.hash !== view.selectedLogCommits[0])) {
        loadSelectedCommitPreview(view, view.selectedLogCommits[0]);
      }
      render();
    }

    function workspaceStatus(key, workspace) {
      if (!workspace || !workspaceCwd(workspace)) return "nogit";
      const view = state.cache[key || workspaceKey(workspace)];
      if (view && view.error) return "nogit";
      if (state.visible && state.activeKey === (key || workspaceKey(workspace))) return "open";
      return "closed";
    }

    function compactPath(path) {
      const parts = String(path || "").split("/").filter(Boolean);
      if (parts.length <= 3) return path || "No repo path";
      return `.../${parts.slice(-3).join("/")}`;
    }
    return {
      workspaceCwd,
      workspaceTitle,
      workspaceKey,
      normalizePathForCompare,
      samePath,
      gitCwdMatchesWorkspace,
      resetGitViewForCwd,
      clonePlain,
      viewCrumbs,
      renderLocationBar,
      captureNavigationSnapshot,
      pushNavigationSnapshot,
      restoreNavigationSnapshot,
      workspaceStatus,
      compactPath,
    };
  }
  globalThis.HerdrGitUiWorkspaceNavModule = { create: createGitUiWorkspaceNav };
})();
