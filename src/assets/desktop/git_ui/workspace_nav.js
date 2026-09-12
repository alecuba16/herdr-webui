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
      view.historyCommitHash = "";
      view.historySource = "";
      view.fileBackTarget = null;
      view.navigationStack = [];
      view.mode = "changes";
      view.tab = "changes";
    }

    function clonePlain(value, fallback) {
      try { return JSON.parse(JSON.stringify(value == null ? fallback : value)); }
      catch (_) { return fallback; }
    }

    function currentNavigationLabel(view) {
      if (!view) return "Git";
      if (view.tab === "history" && view.file) return `History · ${view.file}`;
      if (view.tab === "log" && view.logFilePath) return `Log · ${view.logFilePath}`;
      if (view.tab === "log") return "Log";
      if (view.tab === "stash" && view.selectedStash) return `Stash · ${view.selectedStash}`;
      if (view.tab === "stash") return "Stash";
      if (view.tab === "cleanup") return "Cleanup";
      if (view.fileBackTarget && view.fileBackTarget.type === "log") return `Committed file · ${view.file || "file"}`;
      if (view.temporaryHistoryCompare && view.file) return `Committed file · ${view.file}`;
      if (view.file) return currentMode() === "changes" ? `Current file · ${view.file}` : `Compared file · ${view.file}`;
      return currentMode() === "changes" ? "Current changes" : "Compared changes";
    }

    function captureNavigationSnapshot(view, label) {
      if (!view) return null;
      const content = document.querySelector(".git-ui-content");
      if (content && preserveContentScroll(view.tab)) view.contentScrollTop = content.scrollTop;
      return {
        label: label || currentNavigationLabel(view),
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
        temporaryHistoryCompare: !!view.temporaryHistoryCompare,
        historyCommitHash: view.historyCommitHash || "",
        historySource: view.historySource || "",
        fileBackTarget: clonePlain(view.fileBackTarget, null),
        contentScrollTop: view.contentScrollTop || 0,
        sideScrollTop: state.sideScrollTop || 0,
      };
    }

    function pushNavigationSnapshot(view, label) {
      const snapshot = captureNavigationSnapshot(view, label);
      if (!snapshot) return;
      const stack = (view.navigationStack || []).filter(Boolean);
      const last = stack[stack.length - 1];
      const signature = `${snapshot.tab}|${snapshot.mode}|${snapshot.file}|${snapshot.compareBase}|${snapshot.compareTarget}|${snapshot.selectedLogCommits.join(",")}|${snapshot.logFilePath}`;
      const lastSignature = last ? `${last.tab}|${last.mode}|${last.file}|${last.compareBase}|${last.compareTarget}|${(last.selectedLogCommits || []).join(",")}|${last.logFilePath}` : "";
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
      view.temporaryHistoryCompare = !!snapshot.temporaryHistoryCompare;
      view.historyCommitHash = snapshot.historyCommitHash || "";
      view.historySource = snapshot.historySource || "";
      view.fileBackTarget = clonePlain(snapshot.fileBackTarget, null);
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

    function renderNavigationTrail(view) {
      const stack = ((view && view.navigationStack) || []).filter(Boolean);
      if (!stack.length) return "";
      const labels = stack.map((item) => item.label || "Git").concat(currentNavigationLabel(view));
      const title = labels.join(" › ");
      const visible = stack.length > 2
        ? [stack[0], { label: "…", ellipsis: true }, stack[stack.length - 1]]
        : stack;
      const crumbs = visible.map((item) => item.ellipsis
        ? `<span class="git-ui-breadcrumb-ellipsis" title="${esc(title)}">…</span>`
        : `<span class="git-ui-breadcrumb-step" title="${esc(item.label || "Git")}">${esc(item.label || "Git")}</span>`)
        .join(`<span class="git-ui-breadcrumb-sep">›</span>`);
      return `<span class="git-ui-breadcrumbs" title="${esc(title)}"><button class="git-ui-btn" title="Go back to previous Git view" onclick="HerdrGitUi.goBack()">← Back</button>${crumbs}<span class="git-ui-breadcrumb-sep">›</span><strong title="${esc(currentNavigationLabel(view))}">${esc(currentNavigationLabel(view))}</strong></span>`;
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
      currentNavigationLabel,
      captureNavigationSnapshot,
      pushNavigationSnapshot,
      restoreNavigationSnapshot,
      renderNavigationTrail,
      workspaceStatus,
      compactPath,
    };
  }
  globalThis.HerdrGitUiWorkspaceNavModule = { create: createGitUiWorkspaceNav };
})();
