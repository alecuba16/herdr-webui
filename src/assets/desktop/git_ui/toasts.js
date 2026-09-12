(function () {
  function createGitUiToasts({ state, active, api, esc, arg, render, ensurePanel, navigator, setTimeoutFn }) {
      function normalizeRemoteUrl(raw) {
        let value = String(raw || "").trim();
        if (!value) return "";
        const scp = value.match(/^git@([^:]+):(.+)$/);
        if (scp) value = `https://${scp[1]}/${scp[2]}`;
        if (value.startsWith("ssh://git@")) value = value.replace(/^ssh:\/\/git@/, "https://");
        value = value.replace(/\.git$/, "");
        try {
          const url = new URL(value);
          return /^https?:$/.test(url.protocol) ? url.toString().replace(/\/$/, "") : "";
        } catch (_) {
          return "";
        }
      }

      function branchPath(branch) {
        return String(branch || "").split("/").map(encodeURIComponent).join("/");
      }

      function gitBranchUrl(status) {
        const base = normalizeRemoteUrl(status && status.remote_url);
        const branch = status && status.branch;
        if (!base || !branch || branch === "(detached)") return "";
        if (base.includes("bitbucket.org/")) return `${base}/branch/${branchPath(branch)}`;
        return `${base}/tree/${branchPath(branch)}`;
      }

      function gitPullRequestUrl(status) {
        const base = normalizeRemoteUrl(status && status.remote_url);
        const branch = status && status.branch;
        if (!base || !branch || branch === "(detached)") return "";
        if (base.includes("github.com/")) return `${base}/pull/new/${branchPath(branch)}`;
        if (base.includes("bitbucket.org/")) return `${base}/pull-requests/new?source=${encodeURIComponent(branch)}`;
        return "";
      }

      function renderGitToast() {
        const toast = state.gitToast;
        if (!toast) return "";
        const branch = toast.branch ? `<span class="git-ui-toast-branch">${esc(toast.branch)}</span>` : "";
        const branchButton = toast.branchUrl ? `<button class="git-ui-btn" onclick="HerdrGitUi.openGitUrl('${arg(toast.branchUrl)}')">Open branch</button>` : "";
        const prButton = toast.prUrl ? `<button class="git-ui-btn primary" onclick="HerdrGitUi.openGitUrl('${arg(toast.prUrl)}')">Open PR</button>` : "";
        return `<div class="git-ui-toast" role="status"><span>${esc(toast.message || "Done")}</span>${branch}<span class="git-ui-toast-actions">${branchButton}${prButton}<button class="git-ui-btn" onclick="HerdrGitUi.closeGitToast()">Dismiss</button></span></div>`;
      }

      function showCommitToast(message) {
        const view = active() || {};
        const status = view.status || {};
        const id = Date.now();
        state.gitToast = {
          id,
          message,
          branch: status.branch || "",
          branchUrl: gitBranchUrl(status),
          prUrl: gitPullRequestUrl(status),
        };
        render();
        setTimeout(() => {
          if (state.gitToast && state.gitToast.id === id) {
            state.gitToast = null;
            if (state.visible) render();
          }
        }, 10000);
      }

      async function copyGitPermalink(path) {
        const view = active();
        if (!view) return;
        const data = await api(`/api/git-ui/permalink?cwd=${encodeURIComponent(view.cwd)}&path=${encodeURIComponent(path)}`);
        const url = data && data.url;
        if (!url) throw new Error("permalink URL was empty");
        await navigator.clipboard.writeText(url);
        const id = Date.now();
        state.gitToast = { id, message: "Permalink copied" };
        render();
        setTimeout(() => {
          if (state.gitToast && state.gitToast.id === id) {
            state.gitToast = null;
            if (state.visible) render();
          }
        }, 3500);
      }

      async function copyCommitId(hash) {
        const value = String(hash || "").trim();
        if (!value) return;
        await navigator.clipboard.writeText(value);
        const id = Date.now();
        state.gitToast = { id, message: "Commit id copied" };
        render();
        setTimeout(() => {
          if (state.gitToast && state.gitToast.id === id) {
            state.gitToast = null;
            if (state.visible) render();
          }
        }, 3500);
      }

      function renderScopeCopyToast() {
        const toast = state.scopeCopyToast;
        if (!toast) return "";
        return `<div class="git-ui-scope-copy-toast" role="status" style="left:${Math.max(8, toast.x)}px;top:${Math.max(8, toast.y)}px">${esc(toast.message)}</div>`;
      }

      async function copyScopeValue(event, value, kind) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        const text = decodeURIComponent(String(value || ""));
        if (!text) return;
        await navigator.clipboard.writeText(text);
        const id = Date.now();
        state.scopeCopyToast = { id, x: Number(event && event.clientX) || 16, y: Number(event && event.clientY) || 16, message: `${kind} copied` };
        const panel = ensurePanel();
        const existing = panel.querySelector(".git-ui-scope-copy-toast");
        if (existing) existing.remove();
        panel.insertAdjacentHTML("beforeend", renderScopeCopyToast());
        setTimeout(() => {
          if (state.scopeCopyToast && state.scopeCopyToast.id === id) {
            state.scopeCopyToast = null;
            const current = panel.querySelector(".git-ui-scope-copy-toast");
            if (current) current.remove();
          }
        }, 1800);
      }

    return {
      normalizeRemoteUrl,
      branchPath,
      gitBranchUrl,
      gitPullRequestUrl,
      renderGitToast,
      showCommitToast,
      copyGitPermalink,
      copyCommitId,
      renderScopeCopyToast,
      copyScopeValue,
    };
  }

  globalThis.HerdrGitUiToastsModule = { create: createGitUiToasts };
})();
